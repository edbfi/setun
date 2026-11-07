import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteOwnedDocument,
  getOwnedDocument,
  recordGeneratedDocument,
} from "../db/queries/documents";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { FileStore } from "../storage/files";
import { removeOwnedDocument } from "./remove";

const ROOTS: string[] = [];

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

async function scene() {
  const root = mkdtempSync(join(tmpdir(), "setun-documents-remove-"));
  ROOTS.push(root);
  const db = createTestDatabase();
  const owner = seedTestFixtures(db, { label: "brave-otter", digest: "a" });
  const intruder = seedTestFixtures(db, { label: "keen-lynx", digest: "b" });
  const files = new FileStore(root);

  const stored = await files.write({
    category: "documents",
    ownerId: owner.student.id,
    bytes: new TextEncoder().encode("A\r\n1\r\n"),
    extension: "csv",
  });
  const document = recordGeneratedDocument(db, {
    studentId: owner.student.id,
    title: "Blade",
    format: "csv",
    mediaType: "text/csv",
    storagePath: stored.storagePath,
  });

  return { db, files, root, owner, intruder, document };
}

describe("owner scoping", () => {
  test("another pupil can neither read nor delete a document", async () => {
    const { db, owner, intruder, document } = await scene();
    const theirs = { documentId: document.id, studentId: intruder.student.id };

    expect(getOwnedDocument(db, theirs)).toBeUndefined();
    expect(deleteOwnedDocument(db, theirs)).toBe(false);
    expect(
      getOwnedDocument(db, { documentId: document.id, studentId: owner.student.id }),
    ).toBeDefined();
  });
});

describe("removeOwnedDocument", () => {
  test("removes the bytes and then the row", async () => {
    const { db, files, owner, document } = await scene();
    const own = { documentId: document.id, studentId: owner.student.id };

    expect(await removeOwnedDocument(db, files, own)).toBe("deleted");
    expect(await files.read(document.storagePath)).toBeNull();
    expect(getOwnedDocument(db, own)).toBeUndefined();
  });

  test("answers somebody else's id as deleted and touches nothing", async () => {
    const { db, files, intruder, document } = await scene();

    expect(
      await removeOwnedDocument(db, files, {
        documentId: document.id,
        studentId: intruder.student.id,
      }),
    ).toBe("deleted");
    expect(await files.read(document.storagePath)).not.toBeNull();
  });

  test("keeps the row when the bytes could not be removed", async () => {
    const { db, root, owner } = await scene();
    const storagePath = `documents/${owner.student.id}/${crypto.randomUUID()}.docx`;
    // A directory where the file should be: `unlink` refuses it.
    mkdirSync(join(root, storagePath), { recursive: true });
    const stuck = recordGeneratedDocument(db, {
      studentId: owner.student.id,
      title: "T",
      format: "docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      storagePath,
    });
    const own = { documentId: stuck.id, studentId: owner.student.id };

    expect(await removeOwnedDocument(db, new FileStore(root), own)).toBe("failed");
    expect(getOwnedDocument(db, own)).toBeDefined();
  });
});
