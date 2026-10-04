import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../db/client";
import { applyMigrations } from "../db/migrate";
import { createClassroom, listClassrooms } from "../db/queries/classrooms";
import { runBackup, snapshotDay, snapshotName, storageSnapshotName } from "./backup";

/**
 * The nightly snapshot (PRD §21, Appendix A).
 *
 * §21 asks for "SQLite online backup via `VACUUM INTO` plus the images and
 * skills directories, last 14 days retained on the volume". Skill bodies and
 * resources are database columns in this implementation (§19), so what lives
 * outside the database is the storage tree, and the tests below check that the
 * snapshot is a database another connection can read, that the storage tree
 * travels with it, and that the fourteen-day window is by name rather than by
 * mtime — a restored volume carries whatever mtimes the copy gave it.
 */

const TIMEZONE = "Europe/Copenhagen";

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

function workspace() {
  const root = tempRoot("setun-backup-");
  const storagePath = join(root, "storage");
  const backupPath = join(root, "backups");
  mkdirSync(join(storagePath, "images"), { recursive: true });
  writeFileSync(join(storagePath, "images", "one.png"), "not really a png");

  const db = createDatabase(join(root, "setun.sqlite"));
  applyMigrations(db);
  createClassroom(db, { name: "7.B" });

  return { db, storagePath, backupPath };
}

describe("snapshot naming", () => {
  it("names a snapshot by its day, sortably", () => {
    expect(snapshotName("2026-08-25")).toBe("setun-2026-08-25.sqlite");
    expect(storageSnapshotName("2026-08-25")).toBe("storage-2026-08-25");
  });

  it("reads the day back out of either name, and ignores anything else", () => {
    expect(snapshotDay("setun-2026-08-25.sqlite")).toBe("2026-08-25");
    expect(snapshotDay("storage-2026-08-25")).toBe("2026-08-25");
    expect(snapshotDay("operator-notes.txt")).toBeNull();
    expect(snapshotDay("setun.sqlite")).toBeNull();
  });
});

describe("runBackup", () => {
  it("writes a readable snapshot and copies the storage tree", async () => {
    const { db, storagePath, backupPath } = workspace();

    const outcome = await runBackup(
      { db, storagePath, backupPath, timezone: TIMEZONE },
      new Date("2026-08-25T03:30:00+02:00"),
    );

    expect(outcome).toMatchObject({ day: "2026-08-25", created: true });

    // A snapshot is only a backup if another connection can open it.
    const restored = createDatabase(join(backupPath, snapshotName("2026-08-25")));
    expect(listClassrooms(restored)).toHaveLength(1);

    expect(readdirSync(join(backupPath, storageSnapshotName("2026-08-25"), "images"))).toEqual([
      "one.png",
    ]);
  });

  it("waits until the backup hour, in the backup timezone", async () => {
    const { db, storagePath, backupPath } = workspace();

    const outcome = await runBackup(
      { db, storagePath, backupPath, timezone: TIMEZONE },
      new Date("2026-08-25T01:30:00+02:00"),
    );

    expect(outcome.created).toBe(false);
    expect(readdirSync(backupPath)).toEqual([]);
  });

  it("takes one snapshot a night however often it ticks", async () => {
    const { db, storagePath, backupPath } = workspace();
    const options = { db, storagePath, backupPath, timezone: TIMEZONE };

    await runBackup(options, new Date("2026-08-25T03:30:00+02:00"));
    const second = await runBackup(options, new Date("2026-08-25T04:30:00+02:00"));

    expect(second.created).toBe(false);
    expect(readdirSync(backupPath).filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
  });

  it("finishes a night whose storage half never landed", async () => {
    const { db, storagePath, backupPath } = workspace();
    const options = { db, storagePath, backupPath, timezone: TIMEZONE };

    await runBackup(options, new Date("2026-08-25T03:30:00+02:00"));
    // What a run that died — or whose copy failed — after `VACUUM INTO` leaves
    // behind: the database half of the night, and nothing else.
    rmSync(join(backupPath, storageSnapshotName("2026-08-25")), { recursive: true, force: true });

    const second = await runBackup(options, new Date("2026-08-25T04:30:00+02:00"));

    expect(second.created).toBe(true);
    expect(readdirSync(join(backupPath, storageSnapshotName("2026-08-25"), "images"))).toEqual([
      "one.png",
    ]);
    // Still one night, and nothing left half-written.
    expect(readdirSync(backupPath).filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
    expect(readdirSync(backupPath).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("does not call a night complete when the storage tree cannot be read", async () => {
    const { db, backupPath } = workspace();

    // A file where a directory should be: `stat` fails with ENOTDIR rather than
    // ENOENT, which is "cannot tell", not "there is nothing to copy".
    const root = tempRoot("setun-backup-");
    writeFileSync(join(root, "storage"), "not a directory");
    const storagePath = join(root, "storage", "tree");

    await expect(
      runBackup(
        { db, storagePath, backupPath, timezone: TIMEZONE },
        new Date("2026-08-25T03:30:00+02:00"),
      ),
    ).rejects.toThrow();

    // Nothing published, so the night is still due on the next tick.
    expect(readdirSync(backupPath)).toEqual([]);
  });

  it("refuses a backup path that lives inside the storage tree", async () => {
    const { db, storagePath } = workspace();

    // `cp` would refuse this too, but only from inside the copy and only after
    // the database snapshot had been written.
    await expect(
      runBackup(
        { db, storagePath, backupPath: join(storagePath, "backups"), timezone: TIMEZONE },
        new Date("2026-08-25T03:30:00+02:00"),
      ),
    ).rejects.toThrow(/separate trees/);
  });

  it("retains the last fourteen days and prunes older snapshots", async () => {
    const { db, storagePath, backupPath } = workspace();
    mkdirSync(backupPath, { recursive: true });

    // A fortnight of nights, plus one older than the window, plus a file the
    // operator put there that this job must never touch.
    for (const day of ["2026-08-11", "2026-08-12", "2026-08-01"]) {
      writeFileSync(join(backupPath, snapshotName(day)), "");
      mkdirSync(join(backupPath, storageSnapshotName(day)), { recursive: true });
    }
    writeFileSync(join(backupPath, "operator-notes.txt"), "restore rehearsal 2026-08-20");

    const outcome = await runBackup(
      { db, storagePath, backupPath, timezone: TIMEZONE },
      new Date("2026-08-25T03:30:00+02:00"),
    );

    // Fourteen days back from the 25th keeps the 12th; the 11th falls out.
    expect(outcome.pruned).toEqual([
      snapshotName("2026-08-01"),
      snapshotName("2026-08-11"),
      storageSnapshotName("2026-08-01"),
      storageSnapshotName("2026-08-11"),
    ]);

    const remaining = readdirSync(backupPath).sort();
    expect(remaining).toContain("operator-notes.txt");
    expect(remaining).toContain(snapshotName("2026-08-12"));
    expect(remaining).toContain(snapshotName("2026-08-25"));
  });
});
