import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateClassroomSettings } from "../db/queries/classrooms";
import * as documentQueries from "../db/queries/documents";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { FileStore } from "../storage/files";
import { createDocument } from "./create";
import { DOCUMENT_LIMITS } from "./formats";

const ROOTS: string[] = [];

function scene() {
  const root = mkdtempSync(join(tmpdir(), "setun-documents-"));
  ROOTS.push(root);
  const db = createTestDatabase();
  const fixtures = seedTestFixtures(db);
  const files = new FileStore(root);
  const base = {
    db,
    files,
    classroomId: fixtures.classroom.id,
    studentId: fixtures.student.id,
    conversationId: null,
  };
  return { db, fixtures, files, root, base };
}

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

function storedFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

describe("createDocument", () => {
  test("renders, stores and records a docx and a csv", async () => {
    const { db, base, files } = scene();

    const docx = await createDocument({
      ...base,
      format: "docx",
      title: "  Fotosyntese  ",
      markdown: "# Fotosyntese\n\nPlanter laver sukker.",
    });
    if (!docx.ok) throw new Error(docx.refusal);
    expect(docx.document).toMatchObject({ title: "Fotosyntese", format: "docx" });
    expect(docx.document.storagePath).toMatch(/^documents\/.+\.docx$/);
    expect((await files.read(docx.document.storagePath))?.byteLength).toBe(docx.byteLength);

    const csv = await createDocument({
      ...base,
      format: "csv",
      title: "Blade",
      markdown: "| Blad | Farve |\n|---|---|\n| Eg | Grøn |",
    });
    if (!csv.ok) throw new Error(csv.refusal);
    expect(csv.document.mediaType).toBe("text/csv");
    expect(csv.document.storagePath).toMatch(/\.csv$/);

    expect(
      documentQueries.listStudentDocuments(db, base.studentId).map((row) => row.format),
    ).toEqual(expect.arrayContaining(["docx", "csv"]));
  });

  test("refuses before any work when the classroom has switched documents off", async () => {
    const { db, base, root } = scene();
    // The turn's snapshot would still say enabled; the database is what counts.
    updateClassroomSettings(db, {
      classroomId: base.classroomId,
      settings: { documentsEnabled: false },
    });

    const result = await createDocument({ ...base, format: "docx", title: "T", markdown: "Text" });
    expect(result).toEqual({ ok: false, refusal: "disabled" });
    expect(storedFiles(root)).toEqual([]);
  });

  test("enforces the title and body caps", async () => {
    const { base } = scene();
    const over = "x".repeat(DOCUMENT_LIMITS.markdownMaxChars + 1);

    for (const input of [
      { title: "", markdown: "Text" },
      { title: "x".repeat(DOCUMENT_LIMITS.titleMaxChars + 1), markdown: "Text" },
      { title: "T", markdown: "   " },
      { title: "T", markdown: over },
    ]) {
      expect(await createDocument({ ...base, format: "docx", ...input })).toEqual({
        ok: false,
        refusal: "invalid",
      });
    }
  });

  test("passes the parser's and the csv renderer's refusals through", async () => {
    const { base } = scene();
    expect(
      await createDocument({ ...base, format: "docx", title: "T", markdown: "<p>html</p>" }),
    ).toEqual({ ok: false, refusal: "empty" });
    expect(
      await createDocument({ ...base, format: "csv", title: "T", markdown: "no table" }),
    ).toEqual({ ok: false, refusal: "needs-one-table" });
  });

  test("removes the written file when the row cannot be recorded", async () => {
    const { base, root } = scene();
    const record = spyOn(documentQueries, "recordGeneratedDocument").mockImplementation(() => {
      throw new Error("disk full");
    });

    try {
      await expect(
        createDocument({ ...base, format: "docx", title: "T", markdown: "Text" }),
      ).rejects.toThrow("disk full");
    } finally {
      record.mockRestore();
    }
    expect(storedFiles(root)).toEqual([]);
  });

  test("renders the largest document the caps allow within a generous bound", async () => {
    const { base } = scene();
    const row = `| ${Array.from({ length: 20 }, (_, i) => `c${i}`).join(" | ")} |\n`;
    const separator = `|${"---|".repeat(20)}\n`;
    let markdown = `${row}${separator}`;
    while (markdown.length + row.length < DOCUMENT_LIMITS.markdownMaxChars) markdown += row;

    const started = performance.now();
    const result = await createDocument({ ...base, format: "docx", title: "T", markdown });
    // Generous on purpose: a slow ARM runner must not turn this into a flake.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(true);
  });
});
