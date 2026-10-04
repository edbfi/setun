import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSnapshot, createArtifact, snapshotOf } from "../db/queries/artifacts";
import { recordAttachmentWithinLimit } from "../db/queries/attachments";
import { deleteClassroom, updateClassroomSettings } from "../db/queries/classrooms";
import { createConversation } from "../db/queries/conversations";
import { recordGeneratedImage } from "../db/queries/images";
import { appendMessage } from "../db/queries/messages";
import { searchConversations } from "../db/queries/search";
import { createSessionRow } from "../db/queries/sessions";
import { deleteStudent } from "../db/queries/students";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { FileStore } from "../storage/files";
import { retentionCutoffs, runRetention } from "./retention";
import { sweepSessions } from "./sessions";

/**
 * Retention (PRD §16, §21).
 *
 * The two policies are separate on purpose, and the second test is the one that
 * matters: a classroom that has set no creations period keeps its pupils' work,
 * however old the conversation that produced it was.
 */

const NOW = new Date("2026-08-25T10:00:00Z");

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
  return new FileStore(tempRoot("setun-retention-"));
}

/** Backdate a row the schema stamps on insert. */
function backdate(db: ReturnType<typeof createTestDatabase>, sql: string, at: Date, id: string) {
  db.$client.query(sql).run(at.getTime(), id);
}

describe("retentionCutoffs", () => {
  it("subtracts the classroom's conversation policy", () => {
    const cutoffs = retentionCutoffs(
      { conversationRetentionDays: 30, creationRetentionDays: null },
      NOW,
    );
    expect(cutoffs.conversationsBefore).toEqual(new Date("2026-07-26T10:00:00Z"));
  });

  it("has no creations cut-off unless the classroom set one — the §16 default", () => {
    expect(
      retentionCutoffs({ conversationRetentionDays: 30, creationRetentionDays: null }, NOW)
        .creationsBefore,
    ).toBeNull();

    expect(
      retentionCutoffs({ conversationRetentionDays: 30, creationRetentionDays: 90 }, NOW)
        .creationsBefore,
    ).toEqual(new Date("2026-05-27T10:00:00Z"));
  });
});

describe("runRetention", () => {
  it.each(["expiry", "student", "classroom"] as const)(
    "sweeps orphan artifact blobs after %s deletion and preserves shared content",
    async (mode) => {
      const db = createTestDatabase();
      const doomed = seedTestFixtures(db);
      const kept = seedTestFixtures(db);
      const revisions = [doomed, kept].map(({ student }, at) => {
        const artifact = createArtifact(db, { studentId: student.id, language: "html" });
        const version = appendSnapshot(db, {
          artifactId: artifact.id,
          entry: "index.html",
          files: { "index.html": `page ${at}`, "styles.css": "shared" },
          authoredBy: "model",
        });
        return { artifact, version };
      });

      if (mode === "expiry") {
        updateClassroomSettings(db, {
          classroomId: doomed.classroom.id,
          settings: { creationRetentionDays: 30 },
        });
        backdate(
          db,
          "UPDATE artifact SET updatedAt = ? WHERE id = ?",
          new Date("2026-01-01T00:00:00Z"),
          revisions[0].artifact.id,
        );
      } else if (mode === "student") {
        deleteStudent(db, { studentId: doomed.student.id, classroomId: doomed.classroom.id });
      } else {
        deleteClassroom(db, doomed.classroom.id);
      }

      await runRetention(db, store(), NOW);

      expect(snapshotOf(db, revisions[0].version.id)).toBeNull();
      expect(snapshotOf(db, revisions[1].version.id)?.files).toEqual({
        "index.html": "page 1",
        "styles.css": "shared",
      });
      expect(db.$client.query("SELECT count(*) AS n FROM artifact_blob").get()).toEqual({ n: 2 });
    },
  );

  it("deletes an expired conversation, its messages and its search index entry", async () => {
    const db = createTestDatabase();
    const { student, alias } = seedTestFixtures(db);

    const old = createConversation(db, { studentId: student.id, modelAliasId: alias.id });
    appendMessage(db, {
      conversationId: old.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "grundstoffer i det periodiske system" }],
    });
    backdate(
      db,
      "UPDATE conversation SET updatedAt = ? WHERE id = ?",
      new Date("2026-06-01T10:00:00Z"),
      old.id,
    );

    const outcome = await runRetention(db, store(), NOW);

    expect(outcome.conversations).toBe(1);
    expect(searchConversations(db, { studentId: student.id, query: "grundstoffer" })).toEqual([]);
    expect(db.$client.query("SELECT count(*) as n FROM message").get()).toEqual({ n: 0 });
  });

  it("leaves a conversation inside the policy alone", async () => {
    const db = createTestDatabase();
    const { student, alias } = seedTestFixtures(db);
    createConversation(db, { studentId: student.id, modelAliasId: alias.id });

    expect((await runRetention(db, store(), NOW)).conversations).toBe(0);
  });

  it("keeps creations when the classroom sets no creations period (§16)", async () => {
    const db = createTestDatabase();
    const { student, alias, classroom } = seedTestFixtures(db);

    const conversation = createConversation(db, {
      studentId: student.id,
      modelAliasId: alias.id,
    });
    const image = recordGeneratedImage(db, {
      studentId: student.id,
      conversationId: conversation.id,
      prompt: "en vulkan",
      mediaType: "image/png",
      storagePath: `images/${student.id}/${crypto.randomUUID()}.png`,
    });
    backdate(
      db,
      "UPDATE generated_image SET createdAt = ? WHERE id = ?",
      new Date("2024-01-01T10:00:00Z"),
      image.id,
    );
    backdate(
      db,
      "UPDATE conversation SET updatedAt = ? WHERE id = ?",
      new Date("2026-06-01T10:00:00Z"),
      conversation.id,
    );

    const kept = await runRetention(db, store(), NOW);
    expect(kept.conversations).toBe(1);
    expect(kept.images).toBe(0);

    // The same image goes once a period is set — the policy, not the age, decides.
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { creationRetentionDays: 90 },
    });
    expect((await runRetention(db, store(), NOW)).images).toBe(1);
  });

  it("keeps an expired conversation whose attachment bytes could not be removed", async () => {
    const db = createTestDatabase();
    const { student, alias } = seedTestFixtures(db);

    const root = tempRoot("setun-retention-");
    const expire = (id: string) =>
      backdate(
        db,
        "UPDATE conversation SET updatedAt = ? WHERE id = ?",
        new Date("2026-06-01T10:00:00Z"),
        id,
      );

    const stuck = createConversation(db, { studentId: student.id, modelAliasId: alias.id });
    const storagePath = `attachments/${student.id}/${crypto.randomUUID()}.txt`;
    // A directory where the file should be: `unlink` refuses it, which is what
    // a permission or I/O failure looks like from the job's side.
    mkdirSync(join(root, storagePath), { recursive: true });
    recordAttachmentWithinLimit(db, {
      studentId: student.id,
      conversationId: stuck.id,
      kind: "text",
      mediaType: "text/plain",
      filename: "noter.txt",
      byteSize: 4,
      storagePath,
      maxPerMessage: 4,
    });
    expire(stuck.id);

    const clean = createConversation(db, { studentId: student.id, modelAliasId: alias.id });
    expire(clean.id);

    const outcome = await runRetention(db, new FileStore(root), NOW);

    // Only the conversation whose bytes are gone; the other keeps the row that
    // still names the file, so the next hourly pass can try again.
    expect(outcome).toMatchObject({ conversations: 1, files: 0 });
    expect(db.$client.query("SELECT id FROM conversation").all()).toEqual([{ id: stuck.id }]);
    expect(db.$client.query("SELECT count(*) as n FROM attachment").get()).toEqual({ n: 1 });
  });

  it("keeps an expired conversation that gained an attachment while the pass ran", async () => {
    const db = createTestDatabase();
    const { student, alias } = seedTestFixtures(db);

    const conversation = createConversation(db, { studentId: student.id, modelAliasId: alias.id });
    backdate(
      db,
      "UPDATE conversation SET updatedAt = ? WHERE id = ?",
      new Date("2026-06-01T10:00:00Z"),
      conversation.id,
    );

    // The upload lands after the job has read the attachment list — here, from
    // inside `remove`, which is the only await between the read and the delete.
    const root = tempRoot("setun-retention-");
    const files = new FileStore(root);
    const late = {
      remove: async (storagePath: string) => {
        recordAttachmentWithinLimit(db, {
          studentId: student.id,
          conversationId: conversation.id,
          kind: "text",
          mediaType: "text/plain",
          filename: "sent-mens-passet-kørte.txt",
          byteSize: 4,
          storagePath: `attachments/${student.id}/${crypto.randomUUID()}.txt`,
          maxPerMessage: 4,
        });
        return files.remove(storagePath);
      },
    } as unknown as FileStore;

    recordAttachmentWithinLimit(db, {
      studentId: student.id,
      conversationId: conversation.id,
      kind: "text",
      mediaType: "text/plain",
      filename: "noter.txt",
      byteSize: 4,
      storagePath: `attachments/${student.id}/${crypto.randomUUID()}.txt`,
      maxPerMessage: 4,
    });

    const outcome = await runRetention(db, late, NOW);

    // The conversation survives rather than cascading the new row away with its
    // bytes still on the volume; the next pass reads that attachment normally.
    expect(outcome.conversations).toBe(0);
    expect(db.$client.query("SELECT count(*) as n FROM conversation").get()).toEqual({ n: 1 });
    expect(db.$client.query("SELECT count(*) as n FROM attachment").get()).toEqual({ n: 1 });
  });

  it("keeps a creation whose bytes could not be removed, so the next pass retries", async () => {
    const db = createTestDatabase();
    const { student, classroom } = seedTestFixtures(db);
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { creationRetentionDays: 90 },
    });

    const root = tempRoot("setun-retention-");
    const storagePath = `images/${student.id}/${crypto.randomUUID()}.png`;
    // A directory where the file should be: `unlink` refuses it, which is what
    // a permission or I/O failure looks like from the job's side.
    mkdirSync(join(root, storagePath), { recursive: true });

    const image = recordGeneratedImage(db, {
      studentId: student.id,
      prompt: "en vulkan",
      mediaType: "image/png",
      storagePath,
    });
    backdate(
      db,
      "UPDATE generated_image SET createdAt = ? WHERE id = ?",
      new Date("2024-01-01T10:00:00Z"),
      image.id,
    );

    const outcome = await runRetention(db, new FileStore(root), NOW);

    // The row is the only record of where those bytes are, so it stays.
    expect(outcome).toMatchObject({ images: 0, files: 0 });
    expect(db.$client.query("SELECT count(*) as n FROM generated_image").get()).toEqual({ n: 1 });
  });
});

describe("sweepSessions", () => {
  it("removes long-expired rows and keeps live ones", () => {
    const db = createTestDatabase();
    const { student } = seedTestFixtures(db);

    createSessionRow(db, {
      tokenDigest: "dead",
      ownerKind: "student",
      ownerId: student.id,
      expiresAt: new Date("2026-08-01T10:00:00Z"),
      createdAt: new Date("2026-07-01T10:00:00Z"),
    });
    createSessionRow(db, {
      tokenDigest: "live",
      ownerKind: "student",
      ownerId: student.id,
      expiresAt: new Date("2026-09-01T10:00:00Z"),
      createdAt: NOW,
    });

    expect(sweepSessions(db, NOW)).toBe(1);
    expect(db.$client.query("SELECT count(*) as n FROM session").get()).toEqual({ n: 1 });
  });

  it("keeps a row that expired inside the grace period", () => {
    const db = createTestDatabase();
    const { student } = seedTestFixtures(db);

    createSessionRow(db, {
      tokenDigest: "recent",
      ownerKind: "student",
      ownerId: student.id,
      expiresAt: new Date("2026-08-24T23:00:00Z"),
      createdAt: new Date("2026-08-10T10:00:00Z"),
    });

    expect(sweepSessions(db, NOW)).toBe(0);
  });
});
