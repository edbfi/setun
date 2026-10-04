import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { APP_ORIGIN, E2E_DATABASE_PATH, E2E_PEPPER } from "../playwright.config";
import { clearLoginWindow } from "./support/login-window";

/**
 * Attachments, image generation and turn responses, at the API (PRD §10, §11,
 * §15, §21, §22).
 *
 * §22 asks for "cross-student attachment access, attachment type and size
 * enforcement" as security coverage, and §21 requires every one of these to be
 * "enforced server-side and verified against direct API access". So nothing here
 * clicks a button: each assertion goes at the endpoint, because hiding a control
 * in the interface is never access control (§8).
 */

/**
 * Appendix A caps one IP at 30 login attempts per 15 minutes, and every worker
 * here is loopback. Cleared per test so the suites do not fail each other's
 * sign-ins; the limiter itself is asserted in `bun test` (§7, §22).
 */
test.beforeEach(clearLoginWindow);

test.describe.configure({ mode: "serial" });

const run = promisify(execFile);

/** This suite reconfigures its own classroom's attachment policy (§22). */
const CLASSROOM = "E2E tools";

const env = {
  ...process.env,
  SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
  SETUN_STUDENT_CODE_PEPPER: E2E_PEPPER,
  SETUN_E2E_CLASSROOM: CLASSROOM,
};

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

async function conversationFor(page: Page): Promise<string> {
  const created = await page.request.post("/api/conversations", {
    data: {},
    headers: { origin: APP_ORIGIN },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).id;
}

/** Upload one file through the real endpoint, exactly as the composer does. */
async function upload(
  page: Page,
  input: { conversationId: string; name: string; bytes: Buffer; mimeType?: string },
) {
  return page.request.post("/api/attachments", {
    // SvelteKit refuses cross-origin form POSTs, and a multipart body is a form
    // body. A browser always sends this header; `page.request` does not unless
    // asked, so the test says what the browser would rather than the endpoint
    // relaxing a protection that is doing its job (§5).
    headers: { origin: APP_ORIGIN },
    multipart: {
      conversationId: input.conversationId,
      file: {
        name: input.name,
        mimeType: input.mimeType ?? "application/octet-stream",
        buffer: input.bytes,
      },
    },
  });
}

const TEXT = Buffer.from("const answer = 42;\n");
/** A one-pixel PNG: a real image, small enough to post inline. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** Bytes that are neither a recognised image nor decodable text. */
const BINARY = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x03]);

test.afterEach(async () => {
  // Leave the classroom in its Appendix A state for whatever runs next.
  await control("restore-attachment-caps");
  await control("restore-attachment-types");
  await control("enable-attachments");
});

test("a text attachment is accepted, stored, and served only to its owner (§10, §21)", async ({
  browser,
}) => {
  const [owner, intruder] = await Promise.all([provisionStudent(), provisionStudent()]);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner.code);
  const conversationId = await conversationFor(ownerPage);

  const uploaded = await upload(ownerPage, {
    conversationId,
    name: "svar.js",
    bytes: TEXT,
    mimeType: "text/plain",
  });
  expect(uploaded.status()).toBe(201);

  const record = await uploaded.json();
  expect(record.kind).toBe("text");
  // The sniffed type, not the type the upload declared (§21).
  expect(record.mediaType).toBe("text/plain");

  // The owner can read it back, under headers that stop a browser sniffing or
  // executing it, and stop another origin reading it at all (§14, §21).
  const own = await ownerPage.request.get(`/api/attachments/${record.id}`);
  expect(own.status()).toBe(200);
  expect(own.headers()["x-content-type-options"]).toBe("nosniff");
  expect(own.headers()["cross-origin-resource-policy"]).toBe("same-origin");
  expect(own.headers()["cache-control"]).toContain("no-store");

  // Another student's attachment is absent, not forbidden — nothing to probe (§21, §22).
  const intruderContext = await browser.newContext();
  const intruderPage = await intruderContext.newPage();
  await signIn(intruderPage, intruder.code);

  const stolen = await intruderPage.request.get(`/api/attachments/${record.id}`);
  expect(stolen.status()).toBe(404);

  // Sent as the browser sends it: a DELETE always carries `Origin` (SvelteKit 3
  // refuses a cross-site write with no Content-Type, so without one this is 403).
  const deleted = await intruderPage.request.delete(`/api/attachments/${record.id}`, {
    headers: { origin: APP_ORIGIN },
  });
  expect(deleted.status()).toBe(404);

  // And it is still there for its owner after the failed attempts.
  expect((await ownerPage.request.get(`/api/attachments/${record.id}`)).status()).toBe(200);

  await ownerContext.close();
  await intruderContext.close();
});

test("an unauthenticated caller cannot upload or read an attachment (§21)", async ({ request }) => {
  // With the origin a browser would send, so what this asserts is the
  // authentication refusal and not the cross-origin one.
  const uploaded = await request.post("/api/attachments", {
    headers: { origin: APP_ORIGIN },
    multipart: {
      conversationId: crypto.randomUUID(),
      file: { name: "a.txt", mimeType: "text/plain", buffer: TEXT },
    },
  });
  expect(uploaded.status()).toBe(401);

  const read = await request.get(`/api/attachments/${crypto.randomUUID()}`);
  expect(read.status()).toBe(401);
});

test("the type allowlist is enforced at the API, whatever the upload claims (§10, §22)", async ({
  page,
}) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const conversationId = await conversationFor(page);

  // Bytes that are nothing the allowlist names, however they are declared.
  const refused = await upload(page, {
    conversationId,
    name: "harmless.txt",
    bytes: BINARY,
    mimeType: "text/plain",
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error).toBe("type-not-allowed");

  // And a real text file is refused once the educator narrows the list.
  await control("images-only-attachments");

  const narrowed = await upload(page, {
    conversationId,
    name: "svar.js",
    bytes: TEXT,
    mimeType: "text/plain",
  });
  expect(narrowed.status()).toBe(422);
  expect((await narrowed.json()).error).toBe("type-not-allowed");
});

test("the size cap is enforced at the API (§10, §22)", async ({ page }) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const conversationId = await conversationFor(page);

  await control("tiny-attachment-caps");

  const refused = await upload(page, {
    conversationId,
    name: "svar.js",
    bytes: TEXT,
    mimeType: "text/plain",
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error).toBe("too-large");
});

test("an image on an alias that cannot see images is refused before any gateway call (§10)", async ({
  page,
}) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const conversationId = await conversationFor(page);

  // The seeded alias carries no image-input capability flag (§9).
  const refused = await upload(page, {
    conversationId,
    name: "billede.png",
    bytes: PNG,
    mimeType: "image/png",
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error).toBe("image-input-not-supported");
});

test("attachments are refused entirely where the classroom has them off (§10)", async ({ page }) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const conversationId = await conversationFor(page);

  await control("disable-attachments");

  const refused = await upload(page, {
    conversationId,
    name: "svar.js",
    bytes: TEXT,
    mimeType: "text/plain",
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error).toBe("attachments-disabled");
});

test("image generation is refused where no alias carries the flag (§15)", async ({ page }) => {
  const { code } = await provisionStudent();
  await signIn(page, code);
  const conversationId = await conversationFor(page);

  const refused = await page.request.post("/api/images", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, prompt: "en kat der koder" },
  });

  expect(refused.status()).toBe(422);
  expect((await refused.json()).error).toBe("no-generation-alias");
});

test("a student cannot answer a permission request on another student's turn (§11, §21)", async ({
  browser,
}) => {
  const [owner, intruder] = await Promise.all([provisionStudent(), provisionStudent()]);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner.code);
  const conversationId = await conversationFor(ownerPage);

  const streamed = await ownerPage.request.post("/api/messages", {
    headers: { origin: APP_ORIGIN },
    data: { conversationId, text: "Forklar loops" },
  });
  expect(streamed.status()).toBe(200);
  const turnId = streamed.headers()["x-setun-turn-id"];
  await streamed.body();

  const intruderContext = await browser.newContext();
  const intruderPage = await intruderContext.newPage();
  await signIn(intruderPage, intruder.code);

  // Another student's turn is absent, so there is no call to approve (§21).
  const answered = await intruderPage.request.post(`/api/turns/${turnId}/respond`, {
    headers: { origin: APP_ORIGIN },
    data: { requestId: crypto.randomUUID(), kind: "permission", approved: true },
  });
  expect(answered.status()).toBe(404);

  await ownerContext.close();
  await intruderContext.close();
});

test("the respond endpoint refuses an unauthenticated caller (§21)", async ({ request }) => {
  const answered = await request.post(`/api/turns/${crypto.randomUUID()}/respond`, {
    headers: { origin: APP_ORIGIN },
    data: { requestId: crypto.randomUUID(), kind: "permission", approved: true },
  });
  expect(answered.status()).toBe(401);
});
