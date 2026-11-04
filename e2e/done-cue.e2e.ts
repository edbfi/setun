import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_DATABASE_PATH, E2E_PEPPER } from "../playwright.config";
import { openDrawer, startConversation } from "./support/chat";
import { clearLoginWindow } from "./support/login-window";

/**
 * The cue that an answer is done (PRD §20).
 *
 * The chime is synthesised with Web Audio, which a headless browser plays to
 * nobody — so the page gets a recording `AudioContext` instead, installed
 * before any script runs, and the test counts the notes it was asked for.
 */

const run = promisify(execFile);
const CLASSROOM = "E2E done cue";

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

/** Replace Web Audio with a recorder: every oscillator started is a note played. */
async function recordNotes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { __notes: number };
    state.__notes = 0;
    const param = () => ({
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
    });
    class RecordingContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume() {
        return Promise.resolve();
      }
      createGain() {
        return { gain: param(), connect: (next: unknown) => next };
      }
      createOscillator() {
        return {
          type: "sine",
          frequency: param(),
          connect: (next: unknown) => next,
          start() {
            state.__notes++;
          },
          stop() {},
        };
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = RecordingContext;
  });
}

async function notes(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __notes: number }).__notes);
}

async function askAndWait(page: Page, text: string, answers: number): Promise<void> {
  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill(text);
  await page.getByRole("button", { name: m.chat_send() }).click();
  await expect(page.locator('article[data-role="assistant"]')).toHaveCount(answers, {
    timeout: 20_000,
  });
  await expect(page.locator('[data-turn-stage="done"]')).toBeVisible();
}

test.beforeEach(clearLoginWindow);

test("a finished answer chimes softly, and the pupil can turn it off", async ({ page }) => {
  await recordNotes(page);
  await signIn(page);
  await startConversation(page);

  // On by default in a classroom nobody changed.
  await askAndWait(page, "Hvad er et loop?", 1);
  await expect.poll(() => notes(page)).toBe(2);

  // Off, in one switch in the drawer, and it stays off on this device.
  await openDrawer(page);
  const control = page.getByRole("switch", { name: m.chat_done_sound_label() });
  await expect(control).toHaveAttribute("aria-checked", "true");
  await control.click();
  await expect(control).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  await askAndWait(page, "Og en gang til?", 2);
  // The "done" stage still says so — only the sound is gone.
  expect(await notes(page)).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem("setun:done-sound"))).toBe("off");
});
