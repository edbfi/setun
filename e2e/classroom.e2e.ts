import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { LONG_MARKER, SLOW_MARKER } from "./support/stub-gateway";
import {
  APP_ORIGIN,
  E2E_DATABASE_PATH,
  E2E_EDUCATOR_PASSWORD,
  E2E_EDUCATOR_USERNAME,
  E2E_PEPPER,
} from "../playwright.config";
import { clearLoginWindow } from "./support/login-window";

/**
 * The classroom control plane, end to end (plan Phase 2, PRD §7, §8, §9, §22).
 *
 * §22 asks for "a scheduling flow verifying that requests are refused when
 * closed, succeed when opened, and are refused again after locking — all
 * asserted at the API level, not only in the UI", plus the educator flow and the
 * security cases for out-of-hours access and disabled models.
 *
 * Every refusal below is asserted against `/api/messages` directly rather than
 * against a hidden button, because "hiding a control in the UI is never treated
 * as access control" (§8) and a test that only clicked would not know the
 * difference.
 *
 * These tests reconfigure one classroom of their own, so they run in file order
 * within one worker rather than concurrently.
 */

/**
 * Appendix A caps one IP at 30 login attempts per 15 minutes, and every worker
 * here is loopback. Cleared per test so the suites do not fail each other's
 * sign-ins; the limiter itself is asserted in `bun test` (§7, §22).
 */
test.beforeEach(clearLoginWindow);

test.describe.configure({ mode: "serial" });

const run = promisify(execFile);

/**
 * This suite's own classroom.
 *
 * These tests lock, reschedule and empty the allowlist of the room they use, so
 * it has to be a room no other suite is chatting in — files run in parallel, and
 * the failure only appears at whatever worker count CI happens to choose (§22).
 */
const CLASSROOM = "E2E classroom";

const env = {
  ...process.env,
  SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
  SETUN_STUDENT_CODE_PEPPER: E2E_PEPPER,
  SETUN_E2E_CLASSROOM: CLASSROOM,
};

async function provisionStudent(): Promise<{ label: string; code: string }> {
  const { stdout } = await run("bun", ["run", "e2e/support/seed-student.ts"], { env });
  return JSON.parse(stdout.trim());
}

/** Reconfigure the classroom the running server is serving. */
async function control(command: string, argument?: string): Promise<void> {
  const args = ["run", "e2e/support/classroom-control.ts", command];
  if (argument) args.push(argument);
  await run("bun", args, { env });
}

async function signIn(page: Page, code: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);
}

async function signInAsEducator(page: Page): Promise<void> {
  await page.goto("/educator/login");
  await page.getByLabel(m.educator_username_label()).fill(E2E_EDUCATOR_USERNAME);
  await page.getByLabel(m.educator_password_label()).fill(E2E_EDUCATOR_PASSWORD);
  await page.getByRole("button", { name: m.educator_login_submit() }).click();
  await expect(page).toHaveURL(/\/educator$/);
}

/** A conversation the enforcement tests can aim `/api/messages` at. */
async function conversationFor(page: Page): Promise<string> {
  const created = await page.request.post("/api/conversations", {
    data: {},
    headers: { origin: APP_ORIGIN },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).id;
}

test.afterEach(async () => {
  // Leave the classroom usable for whatever runs next.
  await control("allow-models");
  await control("restore-allowance");
  await control("open");
});

test("the scheduling flow: refused when closed, allowed when open, refused after locking (§22)", async ({
  page,
}) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const conversationId = await conversationFor(page);

  // --- Closed: a schedule with no lesson in it ---
  await control("closed-schedule");

  const whileClosed = await page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "hej" },
  });
  expect(whileClosed.status()).toBe(403);
  expect((await whileClosed.json()).error).toBe("outside-schedule");

  // --- Open: the educator's Open now ---
  await control("open");

  const whileOpen = await page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "Forklar loops" },
  });
  expect(whileOpen.status()).toBe(200);
  // Drain the stream so the turn finishes and does not block the next send.
  await whileOpen.body();

  // --- Locked: refused again, immediately ---
  await control("lock");

  const whileLocked = await page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "og igen" },
  });
  expect(whileLocked.status()).toBe(403);
  expect((await whileLocked.json()).error).toBe("classroom-locked");
});

test("a response already streaming may finish after a lock; new requests may not (§8, §22)", async ({
  page,
}) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const first = await conversationFor(page);
  const second = await conversationFor(page);

  // A slow answer, so there is genuinely a turn in flight to lock around.
  const streaming = page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId: first, text: `Forklar loops ${SLOW_MARKER}` },
    timeout: 60_000,
  });

  // Let the turn start before the lock lands.
  await page.waitForTimeout(500);
  await control("lock");

  // A new request is refused at once, while the first is still streaming (§8).
  const rejected = await page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId: second, text: "og en til" },
  });
  expect(rejected.status()).toBe(403);
  expect((await rejected.json()).error).toBe("classroom-locked");

  // And the in-flight response completed rather than being cut off.
  const response = await streaming;
  expect(response.status()).toBe(200);

  const body = await response.text();
  expect(body).toContain("Et");
  expect(body).toContain('"type":"done"');
  // Ended because the model stopped, not because the classroom locked.
  expect(body).toContain('"reason":"stop"');
});

test("a scheduled lesson opens and closes access at the right local times (§8, §22)", async ({
  page,
}) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const conversationId = await conversationFor(page);

  // A lesson covering right now, in the classroom's own timezone. The instant
  // is computed the way the schedule resolver does — from the local wall clock.
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = weekdayNames.indexOf(local.find((part) => part.type === "weekday")?.value ?? "");
  const hour = Number(local.find((part) => part.type === "hour")?.value);
  const minute = Number(local.find((part) => part.type === "minute")?.value);
  const nowMinute = hour * 60 + minute;

  // A window that certainly contains this minute, clamped inside the day.
  const start = Math.max(0, nowMinute - 30);
  const end = Math.min(24 * 60, nowMinute + 30);

  await control("schedule", `${weekday}:${start}:${end}`);

  const inLesson = await page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "i timen" },
  });
  expect(inLesson.status()).toBe(200);
  await inLesson.body();

  // Move the same lesson to yesterday: no window covers now any more.
  const yesterday = (weekday + 6) % 7;
  await control("schedule", `${yesterday}:${start}:${end}`);

  const outOfHours = await page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "uden for timen" },
  });
  expect(outOfHours.status()).toBe(403);
  expect((await outOfHours.json()).error).toBe("outside-schedule");
});

test("a model the classroom may not use is refused at the API (§9, §22)", async ({ page }) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const conversationId = await conversationFor(page);

  // The educator takes every model off this classroom's allowlist.
  await control("disallow-models");

  const refused = await page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "hej" },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toBe("model-not-allowed");

  // A conversation cannot be started on one either — an absent row is a denial.
  const created = await page.request.post("/api/conversations", {
    data: {},
    headers: { origin: APP_ORIGIN },
  });
  expect(created.status()).toBe(409);
});

test("an exhausted allowance refuses new turns with a friendly message (§10, §22)", async ({
  page,
}) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const conversationId = await conversationFor(page);

  // Spend the day: one real turn, then an allowance smaller than it cost.
  const first = await page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "Forklar loops" },
  });
  expect(first.status()).toBe(200);
  await first.body();

  await control("exhaust-allowance");

  // The turn runs detached from the request that started it, so its usage row
  // lands a moment after the stream closes (§10).
  await expect
    .poll(
      async () => {
        const attempt = await page.request.post("/api/messages", {
          headers: { origin: APP_ORIGIN },
          data: { conversationId, text: "en gang til" },
        });
        if (attempt.status() !== 403) {
          await attempt.body();
          return attempt.status();
        }
        return (await attempt.json()).error;
      },
      { timeout: 15_000 },
    )
    .toBe("student-allowance-exhausted");

  // And the pupil is told in their own words, not shown a status code (§10).
  await page.goto(`/chat?c=${conversationId}`);
  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill("en gang til");
  await page.getByRole("button", { name: m.chat_send() }).click();

  await expect(
    page.getByText(m.chat_refusal_student_allowance_exhausted()),
  ).toBeVisible({ timeout: 15_000 });
});

test("a closed classroom shows the status screen with its next opening (§8, §22)", async ({
  page,
}) => {
  const { code } = await provisionStudent();
  await signIn(page, code);

  // A lesson on a day that is not today, so the room is closed with something
  // to promise.
  const tomorrow = (new Date().getUTCDay() + 1) % 7;
  await control("schedule", `${tomorrow}:${9 * 60}:${10 * 60}`);

  await page.goto("/chat");

  await expect(page.getByText(m.classroom_closed_title())).toBeVisible();
  await expect(page.getByText(m.classroom_next_opening_label())).toBeVisible();
  // A friendly status, never a raw authorisation error (§8).
  await expect(page.getByText(/401|403|Unauthorized|Forbidden/)).toHaveCount(0);
  // The composer is gone, but that is a courtesy — the API refusals above are
  // what actually enforces it.
  await expect(page.getByRole("textbox", { name: m.chat_composer_label() })).toHaveCount(0);
});

test("a connected tab sees a lock arrive over the push channel (§6, §8, §22)", async ({
  browser,
}) => {
  const { code } = await provisionStudent();
  await control("open");

  const studentContext = await browser.newContext();
  const studentPage = await studentContext.newPage();
  await signIn(studentPage, code);
  await expect(
    studentPage.getByRole("textbox", { name: m.chat_composer_label() }),
  ).toBeVisible();

  // The educator locks from the panel, in another browser entirely. The pupil's
  // tab is not reloaded and not navigated: the change arrives on the channel.
  const educatorContext = await browser.newContext();
  const educatorPage = await educatorContext.newPage();
  await signInAsEducator(educatorPage);

  // By name, not by position: the panel lists every classroom, and other suites
  // have their own.
  await educatorPage
    .getByRole("navigation")
    .getByRole("link", { name: CLASSROOM, exact: true })
    .click();
  // The dashboard carries a lock per classroom, so wait for the classroom's own
  // page before reaching for its control.
  await expect(educatorPage).toHaveURL(/\/educator\/classrooms\//);
  await educatorPage.getByRole("button", { name: m.educator_lock_classroom() }).click();
  await expect(
    educatorPage.getByText(m.educator_state_locked(), { exact: true }),
  ).toBeVisible();

  // Well inside the channel's poll interval, so this can only have arrived as a
  // push (§6, §8).
  await expect(studentPage.getByText(m.classroom_closed_title())).toBeVisible({ timeout: 10_000 });

  await studentContext.close();
  await educatorContext.close();
});

test("the educator signs in, creates a classroom, opens it and locks it (§22)", async ({ page }) => {
  await signInAsEducator(page);

  const name = `7.B ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel(m.educator_classroom_name_label()).fill(name);
  await page.getByRole("button", { name: m.educator_create_classroom() }).click();

  await expect(page).toHaveURL(/\/educator\/classrooms\//);
  await expect(page.getByRole("heading", { name })).toBeVisible();

  // Exact: "Open" is a substring of "Open now" and of "Europe/Copenhagen".
  await page.getByRole("button", { name: m.educator_open_now() }).click();
  await expect(page.getByText(m.educator_state_open(), { exact: true })).toBeVisible();

  await page.getByRole("button", { name: m.educator_lock_classroom() }).click();
  await expect(page.getByText(m.educator_state_locked(), { exact: true })).toBeVisible();
});

test("a student session cannot reach the educator panel (§21, §22)", async ({ page }) => {
  const { code } = await provisionStudent();
  await signIn(page, code);

  // A live student session, presented at an educator page: sent to the educator
  // login, never served the panel (§21).
  await page.goto("/educator");
  await expect(page).toHaveURL(/\/educator\/login/);
  await expect(page.getByText(m.educator_panel_title())).toHaveCount(0);

  // And at an educator form action. The `origin` header is set so SvelteKit's
  // own CSRF check passes and the *role guard* is what refuses — a 403 from the
  // framework would prove nothing about the guard (§21).
  // SvelteKit serialises an action's redirect into the body for a non-browser
  // POST rather than answering 303, so the assertion is on where it was sent.
  const forged = await page.request.post("/educator?/create", {
    form: { name: "Smuglet klasse", timezone: "Europe/Copenhagen" },
    headers: { origin: APP_ORIGIN },
    maxRedirects: 0,
  });
  expect(await forged.text()).toContain("/educator/login");
});

test("an anonymous caller cannot reach the educator panel or its actions (§21)", async ({
  request,
}) => {
  const panel = await request.get("/educator", { maxRedirects: 0 });
  expect(panel.status()).toBe(303);
  expect(panel.headers().location).toContain("/educator/login");

  const action = await request.post("/educator?/create", {
    form: { name: "Smuglet klasse" },
    headers: { origin: APP_ORIGIN },
    maxRedirects: 0,
  });
  expect(await action.text()).toContain("/educator/login");
});

test("the educator login refuses a wrong password the way it refuses an unknown user (§7, §21)", async ({
  page,
}) => {
  await page.goto("/educator/login");
  await page.getByLabel(m.educator_username_label()).fill(E2E_EDUCATOR_USERNAME);
  await page.getByLabel(m.educator_password_label()).fill("not-the-password");
  await page.getByRole("button", { name: m.educator_login_submit() }).click();

  await expect(page.getByText(m.educator_login_failed())).toBeVisible();

  await page.goto("/educator/login");
  await page.getByLabel(m.educator_username_label()).fill("nobody-by-that-name");
  await page.getByLabel(m.educator_password_label()).fill("not-the-password");
  await page.getByRole("button", { name: m.educator_login_submit() }).click();

  // The same sentence for both: nothing here answers "does this account exist?"
  await expect(page.getByText(m.educator_login_failed())).toBeVisible();
});

/**
 * The allowance warns, then binds, mid-turn (PRD §10, §22).
 *
 * The per-turn caps became checkpoints that ask, so the daily allowance is the
 * only thing that still stops a stream — and it now does so *during* a turn
 * rather than only at its start. Both halves are asserted where the pupil meets
 * them: the banner on screen, and the notice the turn ends with.
 */
test("warns at 70 % of the allowance, and stops when it empties mid-turn", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();
  await control("open");
  await control("low-allowance");

  try {
    await signIn(page, code);

    // A long answer, so the running estimate crosses the warning line and then
    // the ceiling *while the answer is still arriving* — which is the whole of
    // what those two events are for (§10).
    await page
      .getByRole("textbox", { name: m.chat_composer_label() })
      .fill(`Forklar loops ${LONG_MARKER}`);
    await page.getByRole("button", { name: m.chat_send() }).click();

    // Shown while the answer is still arriving: a response in flight is never
    // cut at 70 %, so the pupil gets the figure and a real choice (§10).
    await expect(page.getByText(/% af dagens tildeling er brugt|% of today/)).toBeVisible({
      timeout: 30_000,
    });

    // And the ceiling itself, which is what actually ends the turn.
    await expect(page.getByText(m.chat_notice_student_allowance_exhausted())).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await control("restore-allowance");
  }
});
