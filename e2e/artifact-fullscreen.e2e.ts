import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_DATABASE_PATH, E2E_PEPPER } from "../playwright.config";
import { mountArtifact } from "./support/artifact-host";
import { startConversation } from "./support/chat";
import { clearLoginWindow } from "./support/login-window";
import { ARTIFACT_MARKER } from "./support/stub-gateway";

/**
 * Games a pupil can actually play (PRD §13, §14, §20).
 *
 * Reported from a classroom: a mouse-look game could only be dragged, never
 * "entered" — the sandbox refused `requestPointerLock()` — and there was no way
 * to give a game the whole screen. Pointer lock is now granted inside the
 * sandbox; full screen is the application's to grant, on its own element, and
 * never the artifact's.
 */

const run = promisify(execFile);
const CLASSROOM = "E2E fullscreen";

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

/** A canvas that locks the pointer on click, and a button that tries to go full screen. */
const GAME = `<!doctype html><html><body style="margin:0">
<canvas id="game" style="display:block;width:100vw;height:80vh"></canvas>
<button id="full">full</button><pre id="lock">idle</pre><pre id="screen">idle</pre>
<script>
const game = document.getElementById("game");
const lock = document.getElementById("lock");
const screen = document.getElementById("screen");
document.addEventListener("pointerlockchange", () => {
  lock.textContent = document.pointerLockElement === game ? "locked" : "released";
});
document.addEventListener("pointerlockerror", () => { lock.textContent = "refused"; });
game.addEventListener("click", () => {
  try {
    const pending = game.requestPointerLock();
    if (pending && pending.catch) pending.catch((error) => { lock.textContent = "refused:" + error.name; });
  } catch (error) { lock.textContent = "threw:" + error.name; }
});
document.getElementById("full").addEventListener("click", () => {
  document.documentElement.requestFullscreen().then(
    () => { screen.textContent = "granted"; },
    (error) => { screen.textContent = "refused:" + error.name; },
  );
});
</script></body></html>`;

test.beforeEach(clearLoginWindow);

test("a game can lock the pointer, but cannot take the screen by itself", async ({ page }) => {
  await signIn(page);
  const stage = await mountArtifact(page, { language: "html", source: GAME });

  await stage.locator("#game").click();
  await expect(stage.locator("#lock")).toHaveText("locked", { timeout: 10_000 });

  // Full screen stays the application's to grant: a page that can take over the
  // screen by itself can draw a fake one.
  // Released from inside: a headless browser has no Esc of its own to press.
  await stage.locator("body").evaluate(() => document.exitPointerLock());
  await expect(stage.locator("#lock")).toHaveText("released");
  await stage.locator("#full").click();
  await expect(stage.locator("#screen")).toHaveText(/^refused/);
});

test("the artifact goes full screen from the panel, and comes back", async ({ page }) => {
  await signIn(page);
  await startConversation(page);
  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill(`${ARTIFACT_MARKER} lav en klikker`);
  await page.getByRole("button", { name: m.chat_send() }).click();
  await expect(page.locator("[data-build-count]")).toHaveAttribute("data-build-count", "1", {
    timeout: 20_000,
  });

  await page.getByRole("button", { name: m.artifact_fullscreen_enter() }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.hasAttribute("data-artifact-stage")))
    .toBe(true);

  // The game is still the game in there.
  const game = page
    .frameLocator(`iframe[title="${m.artifact_frame_title()}"]`)
    .frameLocator("#stage");
  await expect(game.locator("#knap")).toBeVisible();

  // And there is a way out that needs no Esc key.
  await page.getByRole("button", { name: m.artifact_fullscreen_exit() }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.getByRole("button", { name: m.artifact_fullscreen_enter() })).toBeVisible();
});
