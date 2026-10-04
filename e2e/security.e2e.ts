import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Browser, expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import {
  APP_ORIGIN,
  E2E_DATABASE_PATH,
  E2E_EDUCATOR_PASSWORD,
  E2E_EDUCATOR_USERNAME,
  E2E_PEPPER,
} from "../playwright.config";
import { clearLoginWindow } from "./support/login-window";

/**
 * The §22 security cases not already covered by the flow suites
 * (plan 5.8, PRD §7, §16, §21, §22).
 *
 * §22 asks for "security coverage for authentication failures and brute force,
 * revoked credentials, disabled accounts, sessions after rotation and
 * force-logout, out-of-hours API access, cross-student access including search,
 * disabled models, tools, and skills, cross-student attachment access,
 * attachment type and size enforcement, and the full artifact escape suite".
 *
 * Out-of-hours access, disabled models and the exhausted allowance live in
 * `classroom.e2e.ts`; attachments and tools in `tools.e2e.ts`; the escape suite
 * in `artifact-escape.e2e.ts`. What is here is the rest: brute force, revoked
 * and disabled credentials, sessions after rotation and force-logout, and
 * cross-student search.
 *
 * Every claim is settled against the API or the real login endpoint rather than
 * against a hidden control, because "hiding a control in the UI is never treated
 * as access control" (§8).
 */

const run = promisify(execFile);

/** This suite's own classroom: it force-logs-out and disables the pupils in it. */
const CLASSROOM = "E2E security";

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

async function control(command: string, argument?: string): Promise<void> {
  const args = ["run", "e2e/support/classroom-control.ts", command];
  if (argument) args.push(argument);
  await run("bun", args, { env });
}

async function signInStudent(browser: Browser, code: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);

  return page;
}

/**
 * Appendix A caps one IP at 30 login attempts per 15 minutes, and every worker
 * here is loopback. Cleared per test so the suites do not fail each other's
 * sign-ins; the limiter itself is asserted in `bun test` (§7, §22).
 */
test.beforeEach(clearLoginWindow);

test("a rotated credential kills the old code and the session it created (§7, §21, §22)", async ({
  browser,
}) => {
  const { label, code } = await provisionStudent();
  const page = await signInStudent(browser, code);

  // Live before rotation.
  expect((await page.request.get("/api/conversations")).status()).toBe(200);

  // Rotate through the real provisioning module, exactly as the panel does —
  // but from outside, so the pupil's browser is holding the old cookie while it
  // happens. That is the state §21 is about.
  const { stdout } = await run("bun", ["run", "e2e/support/rotate-student.ts", label], { env });
  const { code: rotated } = JSON.parse(stdout.trim());

  // The old cookie stops working on the next request, not at expiry (§7, §21).
  expect((await page.request.get("/api/conversations")).status()).toBe(401);

  // And the old code is no longer a credential, while the new one is.
  const revived = await browser.newContext();
  const revivedPage = await revived.newPage();
  await revivedPage.goto("/login");
  await revivedPage.getByLabel(m.login_code_label()).fill(code);
  await revivedPage.getByRole("button", { name: m.login_submit() }).click();
  await expect(revivedPage.getByText(m.login_failed())).toBeVisible();

  await revivedPage.getByLabel(m.login_code_label()).fill(rotated);
  await revivedPage.getByRole("button", { name: m.login_submit() }).click();
  await expect(revivedPage).toHaveURL(/\/chat/);

  await revived.close();
  await page.context().close();
});

test("force-logout ends every live session in the classroom at once (§7, §21, §22)", async ({
  browser,
  page: educatorPage,
}) => {
  const { code } = await provisionStudent();
  const student = await signInStudent(browser, code);

  expect((await student.request.get("/api/conversations")).status()).toBe(200);

  await educatorPage.goto("/educator/login");
  await educatorPage.getByLabel(m.educator_username_label()).fill(E2E_EDUCATOR_USERNAME);
  await educatorPage.getByLabel(m.educator_password_label()).fill(E2E_EDUCATOR_PASSWORD);
  await educatorPage.getByRole("button", { name: m.educator_login_submit() }).click();

  await educatorPage
    .getByRole("navigation")
    .getByRole("link", { name: CLASSROOM, exact: true })
    .click();
  await educatorPage.getByRole("link", { name: m.educator_nav_settings() }).click();
  await educatorPage.getByRole("button", { name: m.educator_force_logout() }).click();

  // Immediate, not at expiry (§21).
  await expect
    .poll(async () => (await student.request.get("/api/conversations")).status())
    .toBe(401);

  await student.context().close();
});

test("a disabled account cannot sign in and its live session dies (§7, §21, §22)", async ({
  browser,
}) => {
  const { label, code } = await provisionStudent();
  const student = await signInStudent(browser, code);

  expect((await student.request.get("/api/conversations")).status()).toBe(200);

  await control("disable-student", label);

  expect((await student.request.get("/api/conversations")).status()).toBe(401);

  const retry = await browser.newContext();
  const retryPage = await retry.newPage();
  await retryPage.goto("/login");
  await retryPage.getByLabel(m.login_code_label()).fill(code);
  await retryPage.getByRole("button", { name: m.login_submit() }).click();
  await expect(retryPage.getByText(m.login_failed())).toBeVisible();

  await retry.close();
  await student.context().close();
});

test("a student's search never reaches another student's conversations (§21, §22)", async ({
  browser,
}) => {
  await control("open");
  const [first, second] = await Promise.all([provisionStudent(), provisionStudent()]);

  const owner = await signInStudent(browser, first.code);

  // A conversation with a distinctive word in it, sent through the real path.
  const created = await owner.request.post("/api/conversations", {
    data: {},
    headers: { origin: APP_ORIGIN },
  });
  const { id: conversationId } = await created.json();
  const sent = await owner.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "hemmeligt om vulkanudbrud" },
  });
  expect(sent.status()).toBe(200);
  // Drain the stream so the message is persisted before the search below.
  await sent.body();

  await expect
    .poll(async () => {
      const own = await owner.request.get("/api/search?q=vulkanudbrud");
      return ((await own.json()) as { hits: unknown[] }).hits.length;
    })
    .toBeGreaterThan(0);

  const intruder = await signInStudent(browser, second.code);
  const stolen = await intruder.request.get("/api/search?q=vulkanudbrud");
  expect(stolen.status()).toBe(200);
  expect(((await stolen.json()) as { hits: unknown[] }).hits).toEqual([]);

  await owner.context().close();
  await intruder.context().close();
});

test("the search endpoint refuses an unauthenticated caller (§21)", async ({ request }) => {
  expect((await request.get("/api/search?q=noget")).status()).toBe(401);
});

test("repeated wrong codes say the same thing every time (§7, §21, §22)", async ({ page }) => {
  const { code } = await provisionStudent();

  await page.goto("/login");

  // A wrong code, an unknown code, a malformed one and a real code with a
  // character changed: four different reasons, one message. The progressive
  // delay and the per-IP ceiling behind them are exercised in `bun test`, where
  // the clock can be moved; what an end-to-end run can prove is that nothing on
  // screen distinguishes the four (§7, Appendix A).
  const attempts = [
    "0000-0000-0000-0000-0000-0000",
    "not-a-code",
    "",
    `${code.slice(0, -1)}${code.endsWith("Z") ? "Y" : "Z"}`,
  ];

  for (const attempt of attempts) {
    await page.getByLabel(m.login_code_label()).fill(attempt);
    await page.getByRole("button", { name: m.login_submit() }).click();

    await expect(page.getByText(m.login_failed())).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  }

  // Nothing accumulated on screen: no counter, no lockout notice, nothing an
  // attacker could calibrate against (§7).
  await expect(page.getByText(m.login_failed())).toHaveCount(1);
});

test("a write from any other origin is refused, whatever its content type (§21)", async ({
  browser,
}) => {
  const { code } = await provisionStudent();
  await control("open");
  const pupil = await signInStudent(browser, code);
  const count = async () =>
    ((await (await pupil.request.get("/api/conversations")).json()) as { conversations: unknown[] })
      .conversations.length;

  // SvelteKit checks the origin of form posts and bodyless writes only; a JSON write with the
  // pupil's cookie used to reach the endpoint from anywhere. Now the app refuses it first.
  const before = await count();
  for (const origin of ["http://attacker.test", "null", undefined]) {
    const created = await pupil.request.post("/api/conversations", {
      data: {},
      headers: origin === undefined ? {} : { origin },
    });
    expect(created.status(), `Origin ${origin ?? "(none)"}`).toBe(403);
    expect((await created.json()).error).toBe("cross-origin-write");
  }
  expect(await count()).toBe(before);

  const created = await pupil.request.post("/api/conversations", {
    data: {},
    headers: { origin: APP_ORIGIN },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();

  // A DELETE with a JSON content type is not one SvelteKit checks either.
  const deleted = await pupil.request.delete(`/api/conversations/${id}`, {
    data: {},
    headers: { origin: "http://attacker.test" },
  });
  expect(deleted.status()).toBe(403);
  expect((await deleted.json()).error).toBe("cross-origin-write");
  expect(await count()).toBe(before + 1);

  await pupil.context().close();
});
