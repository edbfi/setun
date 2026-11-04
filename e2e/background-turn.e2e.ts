import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_DATABASE_PATH, E2E_PEPPER } from "../playwright.config";
import { openDrawer, startConversation } from "./support/chat";
import { clearLoginWindow } from "./support/login-window";
import { ARTIFACT_MARKER, ARTIFACT_REPLY, LONG_MARKER, SLOW_MARKER } from "./support/stub-gateway";

/**
 * A long answer keeps going while the pupil opens another conversation (PRD §10).
 *
 * Reported from a classroom: "New conversation" during a long answer seemed to
 * do nothing. The URL moved, but the running answer was drawn into the new,
 * empty conversation and held its composer — so the pupil was looking at the
 * same answer and could not start anything. An answer belongs to the
 * conversation it answers, and a pupil may have as many going at once as the
 * classroom allows — one per conversation.
 */

const run = promisify(execFile);
const CLASSROOM = "E2E background turn";

async function signIn(page: Page): Promise<void> {
  const { stdout } = await run("bun", ["run", "e2e/support/seed-student.ts"], {
    env: {
      ...process.env,
      SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
      SETUN_STUDENT_CODE_PEPPER: E2E_PEPPER,
      SETUN_E2E_CLASSROOM: CLASSROOM,
    },
  });
  const { code } = JSON.parse(stdout.trim());

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);
}

test.beforeEach(clearLoginWindow);

test("a new conversation opens while an answer keeps running in the old one", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await startConversation(page);
  const first = new URL(page.url()).searchParams.get("c");

  const composer = page.getByRole("textbox", { name: m.chat_composer_label() });
  // Slow enough to leave and come back during, short enough to see it finish.
  await composer.fill(`${SLOW_MARKER} ${ARTIFACT_MARKER} lav en klikker`);
  await page.getByRole("button", { name: m.chat_send() }).click();
  const live = page.locator('article[data-role="assistant"][data-streaming="true"]');
  await expect(live).toBeVisible({ timeout: 20_000 });

  // New conversation, mid-answer.
  await openDrawer(page);
  await page
    .locator('form[action="?/create"]')
    .getByRole("button", { name: m.chat_new_conversation() })
    .click();

  // It is a new, empty conversation — not the old answer under a new URL.
  await expect(page).not.toHaveURL(new RegExp(`c=${first}`));
  await expect(live).toHaveCount(0);
  await expect(page.locator(`[data-turn-elsewhere="${first}"]`)).toBeVisible();

  // The composer here is free: nothing is running in this conversation.
  await expect(composer).toBeEditable();

  // And the way back finds the answer still arriving where it belongs —
  // without this tab ever reconnecting to read the same turn a second time.
  const reconnects: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/turns\/[^/]+\/events/.test(request.url())) reconnects.push(request.url());
  });
  await page.getByRole("link", { name: m.chat_turn_elsewhere_open() }).click();
  await expect(page).toHaveURL(new RegExp(`c=${first}`));
  await expect(live).toBeVisible();
  await expect(page.locator("[data-turn-elsewhere]")).toHaveCount(0);

  // Let it finish: the answer lands once, and is not replayed.
  await expect(live).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('[data-turn-stage="done"]')).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(reconnects).toEqual([]);
  const closing = ARTIFACT_REPLY.split("\n").at(-1) ?? "";
  await expect(page.locator('article[data-role="assistant"]').getByText(closing)).toHaveCount(1);
});

/** Start a new conversation from the drawer and wait to be on it. */
async function newConversation(page: Page): Promise<string> {
  const previous = page.url();
  await openDrawer(page);
  await page
    .locator('form[action="?/create"]')
    .getByRole("button", { name: m.chat_new_conversation() })
    .click();
  await expect(page).not.toHaveURL(previous);
  await expect(page).toHaveURL(/c=/);
  return new URL(page.url()).searchParams.get("c") ?? "";
}

test("two answers run at once in two conversations, and a third waits for the limit", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  await startConversation(page);
  const first = new URL(page.url()).searchParams.get("c");

  const composer = page.getByRole("textbox", { name: m.chat_composer_label() });
  const send = page.getByRole("button", { name: m.chat_send() });
  const live = page.locator('article[data-role="assistant"][data-streaming="true"]');

  // A long answer, slow enough to still be running when the test is done with it.
  await composer.fill(`${SLOW_MARKER} ${LONG_MARKER} en lang forklaring`);
  await send.click();
  await expect(live).toBeVisible({ timeout: 20_000 });

  // A second, in a second conversation, while the first goes on.
  const second = await newConversation(page);
  await composer.fill(`${SLOW_MARKER} ${LONG_MARKER} en anden forklaring`);
  await send.click();
  await expect(live).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-turn-elsewhere="${first}"]`)).toBeVisible();

  // A third is past the classroom's default of two: refused, the draft kept.
  await newConversation(page);
  await composer.fill("Et tredje spørgsmål");
  await send.click();
  await expect(page.getByText(m.chat_turn_limit({ count: 2 }))).toBeVisible();
  await expect(composer).toHaveValue("Et tredje spørgsmål");
  await expect(page.locator("[data-turn-elsewhere]")).toHaveCount(2);

  // Each answer is still where it belongs, and Stop stops only that one —
  // without this tab ever reconnecting to read either a second time.
  const reconnects: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/turns\/[^/]+\/events/.test(request.url())) reconnects.push(request.url());
  });

  await page.locator(`[data-turn-elsewhere="${first}"]`).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`c=${first}`));
  await expect(live).toBeVisible();
  await expect(page.locator("[data-turn-elsewhere]")).toHaveCount(1);
  await page.getByRole("button", { name: m.chat_stop() }).click();
  await expect(live).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(`[data-turn-elsewhere="${second}"]`)).toBeVisible();

  await page.locator(`[data-turn-elsewhere="${second}"]`).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`c=${second}`));
  await expect(live).toBeVisible();
  await page.getByRole("button", { name: m.chat_stop() }).click();
  await expect(live).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator("[data-turn-elsewhere]")).toHaveCount(0);
  expect(reconnects).toEqual([]);
});
