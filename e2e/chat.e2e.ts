import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_DATABASE_PATH, E2E_PEPPER } from "../playwright.config";
import { openDrawer } from "./support/chat";
import { clearLoginWindow } from "./support/login-window";

/**
 * The student flow, first cut (plan 1.8, PRD §22).
 *
 * "A student logging in, chatting… and logging out" — asserted at the API level
 * as well as in the UI, per §22.
 */

const run = promisify(execFile);

/** Mint a student through the real provisioning path; codes are never recoverable after (§7). */
/**
 * This suite's own classroom.
 *
 * Files run in parallel, and the classroom suite reconfigures the room it uses —
 * locking it, emptying its schedule, taking its models away. Sharing one room
 * between the two makes this file fail whenever the workers interleave, which is
 * what CI's two workers do (§22).
 */
const CLASSROOM = "E2E chat";

async function provisionStudent(): Promise<{ label: string; code: string }> {
  const { stdout } = await run("bun", ["run", "e2e/support/seed-student.ts"], {
    env: {
      ...process.env,
      SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
      SETUN_STUDENT_CODE_PEPPER: E2E_PEPPER,
      SETUN_E2E_CLASSROOM: CLASSROOM,
    },
  });

  return JSON.parse(stdout.trim());
}

/**
 * Appendix A caps one IP at 30 login attempts per 15 minutes, and every worker
 * here is loopback. Cleared per test so the suites do not fail each other's
 * sign-ins; the limiter itself is asserted in `bun test` (§7, §22).
 */
test.beforeEach(clearLoginWindow);

test("a student logs in, chats with a streaming answer, and logs out", async ({ page }) => {
  const { code } = await provisionStudent();

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();

  await expect(page).toHaveURL(/\/chat/);

  // A fresh account has no conversation yet, and does not need one: the empty
  // state says to write a message below, and the composer is there to write it
  // in. The conversation is minted on the first send (§10).
  await expect(page.getByText(m.chat_empty_body())).toBeVisible();
  await expect(page.getByRole("textbox", { name: m.chat_composer_label() })).toBeVisible();

  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill("Forklar loops");
  await page.getByRole("button", { name: m.chat_send() }).click();

  // The prompt appears immediately; the answer streams in from the gateway.
  await expect(page.getByText("Forklar loops")).toBeVisible();

  // Scoped to the assistant's message: the generated conversation title carries
  // the same words in the header, and an unscoped match would find both (§10).
  const answer = page.locator('[data-role="assistant"]').getByText(/Et loop gentager/);
  await expect(answer).toBeVisible({ timeout: 15_000 });

  // The answer survives a reload, so it was persisted rather than only rendered.
  await page.reload();
  await expect(page.locator('[data-role="assistant"]').getByText(/Et loop gentager/)).toBeVisible();

  // Sign out lives in the drawer with the rest of the navigation: the header is
  // one compact strip on a 640-pixel screen and holds only the primary controls.
  await openDrawer(page);
  await page.getByRole("button", { name: m.chat_sign_out() }).click();
  await expect(page).toHaveURL(/\/login/);

  // The session is gone server-side, not merely navigated away from (§7, §21).
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login/);
});

test("the chat header fits a narrow phone viewport", async ({ page }) => {
  const { code } = await provisionStudent();
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);

  await openDrawer(page);
  await expect(page.getByRole("button", { name: m.chat_sign_out() })).toBeVisible();
  await page.keyboard.press("Escape");

  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});

/**
 * The three pupil controls that had no route to them at all (§10, §16, §22).
 *
 * Regenerating and deleting are both destructive-adjacent — one branches the
 * tree, the other removes a conversation and everything it carried — so they are
 * asserted through the UI rather than at the API, which is where the missing
 * piece was.
 */
test("a pupil can ask again, and delete a conversation for good", async ({ page }) => {
  const { code } = await provisionStudent();

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);

  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill("Forklar loops");
  await page.getByRole("button", { name: m.chat_send() }).click();
  await expect(page.locator('[data-role="assistant"]').getByText(/Et loop gentager/)).toBeVisible({
    timeout: 15_000,
  });

  // --- Ask again: the prompt branches rather than the answer being replaced ---
  await page
    .locator('[data-role="assistant"]')
    .first()
    .getByRole("button", { name: m.chat_regenerate() })
    .click({ force: true });

  // Two variants of the same question, reachable from the branch picker (§10).
  await expect(page.getByRole("button", { name: m.chat_branch_previous() })).toBeVisible({
    timeout: 15_000,
  });

  // --- Delete: the conversation and everything it carried go (§16) ---
  await openDrawer(page);

  const row = page.locator("nav a[href^='/chat?c=']").first();
  await expect(row).toBeVisible();

  await page.getByRole("button", { name: /^Slet|^Delete/ }).first().click();
  await page.getByRole("button", { name: m.chat_delete_conversation_confirm() }).click();

  // Nothing left to open into, and nothing left to find on a reload.
  await expect(page.locator("nav a[href^='/chat?c=']")).toHaveCount(0);
  // The confirm button left with the drawer, and the keyboard is back on the
  // control that opened it rather than dropped onto <body> (SvelteKit 3's
  // `reset: false` leaves focus to the page).
  await expect(page.getByRole("button", { name: m.chat_conversations() })).toBeFocused();
  await expect(page).toHaveURL(/\/chat$/);
  await page.reload();
  await expect(page.getByText(m.chat_empty_body())).toBeVisible();
});

test("a wrong code is refused with the same message as an unknown one", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel(m.login_code_label()).fill("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX");
  await page.getByRole("button", { name: m.login_submit() }).click();

  await expect(page.getByText(m.login_failed())).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("the API refuses an unauthenticated caller", async ({ request }) => {
  // Enforcement is server-side on every path that can reach a model (§8, §21).
  const send = await request.post("/api/messages", {
    data: { conversationId: crypto.randomUUID(), text: "hej" },
  });
  expect(send.status()).toBe(401);

  const list = await request.get("/api/conversations");
  expect(list.status()).toBe(401);
});

test("a student cannot reach another student's conversation", async ({ browser }) => {
  const [first, second] = await Promise.all([provisionStudent(), provisionStudent()]);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto("/login");
  await ownerPage.getByLabel(m.login_code_label()).fill(first.code);
  await ownerPage.getByRole("button", { name: m.login_submit() }).click();
  await expect(ownerPage).toHaveURL(/\/chat/);

  const created = await ownerPage.request.post("/api/conversations", { data: {} });
  expect(created.status()).toBe(201);
  const { id: conversationId } = await created.json();

  const intruderContext = await browser.newContext();
  const intruderPage = await intruderContext.newPage();
  await intruderPage.goto("/login");
  await intruderPage.getByLabel(m.login_code_label()).fill(second.code);
  await intruderPage.getByRole("button", { name: m.login_submit() }).click();
  await expect(intruderPage).toHaveURL(/\/chat/);

  // Another student's conversation is absent, not forbidden — nothing to probe (§21).
  const stolen = await intruderPage.request.post("/api/messages", {
    data: { conversationId, text: "hej" },
  });
  expect(stolen.status()).toBe(404);

  const deleted = await intruderPage.request.delete(`/api/conversations/${conversationId}`);
  expect(deleted.status()).toBe(404);

  await ownerContext.close();
  await intruderContext.close();
});

test("the session cookie is HttpOnly, SameSite=Lax and host-scoped", async ({ context, page }) => {
  const { code } = await provisionStudent();

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);

  const cookie = (await context.cookies()).find((c) => c.name === "setun_session");

  expect(cookie).toBeDefined();
  // Unreadable from script, and therefore from the sandbox origin (§7, §14, §21).
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  // Host-only: no Domain attribute widening it to sibling hosts.
  expect(cookie?.domain).toBe("localhost");

  const readable = await page.evaluate(() => document.cookie);
  expect(readable).not.toContain("setun_session");
});
