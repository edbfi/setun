import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { APP_ORIGIN, E2E_DATABASE_PATH, E2E_PEPPER } from "../playwright.config";
import * as m from "../src/lib/paraglide/messages";
import { clearLoginWindow } from "./support/login-window";
import { openDrawer } from "./support/chat";
import { THINKING_MARKER } from "./support/stub-gateway";

/**
 * The model's thinking, end to end (PRD §20, §21, §22).
 *
 * Two things are under test and only one of them is visible. The block itself —
 * that a pupil can open it and read the summary — and the policy, which is
 * enforced on the server: a classroom set to "never shown" must carry no
 * reasoning in the turn's own event stream, not merely hide a component. So the
 * hidden case is asserted at the API, as §21 requires of every control.
 *
 * The reasoning reaches the application only over `/v1/responses`, so a passing
 * test here is also evidence that the transport is the one in use.
 */

const run = promisify(execFile);

/** This suite reconfigures its own room, so it does not share one with another file. */
const CLASSROOM = "E2E thinking";

const env = {
  ...process.env,
  SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
  SETUN_STUDENT_CODE_PEPPER: E2E_PEPPER,
  SETUN_E2E_CLASSROOM: CLASSROOM,
};

test.describe.configure({ mode: "serial" });
test.beforeEach(clearLoginWindow);

async function provisionStudent(): Promise<{ label: string; code: string }> {
  const { stdout } = await run("bun", ["run", "e2e/support/seed-student.ts"], { env });
  return JSON.parse(stdout.trim());
}

async function control(command: string): Promise<void> {
  await run("bun", ["run", "e2e/support/classroom-control.ts", command], { env });
}

async function signIn(page: Page, code: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);
}

/** Send one prompt and wait for the answer to settle. */
async function ask(page: Page): Promise<void> {
  await page
    .getByRole("textbox", { name: m.chat_composer_label() })
    .fill(`Forklar loops ${THINKING_MARKER}`);
  await page.getByRole("button", { name: m.chat_send() }).click();
  await expect(page.locator('[data-role="assistant"]').getByText(/Et loop/)).toBeVisible({
    timeout: 30_000,
  });
  // Visible text can arrive before the turn finishes. A second conversation
  // still shares this pupil's one-turn-in-flight guard.
  await expect(page.getByRole("button", { name: m.chat_send(), exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Send one prompt through the API and replay the turn's buffered events (§10).
 *
 * Where the policy is actually enforced: a resuming reader sees exactly these,
 * so an event absent here is absent from every route a browser could take.
 */
async function bufferedEvents(page: Page): Promise<string> {
  const created = await page.request.post("/api/conversations", {
    data: {},
    headers: { origin: APP_ORIGIN },
  });
  expect(created.status()).toBe(201);
  const conversationId = (await created.json()).id;

  const sent = await page.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: `Forklar loops ${THINKING_MARKER}` },
    timeout: 60_000,
  });
  expect(sent.status()).toBe(200);

  const turnId = sent.headers()["x-setun-turn-id"];
  expect(turnId ?? "").not.toBe("");
  // Draining the stream is what waits for the turn to finish.
  await sent.body();

  const events = await page.request.get(`/api/turns/${turnId}/events?after=-1`);
  expect(events.status()).toBe(200);
  return events.text();
}

test("a pupil can open the model's thinking, and it survives a reload", async ({ page }) => {
  test.setTimeout(120_000);
  // Seeding is what creates the room, so it comes before reconfiguring it.
  const { code } = await provisionStudent();
  await control("student-thinking");
  await signIn(page, code);
  await ask(page);

  // Collapsed by default: the answer is what the pupil asked for (§20).
  const block = page.getByText(m.chat_thoughts(), { exact: false }).first();
  await expect(block).toBeVisible();
  // In the document but not on screen: a closed `<details>` keeps its body.
  await expect(page.getByText(/Jeg overvejer opgaven/)).not.toBeVisible();

  await block.click();
  await expect(page.getByText(/Jeg overvejer opgaven/)).toBeVisible();

  // And after a reload, back to collapsed, because the part is persisted (§13).
  await page.reload();
  await expect(page.getByText(m.chat_thoughts(), { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/Jeg overvejer opgaven/)).not.toBeVisible();
});

/**
 * Hiding a component is not enforcement (§21). A classroom set to "never shown"
 * must leave nothing in the turn's own event stream for a devtools panel to find.
 */
test("a classroom that hides thinking sends none of it to the browser", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();
  await control("hide-thinking");

  try {
    await signIn(page, code);
    await ask(page);

    await expect(page.getByText(m.chat_thoughts(), { exact: false })).toHaveCount(0);

    // Asserted where it is actually enforced: the buffered events a resume reads.
    const buffered = await bufferedEvents(page);
    expect(buffered).not.toContain("thinking-delta");
    expect(buffered).not.toContain("Jeg overvejer");
  } finally {
    await control("student-thinking");
  }
});

test("a classroom that always shows thinking offers the pupil no switch", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();
  await control("show-thinking");

  try {
    await signIn(page, code);
    await ask(page);

    await expect(page.getByText(m.chat_thoughts(), { exact: false }).first()).toBeVisible();

    // The switch decides nothing here, so it is not offered at all (§20).
    await openDrawer(page);
    await expect(
      page.getByRole("switch", { name: m.chat_thinking_toggle_label() }),
    ).toHaveCount(0);
  } finally {
    await control("student-thinking");
  }
});

test("the pupil's own switch turns the block off in this browser", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();
  await control("student-thinking");

  await signIn(page, code);
  await ask(page);

  await expect(page.getByText(m.chat_thoughts(), { exact: false }).first()).toBeVisible();

  await openDrawer(page);
  await page.getByRole("switch", { name: m.chat_thinking_toggle_label() }).click();

  // A device setting: nothing about it reaches the server (§16).
  await expect(page.getByText(m.chat_thoughts(), { exact: false })).toHaveCount(0);
});
