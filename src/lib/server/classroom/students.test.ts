import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAttachmentWithinLimit } from "../db/queries/attachments";
import { getClassroom } from "../db/queries/classrooms";
import { createConversation } from "../db/queries/conversations";
import { appendMessage } from "../db/queries/messages";
import { searchConversations } from "../db/queries/search";
import { createStudent, listClassroomStudents } from "../db/queries/students";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { FileStore } from "../storage/files";
import { classroomDeletionScope, purgeClassroom } from "./students";

/**
 * Deleting a whole classroom (PRD §16, §21).
 *
 * The panel could delete a pupil but never the room they were in, so a
 * classroom set up by mistake stayed on the dashboard for good.
 *
 * The two things the foreign-key cascade cannot reach are what these tests are
 * about: the search index is a virtual table with no foreign keys, so a pupil's
 * text would stay indexed — stored forever and findable by nobody — and the
 * stored bytes are files, which would stay on the volume with nothing pointing
 * at them. Both are the failure mode that looks like success.
 */

/** Temporary directories this file creates, removed once its tests have run. */
const ROOTS: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  ROOTS.push(root);
  return root;
}

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

function store(): FileStore {
  return new FileStore(tempRoot("setun-purge-"));
}

async function populated() {
  const db = createTestDatabase();
  const { classroom, student } = seedTestFixtures(db);

  const conversation = createConversation(db, {
    studentId: student.id,
    modelAliasId: seedTestFixtures(db, { label: "other-fixture" }).alias.id,
  });
  appendMessage(db, {
    conversationId: conversation.id,
    parentId: null,
    role: "user",
    parts: [{ type: "text", text: "en sætning om løkker" }],
  });

  const files = store();
  const stored = await files.write({
    category: "attachments",
    ownerId: student.id,
    extension: "txt",
    bytes: new TextEncoder().encode("noter"),
  });
  recordAttachmentWithinLimit(db, {
    studentId: student.id,
    conversationId: conversation.id,
    filename: "noter.txt",
    kind: "text",
    mediaType: "text/plain",
    byteSize: stored.byteSize,
    storagePath: stored.storagePath,
    maxPerMessage: 5,
  });

  return { db, files, classroom, student, conversation, storagePath: stored.storagePath };
}

describe("classroomDeletionScope (§16)", () => {
  it("counts what a deletion would take, and nothing of what is in it", async () => {
    const { db, classroom } = await populated();

    const scope = classroomDeletionScope(db, classroom.id);

    expect(scope.students).toBe(1);
    expect(scope.conversations).toBe(1);
    expect(scope.creations).toBe(0);
  });

  it("counts a pupil taken off the roster, whose rows go too", async () => {
    const { db, classroom } = await populated();
    createStudent(db, {
      classroomId: classroom.id,
      label: "quiet-heron",
      credentialDigest: crypto.randomUUID(),
      credentialHint: "EFGH",
    });

    expect(classroomDeletionScope(db, classroom.id).students).toBe(2);
  });
});

describe("purgeClassroom (§16, §21)", () => {
  it("removes the classroom and everything that cascades from it", async () => {
    const { db, files, classroom, student } = await populated();

    expect(await purgeClassroom(db, files, classroom.id)).toBe(true);

    expect(getClassroom(db, classroom.id)).toBeUndefined();
    expect(listClassroomStudents(db, classroom.id, { includeRemoved: true })).toHaveLength(0);
    // The search index has no foreign keys, so nothing else would have cleared it.
    expect(searchConversations(db, { studentId: student.id, query: "sætning" })).toHaveLength(0);
  });

  it("removes the stored bytes, which no cascade can reach", async () => {
    const { db, files, classroom, storagePath } = await populated();

    expect(await files.read(storagePath)).not.toBeNull();

    await purgeClassroom(db, files, classroom.id);

    expect(await files.read(storagePath)).toBeNull();
  });

  it("reports a classroom that is not there rather than claiming success", async () => {
    const { db, files } = await populated();

    expect(await purgeClassroom(db, files, crypto.randomUUID())).toBe(false);
  });

  it("records the path of a file it could not remove, which nothing else names now", async () => {
    const { db, files, classroom, storagePath } = await populated();
    // The row naming this path has just cascaded away, so a discarded `false`
    // would leave the bytes on the volume with nothing pointing at them (§16).
    const refuses = { remove: async () => false } as unknown as FileStore;

    const logged: unknown[][] = [];
    const errors = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      logged.push(parts);
    });
    try {
      expect(await purgeClassroom(db, refuses, classroom.id)).toBe(true);
    } finally {
      errors.mockRestore();
    }

    expect(logged).toEqual([["purge left stored files behind", { paths: [storagePath] }]]);
    expect(await files.read(storagePath)).not.toBeNull();
  });
});
