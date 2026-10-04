import { type Browser, expect, type Page, test } from "@playwright/test";
import { accessSlipFilename } from "../src/lib/access-slips";
import { EDUCATOR_RECOVERY_COMMAND } from "../src/lib/educator-recovery";
import * as m from "../src/lib/paraglide/messages";
import { E2E_EDUCATOR_PASSWORD, E2E_EDUCATOR_USERNAME } from "../playwright.config";
import { clearLoginWindow } from "./support/login-window";

/**
 * The educator flow of §22, end to end (plan 5.1, PRD §7, §17, §22).
 *
 * "An educator creating a classroom, provisioning students, opening, locking,
 * and rotating a credential — all asserted at the API level, not only in the
 * UI."
 *
 * So every credential claim below is settled by using the code, not by reading
 * the screen: the provisioned code signs a pupil in, the rotated one signs them
 * in, and the code it replaced is refused. The panel is how the educator gets
 * there; the API is what says whether it worked.
 *
 * This suite creates its own classroom per run, so nothing it opens, locks or
 * provisions reaches a room another suite is chatting in.
 */

/**
 * Appendix A caps one IP at 30 login attempts per 15 minutes, and every worker
 * here is loopback. Cleared per test so the suites do not fail each other's
 * sign-ins; the limiter itself is asserted in `bun test` (§7, §22).
 */
test.beforeEach(clearLoginWindow);

test.describe.configure({ mode: "serial" });

const CLASSROOM = `E2E educator ${Date.now()}`;

async function signIn(page: Page): Promise<void> {
  await page.goto("/educator/login");
  await page.getByLabel(m.educator_username_label()).fill(E2E_EDUCATOR_USERNAME);
  await page.getByLabel(m.educator_password_label()).fill(E2E_EDUCATOR_PASSWORD);
  await page.getByRole("button", { name: m.educator_login_submit() }).click();
  await expect(page).toHaveURL(/\/educator$/);
}

/**
 * Try a code at the real login endpoint, in a browser context of its own.
 *
 * A separate context per attempt, because the question is always whether *this
 * code* authenticates — a cookie left over from a previous attempt would answer
 * a different one.
 */
async function codeSignsIn(browser: Browser, code: string): Promise<boolean> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();

  const signedIn = await page
    .waitForURL(/\/chat/, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  await context.close();
  return signedIn;
}

test("credential recovery guidance is educator-only", async ({ page }) => {
  await page.goto("/educator/login");
  await page.getByText(m.educator_recovery_action()).click();
  await expect(page.getByText(EDUCATOR_RECOVERY_COMMAND)).toBeVisible();

  await page.goto("/login");
  await expect(page.getByText(m.educator_recovery_action())).toHaveCount(0);
  await expect(page.getByText(EDUCATOR_RECOVERY_COMMAND)).toHaveCount(0);
});

test("an educator creates a classroom, provisions pupils, opens, locks and rotates (§17, §22)", async ({
  page,
  browser,
}) => {
  await signIn(page);

  // --- Create ---
  await page.getByLabel(m.educator_classroom_name_label()).fill(CLASSROOM);
  await page.getByRole("button", { name: m.educator_create_classroom() }).click();
  await expect(page).toHaveURL(/\/educator\/classrooms\//);

  const classroomUrl = page.url();
  const appOrigin = new URL(classroomUrl).origin;

  // A direct action POST is educator-guarded, not protected only by hidden UI.
  const unauthenticated = await browser.newContext();
  const unauthenticatedIssue = await unauthenticated.request.post(
    `${classroomUrl}/roster?/rotateClassroom`,
    { form: {}, headers: { origin: appOrigin }, maxRedirects: 0 },
  );
  expect(unauthenticatedIssue.status()).toBe(200);
  expect(await unauthenticatedIssue.json()).toEqual({
    type: "redirect",
    status: 303,
    location: "/educator/login",
  });
  await unauthenticated.close();

  // --- Provision a batch, and read the cards ---
  await page.getByRole("link", { name: m.educator_nav_roster() }).click();
  await page.getByLabel(m.educator_provision_count_label()).fill("9");
  await page.getByRole("button", { name: m.educator_provision_submit() }).click();

  // "The code is shown at provisioning and rotation only" (§7): the cards are in
  // this response and nowhere else.
  await expect(page.getByText(m.educator_cards_once())).toBeVisible();
  const codes = await page.locator("[data-slip-code]").allTextContents();
  expect(codes).toHaveLength(9);

  // Distinct codes from a CSPRNG, not a sequence (§7, §21).
  expect(new Set(codes).size).toBe(9);

  // The card names the pupil it belongs to, so the rotation below can name the
  // same one rather than trusting two lists to be in the same order.
  const labels = await page.locator("[data-slip-label]").allTextContents();
  expect(labels).toHaveLength(9);

  // Fragment-assisted sign-in uses the unchanged login action, and the bearer
  // fragment is gone by the time authentication completes.
  const qrContext = await browser.newContext();
  const qrPage = await qrContext.newPage();
  await qrPage.goto(`/login#code=${encodeURIComponent(codes[1])}`);
  await expect(qrPage).toHaveURL(/\/chat/);
  expect(new URL(qrPage.url()).hash).toBe("");
  const studentIssue = await qrPage.request.post(`${classroomUrl}/roster?/rotateClassroom`, {
    form: {},
    headers: { origin: appOrigin },
    maxRedirects: 0,
  });
  expect(studentIssue.status()).toBe(200);
  expect(await studentIssue.json()).toEqual({
    type: "redirect",
    status: 303,
    location: "/educator/login",
  });
  await qrContext.close();

  // The document bootstrap erases the fragment even when hydration fails.
  const unhydratedContext = await browser.newContext();
  await unhydratedContext.route(/\/_app\/immutable\/.*\.js$/, (route) => route.abort());
  const unhydratedPage = await unhydratedContext.newPage();
  await unhydratedPage.goto(`/login#code=${encodeURIComponent(codes[2])}`, {
    waitUntil: "domcontentloaded",
  });
  expect(new URL(unhydratedPage.url()).hash).toBe("");
  await unhydratedContext.close();

  // With JavaScript disabled, the immediate noscript refresh replaces the
  // secret-bearing history entry and leaves manual code entry available.
  const noScriptContext = await browser.newContext({ javaScriptEnabled: false });
  const noScriptPage = await noScriptContext.newPage();
  await noScriptPage.goto(`/login#code=${encodeURIComponent(codes[2])}`);
  await expect(noScriptPage).toHaveURL(/\/login\?manual=1$/);
  expect(new URL(noScriptPage.url()).hash).toBe("");
  expect(await noScriptPage.goBack()).toBeNull();
  expect(noScriptPage.url()).toBe("about:blank");
  await noScriptContext.close();

  // --- The code works, at the login endpoint ---
  expect(await codeSignsIn(browser, codes[0])).toBe(true);

  // --- Reloading the roster does not show a code again (§7) ---
  await page.reload();
  await expect(page.getByText(m.educator_cards_once())).toHaveCount(0);
  await expect(page.locator("[data-slip-code]")).toHaveCount(0);

  // A valid educator session still cannot smuggle a student ID across classes.
  const firstStudentId = await page
    .locator('input[name="studentId"]')
    .first()
    .getAttribute("value");
  expect(firstStudentId).toBeTruthy();
  await page.goto("/educator");
  await page
    .getByLabel(m.educator_classroom_name_label())
    .fill(`E2E cross-class ${Date.now()}`);
  await page.getByRole("button", { name: m.educator_create_classroom() }).click();
  const crossClassIssue = await page.request.post(`${page.url()}/roster?/rotate`, {
    form: { studentId: firstStudentId ?? "" },
    headers: { origin: appOrigin },
    maxRedirects: 0,
  });
  expect(crossClassIssue.status()).toBe(404);

  // --- Open, then lock ---
  await page.goto(classroomUrl);
  await page.getByRole("button", { name: m.educator_open_now() }).click();
  await expect(page.getByText(m.educator_state_open(), { exact: true })).toBeVisible();

  await page.getByRole("button", { name: m.educator_lock_classroom() }).click();
  await expect(page.getByText(m.educator_state_locked(), { exact: true })).toBeVisible();

  // --- Rotate: the new code works and the old one is refused (§7, §21) ---
  await page.goto(`${classroomUrl}/roster`);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("listitem")
    .filter({ hasText: labels[0] })
    .getByRole("button", { name: m.educator_slip_create() })
    .click();
  await expect(page.getByText(m.educator_cards_once())).toBeVisible();

  const rotated = (await page.locator("[data-slip-code]").allTextContents())[0];
  expect(rotated).not.toBe(codes[0]);

  // The rotated code is the credential now; the one it replaced is not.
  expect(await codeSignsIn(browser, rotated)).toBe(true);
  expect(await codeSignsIn(browser, codes[0])).toBe(false);

  // --- Rotate the server-selected active classroom as one batch ---
  let bulkRotationRequests = 0;
  const bulkRotationUrl = /\/roster\?\/rotateClassroom$/;
  await page.route(bulkRotationUrl, async (route) => {
    bulkRotationRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  page.once("dialog", (dialog) => dialog.accept());
  const bulkRotation = page.getByRole("button", {
    name: m.educator_slip_bulk_submit({ count: 9 }),
  });
  await bulkRotation.click();
  await expect(bulkRotation).toBeDisabled();
  await bulkRotation.click({ force: true });
  await expect(page.locator("[data-slip-code]")).toHaveCount(9);
  expect(bulkRotationRequests).toBe(1);
  await page.unroute(bulkRotationUrl);
  const classroomCodes = await page.locator("[data-slip-code]").allTextContents();
  expect(classroomCodes).toHaveLength(9);
  expect(await codeSignsIn(browser, rotated)).toBe(false);
  expect(await codeSignsIn(browser, classroomCodes[0])).toBe(true);

  // The PDF is generated in the browser from the two visible A4 SVG pages.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: m.educator_slip_download() }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    accessSlipFilename({ scope: "classroom", classroomName: CLASSROOM }),
  );
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const pdf = Buffer.concat(chunks).toString("latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  expect(pdf.match(/\/Type\s*\/Page\b/g)).toHaveLength(2);

  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: m.educator_slip_download() })).toBeHidden();
  await expect(page.getByRole("navigation")).toBeHidden();
  const printPages = await page.locator(".access-slip-page").evaluateAll((elements) =>
    elements.map((element) => ({
      width: getComputedStyle(element).width,
      height: getComputedStyle(element).height,
      breakAfter: getComputedStyle(element).breakAfter,
    })),
  );
  expect(printPages).toHaveLength(2);
  expect(Number.parseFloat(printPages[0]?.width ?? "0")).toBeCloseTo(793.7, 0);
  expect(Number.parseFloat(printPages[0]?.height ?? "0")).toBeCloseTo(1122.5, 0);
  expect(printPages[0]?.breakAfter).toBe("page");
});

test("a removed pupil leaves the roster, and a disabled one cannot sign in (§16, §21)", async ({
  page,
  browser,
}) => {
  await signIn(page);

  const name = `E2E roster ${Date.now()}`;
  await page.getByLabel(m.educator_classroom_name_label()).fill(name);
  await page.getByRole("button", { name: m.educator_create_classroom() }).click();
  await page.getByRole("link", { name: m.educator_nav_roster() }).click();

  await page.getByLabel(m.educator_provision_count_label()).fill("2");
  await page.getByRole("button", { name: m.educator_provision_submit() }).click();
  await expect(page.getByText(m.educator_cards_once())).toBeVisible();

  const codes = await page.locator("[data-slip-code]").allTextContents();
  // By label rather than by position: the roster is ordered by label and the
  // cards by the order they were minted, which are not the same order.
  const labels = await page.locator("[data-slip-label]").allTextContents();

  // Disabling stops the credential working at once (§7, §21).
  await page
    .getByRole("listitem")
    .filter({ hasText: labels[0] })
    .getByRole("button", { name: m.educator_student_disable() })
    .click();
  await expect(page.getByText(m.educator_status_disabled(), { exact: true })).toBeVisible();

  expect(await codeSignsIn(browser, codes[0])).toBe(false);

  // Removal takes the other pupil off the roster; their work is untouched (§16).
  await page
    .getByRole("listitem")
    .filter({ hasText: labels[1] })
    .getByRole("button", { name: m.educator_student_remove() })
    .click();
  await expect(page.getByRole("button", { name: m.educator_student_remove() })).toHaveCount(1);

  await page.getByRole("link", { name: m.educator_show_removed() }).click();
  await expect(page.getByText(m.educator_status_removed(), { exact: true })).toBeVisible();

  // Acting from the removed view keeps that view (SvelteKit 3 would otherwise
  // navigate to the action's page, which drops `?removed=1`).
  await page
    .getByRole("listitem")
    .filter({ hasText: labels[1] })
    .getByRole("button", { name: m.educator_student_enable() })
    .click();
  await expect(page.getByText(m.educator_status_removed(), { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]removed=1/);
  await expect(page.getByRole("link", { name: m.educator_hide_removed() })).toBeVisible();
});

test("deleting a classroom restores the dashboard title", async ({ page }) => {
  await signIn(page);

  const name = `E2E delete ${Date.now()}`;
  await page.getByLabel(m.educator_classroom_name_label()).fill(name);
  await page.getByRole("button", { name: m.educator_create_classroom() }).click();
  await expect(page).toHaveURL(/\/educator\/classrooms\//);

  await page.getByRole("link", { name: m.educator_nav_settings() }).click();
  await page.getByLabel(m.educator_delete_classroom_confirm_label()).fill(name);
  await page.getByRole("button", { name: m.educator_delete_classroom_submit() }).click();

  await expect(page).toHaveURL(/\/educator$/);
  await expect(page).toHaveTitle(`${m.educator_panel_title()} · ${m.app_name()}`);
});
