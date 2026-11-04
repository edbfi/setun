import { beforeEach, describe, expect, it } from "bun:test";
import { attemptEducatorLogin } from "../auth/educator";
import type { AppDatabase } from "../db/client";
import { listClassroomAliases } from "../db/queries/classroom-aliases";
import { listClassrooms } from "../db/queries/classrooms";
import { getFirstEducator } from "../db/queries/educators";
import { readInstance } from "../db/queries/instance";
import { getUtilityAlias, listAliases } from "../db/queries/model-aliases";
import { classroomModelAlias } from "../db/schema";
import { createTestDatabase } from "../db/testing";
import { resolveSetupProgress } from "./state";
import {
  finishSetup,
  provisionFirstStudents,
  saveAlias,
  saveClassroom,
  saveEducator,
} from "./steps";

/**
 * What each wizard step writes, and what it must not write twice
 * (plan 6.1, PRD §6.2, §7, §8, §9, §16, §22).
 *
 * The load-bearing claim in this module is idempotence: going back and editing
 * a step updates the row that step created rather than inserting a second one.
 * A wizard that quietly produced two model aliases or two classrooms would look
 * fine on the screen and be wrong in the panel afterwards.
 */

let db: AppDatabase;

const progress = () => resolveSetupProgress(db, { educatorSeeded: false });

const ALIAS = {
  name: "Balanceret",
  gatewayModelId: "gpt-5",
  dialect: "openai" as const,
  available: true,
  dataProtection: true,
  supportsImageInput: false,
  supportsImageGeneration: false,
  inputPricePerMillion: null,
  outputPricePerMillion: null,
  contextWindowTokens: null,
  isUtility: false,
};

const CLASSROOM = {
  name: "7.B",
  timezone: "Europe/Copenhagen",
  interfaceLanguage: "da" as const,
  sessionPolicy: "sliding" as const,
  sessionSlidingDays: 14,
  confirmNoDpa: false,
};

beforeEach(() => {
  db = createTestDatabase();
});

describe("saveEducator", () => {
  it("creates the account and hashes the password with argon2id", async () => {
    await saveEducator(db, { username: "laerer", password: "korrekt-hest-batteri" });

    const educator = getFirstEducator(db);
    expect(educator?.username).toBe("laerer");
    expect(educator?.passwordHash).toStartWith("$argon2id$");
    expect(educator?.passwordHash).not.toContain("korrekt-hest-batteri");
  });

  /**
   * The claim can be seized by `recoverClaim` while this step is hashing, and
   * the write *replaces* the operator credential — so a guard that only ran
   * before the hash would let a revoked browser take the account with it.
   */
  it("writes nothing when the claim is withdrawn while the password is hashing", async () => {
    await saveEducator(db, { username: "laerer", password: "korrekt-hest-batteri" });
    const before = getFirstEducator(db);

    const refused = await saveEducator(db, {
      username: "overtager",
      password: "et-andet-langt-kodeord",
      stillAuthorised: () => false,
    });

    expect(refused).toBeNull();
    expect(getFirstEducator(db)).toEqual(before);
    expect(
      (await attemptEducatorLogin(db, { username: "laerer", password: "korrekt-hest-batteri" })).ok,
    ).toBe(true);
  });

  it("writes as usual when the claim still holds", async () => {
    const educator = await saveEducator(db, {
      username: "laerer",
      password: "korrekt-hest-batteri",
      stillAuthorised: () => true,
    });

    expect(educator?.username).toBe("laerer");
    expect(getFirstEducator(db)?.username).toBe("laerer");
  });

  it("edits the one account rather than adding a second when the step is re-run", async () => {
    await saveEducator(db, { username: "laerer", password: "korrekt-hest-batteri" });
    await saveEducator(db, { username: "underviser", password: "et-andet-langt-kodeord" });

    const rows = db.$client.query("SELECT username FROM educator").all() as { username: string }[];
    expect(rows).toEqual([{ username: "underviser" }]);

    expect(
      (
        await attemptEducatorLogin(db, {
          username: "underviser",
          password: "et-andet-langt-kodeord",
        })
      ).ok,
    ).toBe(true);
  });
});

describe("saveAlias", () => {
  it("creates the alias and designates it the utility alias", () => {
    const alias = saveAlias(db, { progress: progress(), values: ALIAS });

    expect(getUtilityAlias(db)?.id).toBe(alias.id);
  });

  it("updates the alias it created rather than inserting a second one", () => {
    const first = saveAlias(db, { progress: progress(), values: ALIAS });
    const second = saveAlias(db, {
      progress: progress(),
      values: { ...ALIAS, name: "Hurtig", gatewayModelId: "gpt-5-mini" },
    });

    expect(second.id).toBe(first.id);
    expect(listAliases(db)).toHaveLength(1);
    expect(second.name).toBe("Hurtig");
  });
});

describe("saveClassroom", () => {
  it("creates the class and allowlists the step-3 alias for it", () => {
    const alias = saveAlias(db, { progress: progress(), values: ALIAS });
    const result = saveClassroom(db, { progress: progress(), alias, values: CLASSROOM });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(listClassroomAliases(db, result.classroom.id).map((row) => row.id)).toEqual([alias.id]);
    expect(result.classroom.timezone).toBe("Europe/Copenhagen");
    expect(result.classroom.interfaceLanguage).toBe("da");
  });

  it("refuses an alias with no data processing agreement until it is acknowledged (§16)", () => {
    const alias = saveAlias(db, {
      progress: progress(),
      values: { ...ALIAS, dataProtection: false },
    });

    const refused = saveClassroom(db, { progress: progress(), alias, values: CLASSROOM });
    expect(refused).toEqual({ ok: false, reason: "no_dpa_unconfirmed" });
    expect(listClassrooms(db)).toHaveLength(0);

    const confirmed = saveClassroom(db, {
      progress: progress(),
      alias,
      values: { ...CLASSROOM, confirmNoDpa: true },
    });
    expect(confirmed.ok).toBe(true);

    // The acknowledgement is recorded, not merely displayed in a dialog (§16).
    const rows = db.select().from(classroomModelAlias).all();
    expect(rows[0]?.noDpaConfirmedAt).not.toBeNull();
  });

  it("updates the class it created rather than opening a second one", () => {
    const alias = saveAlias(db, { progress: progress(), values: ALIAS });
    saveClassroom(db, { progress: progress(), alias, values: CLASSROOM });
    const second = saveClassroom(db, {
      progress: progress(),
      alias,
      values: { ...CLASSROOM, name: "8.A", interfaceLanguage: "en" },
    });

    expect(second.ok).toBe(true);
    expect(listClassrooms(db)).toHaveLength(1);
    expect(listClassrooms(db)[0]?.name).toBe("8.A");
    expect(listClassrooms(db)[0]?.interfaceLanguage).toBe("en");
  });

  it("refuses when there is no alias to grant", () => {
    expect(
      saveClassroom(db, { progress: progress(), alias: undefined, values: CLASSROOM }),
    ).toEqual({
      ok: false,
      reason: "alias_missing",
    });
  });
});

describe("finishSetup", () => {
  async function wizardThrough(step: "educator" | "alias" | "classroom") {
    await saveEducator(db, { username: "laerer", password: "korrekt-hest-batteri" });
    if (step === "educator") return;

    const alias = saveAlias(db, { progress: progress(), values: ALIAS });
    if (step === "alias") return;

    saveClassroom(db, { progress: progress(), alias, values: CLASSROOM });
  }

  it("refuses until an account, a model and a class all exist", async () => {
    expect(finishSetup(db, { educatorSeeded: false })).toEqual({ ok: false, reason: "incomplete" });

    await wizardThrough("educator");
    expect(finishSetup(db, { educatorSeeded: false })).toEqual({ ok: false, reason: "incomplete" });

    await wizardThrough("alias");
    expect(finishSetup(db, { educatorSeeded: false })).toEqual({ ok: false, reason: "incomplete" });
    // Nothing above wrote the flag; only this action does.
    expect(readInstance(db)?.setupCompletedAt ?? null).toBeNull();
  });

  it("completes, releases the claim and issues an educator session", async () => {
    await wizardThrough("classroom");
    const now = new Date("2026-09-01T08:00:00Z");

    const result = finishSetup(db, { educatorSeeded: false, now });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const row = readInstance(db);
    expect(row?.setupCompletedAt).toEqual(now);
    // The claim goes with completion, in one statement: a finished install
    // holding a claim nobody can release would be a gate open and a wizard owned.
    expect(row?.claimProofDigest).toBeNull();
    expect(row?.claimedAt).toBeNull();

    expect(result.session.session.ownerKind).toBe("educator");
    expect(result.session.session.ownerId).toBe(result.educator.id);
  });
});

describe("provisionFirstStudents", () => {
  it("returns one card per pupil, with the code shown exactly once", async () => {
    const alias = saveAlias(db, { progress: progress(), values: ALIAS });
    const saved = saveClassroom(db, { progress: progress(), alias, values: CLASSROOM });
    if (!saved.ok) throw new Error("unreachable");

    const provisioned = await provisionFirstStudents(db, {
      classroom: saved.classroom,
      pepper: "test-pepper-not-a-real-secret",
      count: 3,
    });

    expect(provisioned).toHaveLength(3);
    expect(new Set(provisioned.map((row) => row.code.normalised)).size).toBe(3);

    // Nothing persisted can reconstruct a code (§7).
    const stored = db.$client
      .query("SELECT credentialDigest, credentialHint FROM student")
      .all() as { credentialDigest: string; credentialHint: string }[];
    for (const { code } of provisioned) {
      expect(stored.some((row) => row.credentialDigest === code.normalised)).toBe(false);
    }
    expect(stored).toHaveLength(3);
  });

  /**
   * The batch is written in one synchronous turn precisely so this is all or
   * nothing: a claim seized while the codes were being hashed must leave no
   * pupils behind (§7, §21).
   */
  it("writes no pupil at all when the claim is withdrawn while the codes are hashed", async () => {
    const alias = saveAlias(db, { progress: progress(), values: ALIAS });
    const saved = saveClassroom(db, { progress: progress(), alias, values: CLASSROOM });
    if (!saved.ok) throw new Error("unreachable");

    const provisioned = await provisionFirstStudents(db, {
      classroom: saved.classroom,
      pepper: "test-pepper-not-a-real-secret",
      count: 3,
      stillAuthorised: () => false,
    });

    expect(provisioned).toEqual([]);
    expect(db.$client.query("SELECT id FROM student").all()).toEqual([]);
  });

  it("provisions the whole batch when the claim still holds", async () => {
    const alias = saveAlias(db, { progress: progress(), values: ALIAS });
    const saved = saveClassroom(db, { progress: progress(), alias, values: CLASSROOM });
    if (!saved.ok) throw new Error("unreachable");

    const provisioned = await provisionFirstStudents(db, {
      classroom: saved.classroom,
      pepper: "test-pepper-not-a-real-secret",
      count: 3,
      stillAuthorised: () => true,
    });

    expect(provisioned).toHaveLength(3);
    expect(new Set(provisioned.map((row) => row.student.label)).size).toBe(3);
  });
});
