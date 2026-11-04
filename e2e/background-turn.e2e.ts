import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_DATABASE_PATH, E2E_PEPPER } from "../playwright.config";
import { openDrawer, startConversation } from "./support/chat";
import { clearLoginWindow } from "./support/login-window";
import { ARTIFACT_REPLY, ARTIFACT_MARKER, SLOW_MARKER } from "./support/stub-gateway";

/**
 * A long answer keeps going while the pupil opens another conversation (PRD §10).
 *
 * Reported from a classroom: "New conversation" during a long answer seemed to
 * do nothing. The URL moved, but the running answer was drawn into the new,
 * empty conversation and held its composer — so the pupil was looking at the
 * same answer and could not start anything. One turn is in flight per pupil,
 * and it belongs to the conversation it answers.
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

  // The composer is free to type in; a second answer waits for the first, and
  // the draft is kept rather than lost.
  await composer.fill("Et nyt spørgsmål");
  await page.getByRole("button", { name: m.chat_send() }).click();
  await expect(page.getByText(m.chat_turn_in_flight())).toBeVisible();
  await expect(composer).toHaveValue("Et nyt spørgsmål");

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
  await expect(
    page.locator('article[data-role="assistant"]').getByText(ARTIFACT_REPLY.split("\n").at(-1) ?? ""),
  ).toHaveCount(1);
});
