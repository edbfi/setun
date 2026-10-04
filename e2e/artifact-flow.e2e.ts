import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { APP_ORIGIN, E2E_DATABASE_PATH, E2E_PEPPER, E2E_STORAGE_PATH } from "../playwright.config";
import {
  ARTIFACT_MARKER,
  ARTIFACT_PROJECT_MARKER,
  ARTIFACT_PROJECT_REVISION_MARKER,
  ARTIFACT_REVISION_MARKER,
  ARTIFACT_SECOND_MARKER,
} from "./support/stub-gateway";
import { openDrawer, startConversation } from "./support/chat";
import { clearLoginWindow } from "./support/login-window";

/**
 * The student build flow, end to end (plan 4.3–4.6; PRD §13, §22).
 *
 * The Phase 4 exit criterion: a student asks for an interactive page, it renders
 * in the sandboxed frame, they edit it in CodeMirror, see a diff of what the
 * model wrote, and their edit travels back on the next message — with the
 * creations gallery holding what they made afterwards.
 */

const run = promisify(execFile);
const CLASSROOM = "E2E build";

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

async function seedImage(label: string): Promise<{ id: string; prompt: string }> {
  const { stdout } = await run("bun", ["run", "e2e/support/seed-image.ts"], {
    env: {
      ...process.env,
      SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
      SETUN_STORAGE_PATH: E2E_STORAGE_PATH,
      SETUN_E2E_STUDENT_LABEL: label,
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

/**
 * Send a message and wait until the conversation holds `count` artifacts.
 *
 * Nothing is closed first: the build surface is a pane beside the conversation
 * rather than an overlay over it, so the composer is reachable while an artifact
 * is on screen — which is the whole point of the workspace (§13, §20).
 */
async function ask(page: Page, text: string, count: number): Promise<void> {
  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill(text);
  await page.getByRole("button", { name: m.chat_send() }).click();

  await expect(page.locator("[data-build-count]")).toHaveAttribute(
    "data-build-count",
    String(count),
    { timeout: 20_000 },
  );
}

/** Put the workspace back on the conversation alone. */
async function showChatOnly(page: Page): Promise<void> {
  await page.getByRole("radio", { name: m.workspace_stage_chat() }).click();
}

/** Ask the stub for an artifact and wait until the answer has landed. */
async function askForArtifact(page: Page): Promise<void> {
  // Wait for the conversation to exist before typing into the composer: a draft
  // typed before that navigation lands is discarded by it.
  await startConversation(page);
  await ask(page, `${ARTIFACT_MARKER} lav en klikker`, 1);
}

/**
 * Appendix A caps one IP at 30 login attempts per 15 minutes, and every worker
 * here is loopback. Cleared per test so the suites do not fail each other's
 * sign-ins; the limiter itself is asserted in `bun test` (§7, §22).
 */
test.beforeEach(clearLoginWindow);

test("a student builds an artifact, edits it, and the edit travels back", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await askForArtifact(page);

  // The workspace turns to the model's write rather than waiting to be found:
  // the switcher is still there, but the pupil does not have to look (§13).
  await expect(page.getByRole("tab", { name: m.artifact_tab_preview() })).toBeVisible({
    timeout: 20_000,
  });

  // Tier 0: it renders in the sandboxed frame with no build step (§13, §14).
  const stage = page
    .frameLocator('iframe[title="' + m.artifact_frame_title() + '"]')
    .frameLocator("#stage");
  await expect(stage.locator("#knap")).toHaveText("Klik her", { timeout: 20_000 });

  // The source, in CodeMirror.
  await page.getByRole("tab", { name: m.artifact_tab_code() }).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 20_000 });

  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type('<p id="knap">Min knap</p>');

  // An explicit Run is a commit point: it compiles and it stores a revision (§13).
  await page.getByRole("button", { name: m.artifact_run() }).click();
  await expect(page.getByText(m.artifact_edit_carried())).toBeVisible({ timeout: 20_000 });

  // The edit is a version of its own; the diff has both sides (§13).
  await page.getByRole("tab", { name: m.artifact_tab_history() }).click();
  await expect(
    page.getByRole("button", { name: m.artifact_version_label({ revision: 2 }) }),
  ).toBeVisible();
  await expect(page.getByText(m.artifact_version_by_student()).first()).toBeVisible();
  await expect(page.getByText(m.artifact_version_by_model()).first()).toBeVisible();

  const artifactId = await page
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");

  // Asserted at the API level too, not only in the interface (§22). Read before
  // the next turn, which will have the model writing a revision of its own.
  const stored = await page.request.get(`/api/artifacts/${artifactId}`);
  expect(stored.status()).toBe(200);

  const body = await stored.json();
  expect(body.versions).toHaveLength(2);
  expect(body.versions[0].authoredBy).toBe("model");
  expect(body.versions[1].authoredBy).toBe("student");
  // The list carries paths and sizes; the content is its own request, because a
  // project of a hundred kilobytes revised twenty times would otherwise arrive
  // whole every time the History tab opened (§13).
  expect(body.versions[1].files.map((file: { path: string }) => file.path)).toEqual([
    "index.html",
  ]);

  const edited = await (
    await page.request.get(`/api/artifacts/${artifactId}/versions/${body.versions[1].id}`)
  ).json();
  expect(edited.files["index.html"]).toContain("Min knap");
  // Each revision carries the tag it was written under, so restoring one later
  // does not run it through the pipeline the row has since moved to (§13).
  expect(body.versions[0].language).toBe("html");
  expect(body.versions[1].language).toBe("html");

  // The composer is reachable with the artifact still on screen: no closing, no
  // putting anything away first (§13, §20).
  await expect(page.getByRole("tab", { name: m.artifact_tab_history() })).toBeVisible();

  // The next message carries the current source, marked as the student's (§13).
  // It asks for an artifact too, so the model writes a revision of its own —
  // which is what makes "delivered once" observable in the next assertion.
  await page
    .getByRole("textbox", { name: m.chat_composer_label() })
    .fill(`Jeg ødelagde den — ${ARTIFACT_MARKER}`);
  await page.getByRole("button", { name: m.chat_send() }).click();

  await expect(page.getByText(/Your edited version of|Din rettede version af/)).toBeVisible({
    timeout: 20_000,
  });

  // And it travelled once, not on every later turn (§13): the edit is delivered,
  // so the model's own next revision is what the artifact now holds.
  const after = await (await page.request.get(`/api/artifacts/${artifactId}`)).json();
  expect(after.versions.at(-1).authoredBy).toBe("model");

  // The language tag, last: posting one appends a student revision of its own,
  // and doing it earlier would have made *that* the edit carried above rather
  // than the one the pupil typed into CodeMirror.
  const posted = await page.request.post(`/api/artifacts/${artifactId}/versions`, {
    headers: { origin: APP_ORIGIN },
    data: {
      files: { "App.svelte": "<p>en komponent</p>" },
      deletes: ["index.html"],
      entry: "App.svelte",
      language: "svelte",
    },
  });
  expect(posted.status()).toBe(201);
  expect((await posted.json()).language).toBe("svelte");

  // And a tag Setun does not recognise is refused before it reaches the database.
  const refused = await page.request.post(`/api/artifacts/${artifactId}/versions`, {
    headers: { origin: APP_ORIGIN },
    data: { files: { "index.html": "<p>nej</p>" }, language: "cobol" },
  });
  expect(refused.status()).toBe(400);

  // As is a path that would leave the project (§21).
  const escaped = await page.request.post(`/api/artifacts/${artifactId}/versions`, {
    headers: { origin: APP_ORIGIN },
    data: { files: { "../stjaalet.html": "<p>nej</p>" } },
  });
  expect(escaped.status()).toBe(400);
});

test("history retains deleted paths and language-only restores create revisions", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();
  await signIn(page, code);
  await askForArtifact(page);
  const artifactId = await page.locator("[data-artifact-id]").first().getAttribute("data-artifact-id");
  const endpoint = `/api/artifacts/${artifactId}/versions`;
  const files = { "index.html": "<p>same source</p>", "styles.css": "p { color: red }" };

  const initial = await page.request.post(endpoint, {
    headers: { origin: APP_ORIGIN },
    data: { files, entry: "index.html", language: "html", replace: true },
  });
  expect(initial.status()).toBe(201);
  const changed = await page.request.post(endpoint, {
    headers: { origin: APP_ORIGIN },
    data: { files, entry: "index.html", language: "svg", replace: true },
  });
  expect(changed.status()).toBe(201);
  expect((await changed.json()).language).toBe("svg");
  const unchanged = await page.request.post(endpoint, {
    headers: { origin: APP_ORIGIN },
    data: { files, entry: "index.html", language: "svg", replace: true },
  });
  expect(unchanged.status()).toBe(200);

  const removed = await page.request.post(endpoint, {
    headers: { origin: APP_ORIGIN },
    data: { files: {}, deletes: ["styles.css"], language: "svg" },
  });
  expect(removed.status()).toBe(201);
  const history = await (await page.request.get(`/api/artifacts/${artifactId}`)).json();
  expect(history.versions.at(-1).files).toContainEqual({
    path: "styles.css",
    bytes: new TextEncoder().encode(files["styles.css"]).length,
    change: "deleted",
  });
});

test("the creations gallery holds what the student made", async ({ page }) => {
  test.setTimeout(120_000);
  const { label, code } = await provisionStudent();
  const image = await seedImage(label);

  await signIn(page, code);
  await askForArtifact(page);

  await openDrawer(page);
  await page.getByRole("link", { name: m.creations_link() }).click();
  await expect(page).toHaveURL(/\/creations/);

  // Both kinds of creation, in one portfolio (§13, §16).
  await expect(page.getByText("Klikkeren")).toBeVisible();
  await expect(page.getByAltText(m.creations_image_alt({ prompt: image.prompt }))).toBeVisible();

  // Students delete their own creations (§16).
  await page.getByRole("button", { name: m.artifact_delete() }).first().click();
  await expect(page.getByText("Klikkeren")).toHaveCount(0);
});

test("a student cannot reach another student's artifact", async ({ browser }) => {
  test.setTimeout(120_000);
  const [owner, intruder] = await Promise.all([provisionStudent(), provisionStudent()]);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner.code);
  await askForArtifact(ownerPage);

  const target = await ownerPage
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");

  expect(target ?? "").not.toBe("");

  const intruderContext = await browser.newContext();
  const intruderPage = await intruderContext.newPage();
  await signIn(intruderPage, intruder.code);

  // Absent, not forbidden: there is nothing to probe (§21).
  const read = await intruderPage.request.get(`/api/artifacts/${target}`);
  expect(read.status()).toBe(404);

  const write = await intruderPage.request.post(`/api/artifacts/${target}/versions`, {
    headers: { origin: APP_ORIGIN },
    data: { files: { "index.html": "<p>stjålet</p>" } },
  });
  expect(write.status()).toBe(404);

  // And nothing of the owner's shows in the intruder's own gallery (§16, §21).
  await intruderPage.goto("/creations");
  await expect(intruderPage.getByText("Klikkeren")).toHaveCount(0);

  await ownerContext.close();
  await intruderContext.close();
});

test("the artifact API refuses an unauthenticated caller", async ({ request }) => {
  const read = await request.get(`/api/artifacts/${crypto.randomUUID()}`);
  expect(read.status()).toBe(401);

  const write = await request.post(`/api/artifacts/${crypto.randomUUID()}/versions`, {
    headers: { origin: APP_ORIGIN },
    data: { source: "<p>x</p>" },
  });
  expect(write.status()).toBe(401);
});

test("a second turn revises the same artifact rather than replacing it", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await askForArtifact(page);

  // The failure this replaces: the follow-up produced a fragment, which became
  // revision 2 of the page — so the page disappeared and the quiz did not work
  // either. Under one id the answer is a complete document (§13).
  await ask(page, `${ARTIFACT_REVISION_MARKER} tilføj en quiz om mig`, 1);

  // The panel opens on the model's write and follows it, so the quiz is on
  // screen without the pupil going looking for it (§13, §20).
  const stage = page
    .frameLocator(`iframe[title="${m.artifact_frame_title()}"]`)
    .frameLocator("#stage");
  await expect(stage.locator("#quiz")).toBeVisible({ timeout: 20_000 });
  // And the button the first turn made is still there.
  await expect(stage.locator("#knap")).toHaveText("Klik her");

  const artifactId = await page
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");

  const stored = await (await page.request.get(`/api/artifacts/${artifactId}`)).json();
  expect(stored.key).toBe("klikkeren");
  expect(stored.versions).toHaveLength(2);
  expect(stored.versions[1].authoredBy).toBe("model");

  const revised = await (
    await page.request.get(`/api/artifacts/${artifactId}/versions/${stored.versions[1].id}`)
  ).json();
  expect(revised.files[revised.entry]).toContain("quiz");

  // A different id is a different thing, not a revision of this one.
  await ask(page, `${ARTIFACT_SECOND_MARKER} lav et logo`, 2);
});

test("the transcript card opens what the model built", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await askForArtifact(page);

  // Back to the conversation alone, so the card is what brings it forward again.
  await showChatOnly(page);

  // The transcript shows what was built, not the markup it was written as (§13).
  await expect(page.getByText("<!doctype html>")).toHaveCount(0);
  await page.getByRole("button", { name: m.artifact_card_label({ title: "Klikkeren" }) }).click();

  const stage = page
    .frameLocator(`iframe[title="${m.artifact_frame_title()}"]`)
    .frameLocator("#stage");
  await expect(stage.locator("#knap")).toHaveText("Klik her", { timeout: 20_000 });
});

test("a run's outcome is recorded against the version it ran", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await askForArtifact(page);

  const artifactId = await page
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");
  const read = async () =>
    (await (await page.request.get(`/api/artifacts/${artifactId}`)).json()).versions[0];

  // The panel is open and running the artifact, and reports that outcome itself
  // — which is the feature under test, and the browser is the only party that
  // knows (§13). Wait for it before writing anything: the report is a PATCH like
  // any other, and racing it is how this test read back somebody else's answer.
  await expect.poll(async () => (await read()).buildStatus, { timeout: 30_000 }).toBe("ok");

  // Back to the conversation, so nothing further reports while the failure
  // below is written.
  await showChatOnly(page);

  const versionId = (await read()).id;
  const patched = await page.request.patch(
    `/api/artifacts/${artifactId}/versions/${versionId}`,
    {
      headers: { origin: APP_ORIGIN },
      data: { buildStatus: "failed", buildMessage: "SyntaxError" },
    },
  );
  expect(patched.status()).toBe(200);

  const after = await read();
  expect(after.buildStatus).toBe("failed");
  expect(after.buildMessage).toBe("SyntaxError");

  // A page that mounted and then threw is a third outcome the endpoint takes:
  // the pupil is looking at it, and "did not run" would ask for a rewrite (§13).
  const threw = await page.request.patch(`/api/artifacts/${artifactId}/versions/${versionId}`, {
    headers: { origin: APP_ORIGIN },
    data: { buildStatus: "threw", buildMessage: "TypeError" },
  });
  expect(threw.status()).toBe(200);
  expect((await read()).buildStatus).toBe("threw");

  // A status the schema does not name is refused before it reaches the database.
  const invalid = await page.request.patch(
    `/api/artifacts/${artifactId}/versions/${versionId}`,
    { headers: { origin: APP_ORIGIN }, data: { buildStatus: "exploded" } },
  );
  expect(invalid.status()).toBe(400);
});

test("a build outcome cannot be written to somebody else's artifact", async ({ browser }) => {
  test.setTimeout(120_000);
  const [owner, intruder] = await Promise.all([provisionStudent(), provisionStudent()]);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner.code);
  await askForArtifact(ownerPage);

  const target = await ownerPage
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");
  const stored = await (await ownerPage.request.get(`/api/artifacts/${target}`)).json();
  const versionId = stored.versions[0].id;

  const intruderContext = await browser.newContext();
  const intruderPage = await intruderContext.newPage();
  await signIn(intruderPage, intruder.code);

  // Absent, not forbidden: there is nothing to probe (§21).
  const write = await intruderPage.request.patch(
    `/api/artifacts/${target}/versions/${versionId}`,
    { headers: { origin: APP_ORIGIN }, data: { buildStatus: "failed", buildMessage: "hacked" } },
  );
  expect(write.status()).toBe(404);

  const unauthenticated = await browser.newContext();
  const anonymous = await unauthenticated.newPage();
  const refused = await anonymous.request.patch(
    `/api/artifacts/${target}/versions/${versionId}`,
    { headers: { origin: APP_ORIGIN }, data: { buildStatus: "failed" } },
  );
  expect(refused.status()).toBe(401);

  // And nothing of the intruder's was recorded. The status itself is the owner's
  // own panel reporting its run, so the message is what proves it: only the
  // refused write could have put that word there.
  const after = await (await ownerPage.request.get(`/api/artifacts/${target}`)).json();
  expect(after.versions[0].buildMessage).not.toBe("hacked");

  await ownerContext.close();
  await intruderContext.close();
  await unauthenticated.close();
});

/**
 * An artifact built from several fences, revised one file at a time (PRD §13).
 *
 * The whole economy of a project: the model writes an entry and a stylesheet,
 * the pupil edits one file, and the next turn re-emits only the stylesheet —
 * with the page it did not mention carried through untouched.
 */
test("is built from several fences, edited one file at a time, and revised by one", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await startConversation(page);
  await ask(page, `${ARTIFACT_PROJECT_MARKER} lav et projekt`, 1);

  // The card in the transcript says it is a project, not a file. Scoped to the
  // transcript: the panel's own header says the same thing beside it.
  await expect(
    page.locator("[data-artifact-card]").getByText(m.artifact_files_count({ count: 2 })),
  ).toBeVisible({ timeout: 20_000 });

  // The frame runs the entry with its stylesheet inlined: there is no network in
  // there, so an untouched `<link href>` would silently do nothing (§13).
  const stage = page
    .frameLocator('iframe[title="' + m.artifact_frame_title() + '"]')
    .frameLocator("#stage");
  await expect(stage.locator("#hilsen")).toHaveText("Hej fra projektet", { timeout: 20_000 });
  await expect(stage.locator("#hilsen")).toHaveCSS("color", "rgb(0, 128, 128)");

  // The tree lists both files and the editor opens on the entry.
  await page.getByRole("tab", { name: m.artifact_tab_code() }).click();
  await expect(page.getByRole("tree", { name: m.artifact_file_tree_label() })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("treeitem", { name: /index\.html/ })).toBeVisible();

  // Edit the stylesheet, which is not the entry: the file the pupil picks is
  // the file the editor holds.
  await page.getByRole("treeitem", { name: /styles\.css/ }).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 20_000 });

  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("#hilsen { color: rgb(255, 0, 0) }");
  await page.getByRole("button", { name: m.artifact_run() }).click();

  await expect(stage.locator("#hilsen")).toHaveCSS("color", "rgb(255, 0, 0)", { timeout: 20_000 });

  const artifactId = await page
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");

  // The pupil's revision holds both files: only the stylesheet was posted, and
  // the page it did not mention was carried through (§13).
  const stored = await (await page.request.get(`/api/artifacts/${artifactId}`)).json();
  expect(stored.versions).toHaveLength(2);
  expect(stored.versions[1].authoredBy).toBe("student");
  expect(
    stored.versions[1].files.map((file: { path: string }) => file.path).sort(),
  ).toEqual(["index.html", "styles.css"]);
  // And the history says what it actually changed, which is one file of two.
  expect(
    stored.versions[1].files.filter(
      (file: { change: string }) => file.change !== "unchanged",
    ),
  ).toHaveLength(1);

  const edited = await (
    await page.request.get(`/api/artifacts/${artifactId}/versions/${stored.versions[1].id}`)
  ).json();
  expect(edited.files["index.html"]).toContain("Hej fra projektet");
  expect(edited.files["styles.css"]).toContain("rgb(255, 0, 0)");

  // A second turn that re-emits only the stylesheet: the page survives it.
  //
  // Waited for by the revision rather than by the build count, which is already
  // one and would let the assertions run before the turn had landed.
  await showChatOnly(page);
  await page
    .getByRole("textbox", { name: m.chat_composer_label() })
    .fill(`${ARTIFACT_PROJECT_REVISION_MARKER} skift farven`);
  await page.getByRole("button", { name: m.chat_send() }).click();

  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/artifacts/${artifactId}`)).json()).versions.length,
      { timeout: 30_000 },
    )
    .toBe(3);

  const revised = await (await page.request.get(`/api/artifacts/${artifactId}`)).json();
  expect(revised.versions[2].authoredBy).toBe("model");
  // One file of two, which is the whole economy of it.
  expect(
    revised.versions[2].files.filter((file: { change: string }) => file.change !== "unchanged"),
  ).toHaveLength(1);

  const latest = await (
    await page.request.get(`/api/artifacts/${artifactId}/versions/${revised.versions[2].id}`)
  ).json();
  expect(latest.files["index.html"]).toContain("Hej fra projektet");
  expect(latest.files["styles.css"]).toContain("rgb(128, 0, 128)");
});
