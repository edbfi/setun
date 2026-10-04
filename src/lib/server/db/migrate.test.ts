import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "./client";
import { applyMigrations, MIGRATIONS_FOLDER } from "./migrate";
import { getClassroom } from "./queries/classrooms";

/**
 * Migrations apply to a database that already holds data (PRD §6).
 *
 * Applying them at boot means a broken migration is a failed start, not a failed
 * deploy step — so the committed set has to survive the upgrade path, not merely
 * a fresh `CREATE TABLE`.
 *
 * The trap this exists to catch: SQLite refuses `ALTER TABLE … ADD COLUMN` for a
 * `NOT NULL` column unless the DDL carries a constant default, and it refuses a
 * non-constant one such as `unixepoch()`. Drizzle's `$defaultFn` is applied by
 * the client at insert time and never reaches the DDL, so a column defaulted
 * that way generates a migration that passes on an empty table and fails on a
 * populated one — which is to say, in production only.
 */

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

function readJournal(): { entries: JournalEntry[] } {
  return JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
}

/**
 * A migrations folder holding every migration up to and including `throughIdx`,
 * as an older deployment's image would have shipped.
 */
function migrationsThrough(throughIdx: number, dir: string): string {
  const journal = readJournal();
  const entries = journal.entries.filter((entry) => entry.idx <= throughIdx);

  mkdirSync(join(dir, "meta"), { recursive: true });
  for (const entry of entries) {
    const file = `${entry.tag}.sql`;
    writeFileSync(join(dir, file), readFileSync(join(MIGRATIONS_FOLDER, file), "utf8"));
  }
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));

  return dir;
}

/** One version's only file, read back through the tables `0012` created. */
function sourceOf(db: ReturnType<typeof createDatabase>, versionId: string): string | undefined {
  const row = db.$client
    .query(
      "SELECT b.content AS content FROM artifact_version_file f JOIN artifact_blob b ON b.hash = f.blobHash WHERE f.versionId = ?",
    )
    .get(versionId) as { content: string } | null;

  return row?.content;
}

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

describe("applyMigrations", () => {
  it("upgrades a populated database through every committed migration", () => {
    const journal = readJournal();
    const latest = journal.entries.at(-1);
    if (!latest) throw new Error("the journal has no migrations");
    // Nothing to prove with a single migration; this becomes real from 0001 on.
    expect(journal.entries.length).toBeGreaterThan(1);

    const root = tempRoot("setun-migrate-");
    const db = createDatabase(join(root, "setun.sqlite"));

    // Stand up the schema as it was one migration ago, and put a row in it —
    // the pilot database always has at least the seeded classroom.
    applyMigrations(db, migrationsThrough(latest.idx - 1, join(root, "previous")));
    db.$client.exec(
      "INSERT INTO classroom (id, name, timezone, createdAt, updatedAt) VALUES ('c1', 'Pilotklasse', 'Europe/Copenhagen', 1, 1)",
    );

    expect(() => applyMigrations(db)).not.toThrow();

    // The existing row picks up the Appendix A defaults rather than nulls.
    const upgraded = getClassroom(db, "c1");
    expect(upgraded?.state).toBe("scheduled");
    expect(upgraded?.weeklySchedule).toEqual([]);
    expect(upgraded?.perTurnTokenCap).toBe(100_000);
    expect(upgraded?.perStudentDailyTokens).toBe(250_000);
    expect(upgraded?.costExchangeRate).toBe(7);
    // A classroom that predates the thinking policy leaves the choice to the
    // pupil rather than deciding for them (§20).
    expect(upgraded?.thinkingVisibility).toBe("student");
  });

  it("adds the artifact identity columns to rows that predate them", () => {
    const journal = readJournal();
    const identity = journal.entries.find((entry) => entry.tag.includes("artifact_identity"));
    if (!identity) throw new Error("the artifact identity migration is not in the journal");

    const root = tempRoot("setun-migrate-artifact-");
    const db = createDatabase(join(root, "setun.sqlite"));

    // An artifact and a revision stored by a deployment that had never heard of
    // a fence id: the upgrade must leave them readable and simply unkeyed.
    applyMigrations(db, migrationsThrough(identity.idx - 1, join(root, "previous")));
    db.$client.exec(
      "INSERT INTO classroom (id, name, timezone, createdAt, updatedAt) VALUES ('c1', 'Pilotklasse', 'Europe/Copenhagen', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO student (id, classroomId, label, credentialDigest, credentialHint, createdAt, updatedAt) VALUES ('s1', 'c1', 'quiet-fox', 'x', 'y', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO artifact (id, studentId, language, createdAt, updatedAt) VALUES ('a1', 's1', 'html', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO artifact_version (id, artifactId, revision, source, authoredBy, createdAt) VALUES ('v1', 'a1', 1, '<p>en</p>', 'model', 1)",
    );

    expect(() => applyMigrations(db)).not.toThrow();

    const artifact = db.$client.query("SELECT key FROM artifact WHERE id = 'a1'").get() as {
      key: string | null;
    };
    const version = db.$client
      .query("SELECT buildStatus, buildMessage, entryPath FROM artifact_version WHERE id = 'v1'")
      .get() as { buildStatus: string | null; buildMessage: string | null; entryPath: string };

    expect(artifact.key).toBeNull();
    expect(version.buildStatus).toBeNull();
    expect(version.buildMessage).toBeNull();
    // The single source became a one-file project at its language's usual path.
    expect(version.entryPath).toBe("index.html");
    expect(sourceOf(db, "v1")).toBe("<p>en</p>");
  });

  it("leaves a version that predates the language column unattributed", () => {
    const journal = readJournal();
    const entry = journal.entries.find((item) => item.tag.includes("version_language"));
    if (!entry) throw new Error("the version language migration is not in the journal");

    const root = tempRoot("setun-migrate-language-");
    const db = createDatabase(join(root, "setun.sqlite"));

    applyMigrations(db, migrationsThrough(entry.idx - 1, join(root, "previous")));
    db.$client.exec(
      "INSERT INTO classroom (id, name, timezone, createdAt, updatedAt) VALUES ('c1', 'Pilotklasse', 'Europe/Copenhagen', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO student (id, classroomId, label, credentialDigest, credentialHint, createdAt, updatedAt) VALUES ('s1', 'c1', 'quiet-fox', 'x', 'y', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO artifact (id, studentId, language, createdAt, updatedAt) VALUES ('a1', 's1', 'html', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO artifact_version (id, artifactId, revision, source, authoredBy, createdAt) VALUES ('v1', 'a1', 1, '<p>en</p>', 'model', 1)",
    );

    expect(() => applyMigrations(db)).not.toThrow();

    const version = db.$client
      .query("SELECT language FROM artifact_version WHERE id = 'v1'")
      .get() as { language: string | null };

    // Null and not backfilled: a row that predates the column really is unknown,
    // and `effectiveLanguage` reads it as "whatever the artifact says" (§13).
    expect(version.language).toBeNull();
    expect(sourceOf(db, "v1")).toBe("<p>en</p>");
  });

  /**
   * An artifact becomes a small project of files (§13).
   *
   * The one migration in this repository that recreates a table and copies data
   * through it, so the assertions are about the copy as much as about the shape:
   * every revision must come out as a one-file project at the path its own tag
   * implies, with its content intact and its foreign keys sound.
   */
  it("turns every existing revision into a one-file project", () => {
    const journal = readJournal();
    const entry = journal.entries.find((item) => item.tag.includes("artifact_project_files"));
    if (!entry) throw new Error("the artifact project migration is not in the journal");

    const root = tempRoot("setun-migrate-project-");
    const db = createDatabase(join(root, "setun.sqlite"));

    applyMigrations(db, migrationsThrough(entry.idx - 1, join(root, "previous")));
    db.$client.exec(
      "INSERT INTO classroom (id, name, timezone, createdAt, updatedAt) VALUES ('c1', 'Pilotklasse', 'Europe/Copenhagen', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO student (id, classroomId, label, credentialDigest, credentialHint, createdAt, updatedAt) VALUES ('s1', 'c1', 'quiet-fox', 'x', 'y', 1, 1)",
    );
    // Three shapes the pilot database really holds: a plain html artifact, one
    // whose revision predates the language column, and one whose revision was
    // written under a different tag from the row's current one.
    db.$client.exec(
      "INSERT INTO artifact (id, studentId, language, createdAt, updatedAt) VALUES ('a1', 's1', 'html', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO artifact (id, studentId, language, createdAt, updatedAt) VALUES ('a2', 's1', 'svelte', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO artifact (id, studentId, language, createdAt, updatedAt) VALUES ('a3', 's1', 'svelte', 1, 1)",
    );
    db.$client.exec(
      "INSERT INTO artifact_version (id, artifactId, revision, source, language, authoredBy, createdAt) VALUES ('v1', 'a1', 1, '<p>en</p>', 'html', 'model', 1)",
    );
    db.$client.exec(
      "INSERT INTO artifact_version (id, artifactId, revision, source, authoredBy, createdAt) VALUES ('v2', 'a2', 1, '<h1>arvet</h1>', 'model', 1)",
    );
    db.$client.exec(
      "INSERT INTO artifact_version (id, artifactId, revision, source, language, authoredBy, createdAt) VALUES ('v3', 'a3', 1, 'export default function App() {}', 'tsx', 'model', 1)",
    );

    expect(() => applyMigrations(db)).not.toThrow();

    const paths = db.$client
      .query("SELECT versionId, path FROM artifact_version_file ORDER BY versionId")
      .all() as { versionId: string; path: string }[];

    expect(paths).toEqual([
      { versionId: "v1", path: "index.html" },
      // No language of its own, so the artifact's tag decides — the same
      // fallback `effectiveLanguage` applies everywhere else (§13).
      { versionId: "v2", path: "App.svelte" },
      // Its own tag, not the row's: restoring it must not run tsx as Svelte.
      { versionId: "v3", path: "App.tsx" },
    ]);

    expect(sourceOf(db, "v1")).toBe("<p>en</p>");
    expect(sourceOf(db, "v2")).toBe("<h1>arvet</h1>");
    expect(sourceOf(db, "v3")).toBe("export default function App() {}");

    // The recreate ran with foreign keys on, so nothing may dangle.
    expect(db.$client.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // And the column it replaced is gone rather than left beside its successor.
    const columns = db.$client.query("PRAGMA table_info(artifact_version)").all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toContain("entryPath");
    expect(columns.map((column) => column.name)).not.toContain("source");
  });

  it("is idempotent — a second application changes nothing", () => {
    const root = tempRoot("setun-migrate-");
    const db = createDatabase(join(root, "setun.sqlite"));

    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
  });
});
