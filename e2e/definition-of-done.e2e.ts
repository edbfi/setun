import { expect, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { APP_ORIGIN, E2E_EDUCATOR_PASSWORD, E2E_EDUCATOR_USERNAME } from "../playwright.config";
import { startConversation } from "./support/chat";
import { clearLoginWindow } from "./support/login-window";
import { ARTIFACT_MARKER } from "./support/stub-gateway";

/**
 * Pupil-facing strings, in the classroom's own language (PRD §8, §18).
 *
 * This suite creates its classroom through the panel, so it takes the default
 * `interfaceLanguage` — Danish — and a pupil in it sees Danish. The educator
 * half stays on the base locale, which is what the panel renders here. Asserting
 * both in the same language would only be possible by making one of them wrong.
 */
const PUPIL_LOCALE = { locale: "da" } as const;

// The login page is deliberately not in that list: nobody is signed in yet, so
// there is no classroom to take a language from and it renders the base locale.


/**
 * The §25 walkthrough, as one continuous run (plan Phase 5 exit criterion).
 *
 * "An educator opens the panel and presses **Open classroom**. Students open
 * their Chromebooks, enter a pseudonymous code, and begin. One asks for an
 * interactive page… and receives a working application they can read, change,
 * break, and argue with. At the end of the lesson the educator presses **Lock
 * classroom**, and new requests stop — verifiably, at the API, not only in the
 * interface."
 *
 * Every piece of this is covered in depth by another suite. What this adds is
 * that they are one story: the same classroom, the same code, the same pupil,
 * in the order a lesson happens. Run at the target device's viewport, because
 * "no student supplied a name" is not the only claim §25 makes.
 */

test.describe.configure({ mode: "serial" });

/** §20's device: 1366×768, roughly 640 pixels usable after browser chrome. */
test.use({ viewport: { width: 1366, height: 640 } });

test.beforeEach(clearLoginWindow);

test("the definition of done, start to finish (§25)", async ({ page, browser }) => {
  test.setTimeout(180_000);

  const name = `E2E lesson ${Date.now()}`;

  // --- The educator opens the panel ---
  await page.goto("/educator/login");
  await page.getByLabel(m.educator_username_label()).fill(E2E_EDUCATOR_USERNAME);
  await page.getByLabel(m.educator_password_label()).fill(E2E_EDUCATOR_PASSWORD);
  await page.getByRole("button", { name: m.educator_login_submit() }).click();
  await expect(page).toHaveURL(/\/educator$/);

  // A model alias, curated in the panel: a friendly name, the gateway identifier
  // CPA knows, and the dialect. The identifier never reaches a pupil (§9, §21).
  const alias = `Lektionsmodel ${Date.now()}`;
  await page.getByRole("link", { name: m.educator_aliases_title() }).click();

  // Scoped to the create form: every existing row carries the same field labels,
  // because a row on this page is an edit form for that alias.
  const addAlias = page.locator("section").filter({ hasText: m.educator_add_alias() });
  await addAlias.getByLabel(m.educator_alias_name_label()).fill(alias);
  await addAlias.getByLabel(m.educator_alias_gateway_label()).fill("stub-model");
  // In service, and covered by a data processing agreement — otherwise
  // allowlisting it demands the §16 confirmation, which is its own test.
  await addAlias.getByLabel(m.educator_alias_available_label()).check();
  await addAlias.getByLabel(m.educator_alias_dpa_label()).check();
  await addAlias.getByRole("button", { name: m.educator_add_alias() }).click();
  await expect(addAlias.getByRole("button", { name: m.educator_add_alias() })).toBeEnabled();

  await page.goto("/educator");
  await page.getByLabel(m.educator_classroom_name_label()).fill(name);
  await page.getByRole("button", { name: m.educator_create_classroom() }).click();
  await expect(page).toHaveURL(/\/educator\/classrooms\//);
  const classroomUrl = page.url();

  // A model the class may use. An absent allowlist row is a denial (§8, §9).
  await page.getByRole("link", { name: m.educator_nav_settings() }).click();
  await page
    .getByRole("listitem")
    .filter({ hasText: alias })
    .getByRole("button", { name: m.educator_allowlist_allow() })
    .click();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: alias })
      .getByRole("button", { name: m.educator_allowlist_disallow() }),
  ).toBeVisible();

  // --- …provisions students, and prints their cards ---
  await page.goto(`${classroomUrl}/roster`);
  await page.getByLabel(m.educator_provision_count_label()).fill("1");
  await page.getByRole("button", { name: m.educator_provision_submit() }).click();
  await expect(page.getByText(m.educator_cards_once())).toBeVisible();

  const code = (await page.locator("[data-slip-code]").allTextContents())[0];
  expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);

  // --- …and presses Open classroom ---
  await page.goto(classroomUrl);
  await page.getByRole("button", { name: m.educator_open_now() }).click();
  await expect(page.getByText(m.educator_state_open(), { exact: true })).toBeVisible();

  // --- A pupil enters the code, on a Chromebook-sized screen ---
  const lesson = await browser.newContext({ viewport: { width: 1366, height: 640 } });
  const pupil = await lesson.newPage();

  await pupil.goto("/login");
  await pupil.getByLabel(m.login_code_label()).fill(code);
  await pupil.getByRole("button", { name: m.login_submit() }).click();
  await expect(pupil).toHaveURL(/\/chat/);

  // Nothing was asked of them but the code: no name, no email, no phone number.
  await expect(pupil.getByLabel(/e-?mail/i)).toHaveCount(0);

  // --- …and asks for an interactive page ---
  await startConversation(pupil, PUPIL_LOCALE);
  const conversationId = new URL(pupil.url()).searchParams.get("c") ?? "";
  await pupil
    .getByRole("textbox", { name: m.chat_composer_label({}, PUPIL_LOCALE) })
    .fill(`${ARTIFACT_MARKER} lav en side der viser hvordan lag sender information videre`);
  await pupil.getByRole("button", { name: m.chat_send({}, PUPIL_LOCALE) }).click();

  // --- …and gets one they can read, change and break ---
  // The workspace turns to the model's write; the pupil does not have to find it.
  await expect(pupil.locator("[data-build-count]")).toHaveAttribute("data-build-count", "1", {
    timeout: 30_000,
  });
  await expect(
    pupil.getByRole("tab", { name: m.artifact_tab_preview({}, PUPIL_LOCALE) }),
  ).toBeVisible({ timeout: 30_000 });

  const stage = pupil
    .frameLocator(`iframe[title="${m.artifact_frame_title({}, PUPIL_LOCALE)}"]`)
    .frameLocator("#stage");
  await expect(stage.locator("#knap")).toHaveText("Klik her", { timeout: 30_000 });

  // The generated page runs on the sandbox origin, not the application's (§14).
  const frameSource = await pupil
    .locator(`iframe[title="${m.artifact_frame_title({}, PUPIL_LOCALE)}"]`)
    .getAttribute("src");
  expect(frameSource).toContain(new URL(process.env.SETUN_SANDBOX_ORIGIN ?? "http://localhost:4174").host);

  // The conversation is still beside it: the composer was never covered, so
  // asking for the next change costs nothing (§13, §20).
  await expect(
    pupil.getByRole("textbox", { name: m.chat_composer_label({}, PUPIL_LOCALE) }),
  ).toBeVisible();

  // --- The educator presses Lock classroom ---
  await page.goto(classroomUrl);
  await page.getByRole("button", { name: m.educator_lock_classroom() }).click();
  await expect(page.getByText(m.educator_state_locked(), { exact: true })).toBeVisible();

  // --- …and new requests stop, at the API, not only in the interface ---
  const created = await pupil.request.post("/api/conversations", {
    data: {},
    headers: { origin: APP_ORIGIN },
  });
  expect(created.status()).toBe(403);

  // Their own conversation, which they were using a moment ago: the refusal is
  // the classroom's state, not a missing row.
  const refused = await pupil.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "endnu et spørgsmål" },
  });
  expect(refused.status()).toBe(403);

  await lesson.close();
});
