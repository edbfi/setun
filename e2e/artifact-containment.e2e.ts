import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_DATABASE_PATH, E2E_PEPPER } from "../playwright.config";
import { startConversation } from "./support/chat";
import { clearLoginWindow } from "./support/login-window";
import {
  ARTIFACT_PROJECT_MARKER,
  ARTIFACT_PROJECT_REVISION_MARKER,
  SLOW_MARKER,
} from "./support/stub-gateway";

/**
 * Code the model writes stays inside its artifact (PRD §13, §20).
 *
 * Reported from a classroom: while the model revised an artifact, the code broke
 * out of its card and streamed into the conversation as prose. A revision is the
 * case that does it, because a revision re-emits only the files that changed —
 * here a stylesheet — and a `css` fence is an artifact file only by virtue of
 * its `id=` and `path=`. Revising it again with the same content is the second
 * case: an identical write records no new version, so the settled message has a
 * block with no revision behind it.
 *
 * Watched with a MutationObserver rather than sampled, so a leak that lasts one
 * frame of the stream is still caught.
 */

const run = promisify(execFile);
const CLASSROOM = "E2E containment";

/** A line of the stylesheet the stub writes; it must never be transcript text. */
const LEAK = "#hilsen {";

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

async function signIn(page: Page, code: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);
}

/** Record, from now on, whether any assistant message ever shows `needle`. */
async function watchForLeak(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const state = window as unknown as { __leaked?: string | null };
    state.__leaked = null;
    const check = () => {
      for (const article of document.querySelectorAll('article[data-role="assistant"]')) {
        // `innerText` is what is rendered: the source a collapsed `<details>`
        // holds is in the DOM but not on screen, and that is containment.
        if ((article as HTMLElement).innerText.includes(text)) {
          state.__leaked ??= (article as HTMLElement).innerText;
        }
      }
    };
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, needle);
}

async function leaked(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { __leaked?: string | null }).__leaked ?? null);
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill(text);
  await page.getByRole("button", { name: m.chat_send() }).click();
}

test.beforeEach(clearLoginWindow);

test("repeated revisions of one artifact never leak its code into the chat", async ({ page }) => {
  test.setTimeout(180_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await startConversation(page);

  await send(page, `${ARTIFACT_PROJECT_MARKER} lav et projekt`);
  await expect(page.locator("[data-build-count]")).toHaveAttribute("data-build-count", "1", {
    timeout: 20_000,
  });

  await watchForLeak(page, LEAK);

  // Three revisions of the same id, streamed slowly enough to watch: the first
  // changes the stylesheet, the next two restate it unchanged.
  for (let revision = 1; revision <= 3; revision++) {
    await send(page, `${ARTIFACT_PROJECT_REVISION_MARKER} ${SLOW_MARKER} skift farven`);

    const live = page.locator('article[data-role="assistant"][data-streaming="true"]');
    await expect(live).toBeVisible({ timeout: 20_000 });
    await expect(live).toHaveCount(0, { timeout: 60_000 });

    // Settled: the message is back from the server, with the turn's prose.
    await expect(
      page.locator('article[data-role="assistant"]').getByText("Jeg har skiftet farven:"),
    ).toHaveCount(revision, { timeout: 20_000 });

    expect(await leaked(page), `revision ${revision}`).toBeNull();
  }

  // Still one thing, and every write of it is a contained unit in the chat: the
  // first revision is a card for the version it recorded, and the two that
  // restated it record nothing — so they are cards that open what exists.
  await expect(page.locator("[data-build-count]")).toHaveAttribute("data-build-count", "1");
  await expect(page.locator('[data-artifact-contained="existing"]')).toHaveCount(2);

  // After a reload too, where every card is rebuilt from what the server stored.
  await page.reload();
  await expect(
    page.locator('article[data-role="assistant"]').getByText("Jeg har skiftet farven:"),
  ).toHaveCount(3, { timeout: 20_000 });
  await expect(page.locator('[data-artifact-contained="existing"]')).toHaveCount(2);
  for (const article of await page.locator('article[data-role="assistant"]').all()) {
    expect(await article.innerText()).not.toContain(LEAK);
  }
});
