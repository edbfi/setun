import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AppDatabase } from "../db/client";
import { createClassroom } from "../db/queries/classrooms";
import { createStudent } from "../db/queries/students";
import { educator, loginAttempt } from "../db/schema";
import { createTestDatabase } from "../db/testing";
import {
  attemptEducatorLogin,
  attemptEducatorSignIn,
  EDUCATOR_LOGIN_MINIMUM_DURATION_MS,
  educatorRateLimitKey,
  resolveEducatorSession,
  seedEducator,
} from "./educator";
import { DIGEST_FAILURE_THRESHOLD, delayForFailures } from "./rate-limit";
import {
  createSession,
  EDUCATOR_SESSION_TTL_DAYS,
  invalidateAllSessionsFor,
  resolveStudentSession,
} from "./sessions";

/**
 * Educator authentication (plan 2.1, PRD §7, §21, §22).
 *
 * The security property under test is role separation: a student session must
 * never satisfy an educator check, and an educator session must never resolve as
 * a student (§21, §22).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USERNAME = "laerer";
const PASSWORD = "a-long-operator-password";

function countLoginAttempts(database: AppDatabase, scope?: "ip" | "digest"): number {
  const rows = database.select().from(loginAttempt).all();
  return scope ? rows.filter((row) => row.scope === scope).length : rows.length;
}

let db: AppDatabase;

beforeEach(() => {
  db = createTestDatabase();
});

describe("seedEducator", () => {
  it("creates the account from deployment configuration", async () => {
    const result = await seedEducator(db, { username: USERNAME, password: PASSWORD });

    expect(result.seeded).toBe(true);
    expect(result.educator.username).toBe(USERNAME);
  });

  it("hashes with argon2id and never stores the plaintext", async () => {
    const { educator } = await seedEducator(db, { username: USERNAME, password: PASSWORD });

    expect(educator.passwordHash).toStartWith("$argon2id$");
    expect(educator.passwordHash).not.toContain(PASSWORD);

    const rows = db.$client.query("SELECT * FROM educator").all();
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });

  it("is a no-op when the same credential is re-seeded on restart", async () => {
    const first = await seedEducator(db, { username: USERNAME, password: PASSWORD });
    const second = await seedEducator(db, { username: USERNAME, password: PASSWORD });

    expect(second.seeded).toBe(false);
    expect(second.educator.passwordHash).toBe(first.educator.passwordHash);
  });

  /** The documented recovery path: re-seed and restart (§7, §6.2). */
  it("replaces the password when the seed changes, and the old one stops working", async () => {
    await seedEducator(db, { username: USERNAME, password: PASSWORD });
    const reseeded = await seedEducator(db, { username: USERNAME, password: "a-new-password" });

    expect(reseeded.seeded).toBe(true);

    const withOld = await attemptEducatorLogin(db, { username: USERNAME, password: PASSWORD });
    expect(withOld.ok).toBe(false);

    const withNew = await attemptEducatorLogin(db, {
      username: USERNAME,
      password: "a-new-password",
    });
    expect(withNew.ok).toBe(true);
  });

  it("collapses rows created by legacy configured-username changes", async () => {
    await seedEducator(db, { username: "old-configured", password: PASSWORD });
    const configuredPassword = "current-configured-password";
    const configured = db
      .insert(educator)
      .values({
        username: "current-configured",
        passwordHash: await Bun.password.hash(configuredPassword, { algorithm: "argon2id" }),
        createdAt: new Date(Date.now() + 1_000),
        updatedAt: new Date(Date.now() + 1_000),
      })
      .returning()
      .get();

    const result = await seedEducator(db, {
      username: configured.username,
      password: configuredPassword,
    });

    expect(result.seeded).toBe(false);
    expect(result.educator.id).toBe(configured.id);
    expect(db.select().from(educator).all()).toEqual([result.educator]);
  });
});

describe("attemptEducatorLogin", () => {
  beforeEach(async () => {
    await seedEducator(db, { username: USERNAME, password: PASSWORD });
  });

  it("establishes an educator session on the correct credential", async () => {
    const result = await attemptEducatorLogin(db, { username: USERNAME, password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.session.ownerKind).toBe("educator");
    expect(result.session.session.ownerId).toBe(result.educator.id);
  });

  it("applies the Appendix A sliding 7-day expiry", async () => {
    const result = await attemptEducatorLogin(db, { username: USERNAME, password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lifetime = result.session.session.expiresAt.getTime() - Date.now();
    expect(Math.round(lifetime / MS_PER_DAY)).toBe(EDUCATOR_SESSION_TTL_DAYS);
    expect(EDUCATOR_SESSION_TTL_DAYS).toBe(7);
  });

  it("refuses a wrong password and an unknown username identically", async () => {
    const wrongPassword = await attemptEducatorLogin(db, {
      username: USERNAME,
      password: "not-the-password",
    });
    const unknownUser = await attemptEducatorLogin(db, {
      username: "nobody",
      password: PASSWORD,
    });

    expect(wrongPassword).toEqual({ ok: false });
    expect(unknownUser).toEqual({ ok: false });
  });

  /** Check the floor and equal password work without timing unrelated CPU contention. */
  it("applies the duration floor and Argon2id work on every login path", async () => {
    const verify = spyOn(Bun.password, "verify");
    try {
      const time = async (username: string, password: string) => {
        const startedAt = Date.now();
        await attemptEducatorLogin(db, { username, password });
        return Date.now() - startedAt;
      };

      const unknown = await time("nobody-at-all", PASSWORD);
      const wrong = await time(USERNAME, "not-the-password");
      const correct = await time(USERNAME, PASSWORD);
      for (const duration of [unknown, wrong, correct]) {
        expect(duration).toBeGreaterThanOrEqual(EDUCATOR_LOGIN_MINIMUM_DURATION_MS - 5);
      }

      // The spy calls through to the real verifier. Removing the decoy work
      // must fail even when a quiet runner makes both paths meet the floor.
      expect(verify).toHaveBeenCalledTimes(3);
      const hashes = verify.mock.calls.map((call) => String(call[1]));
      for (const hash of hashes) expect(hash).toStartWith("$argon2id$");
      expect(hashes[0]).not.toBe(hashes[1]);
      expect(hashes[1]).toBe(hashes[2]);
      // Algorithm, format version and memory/time/parallelism costs must match.
      expect(hashes[0]?.split("$").slice(1, 4)).toEqual(hashes[1]?.split("$").slice(1, 4));
    } finally {
      verify.mockRestore();
    }
  });
});

describe("attemptEducatorSignIn", () => {
  beforeEach(async () => {
    await seedEducator(db, { username: USERNAME, password: PASSWORD });
  });

  it("authenticates the correct credential", async () => {
    const result = await attemptEducatorSignIn(db, { username: USERNAME, password: PASSWORD });
    expect(result.ok).toBe(true);
  });

  it("throttles repeated failures against the same username with a progressive delay", async () => {
    // Fail up to (but not past) the threshold: still no delay.
    for (let i = 0; i < DIGEST_FAILURE_THRESHOLD; i++) {
      const result = await attemptEducatorSignIn(db, {
        username: USERNAME,
        password: "wrong-password",
      });
      expect(result.ok).toBe(false);
    }

    // The next failure is past the threshold, so a delay now applies. Measured
    // against `now` so the wall-clock floor does not have to be waited out.
    const base = new Date();
    const started = Date.now();
    const throttled = await attemptEducatorSignIn(db, {
      username: USERNAME,
      password: "wrong-password",
      now: base,
    });
    const elapsed = Date.now() - started;

    expect(throttled.ok).toBe(false);
    // The throttled attempt sees the DIGEST_FAILURE_THRESHOLD failures before
    // it, so the base 1 s delay applies (delayForFailures counts from there).
    expect(delayForFailures(DIGEST_FAILURE_THRESHOLD)).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(delayForFailures(DIGEST_FAILURE_THRESHOLD) - 20);
  });

  it("records each attempt on the digest axis only, never the shared IP bucket", async () => {
    // The bare login records nothing; the sign-in wrapper records every attempt
    // so it leaves an audit trail and can be throttled at all (ISSUE-005). It
    // records the *digest* axis only — the operator must not be locked out of
    // the one recovery-less credential by a class filling the shared IP bucket,
    // so educator attempts never touch the ip scope.
    const before = countLoginAttempts(db, "digest");
    const beforeIp = countLoginAttempts(db, "ip");

    const failed = await attemptEducatorSignIn(db, {
      username: USERNAME,
      password: "wrong-password",
    });
    expect(failed.ok).toBe(false);
    expect(countLoginAttempts(db, "digest") - before).toBe(1);

    const successful = await attemptEducatorSignIn(db, { username: USERNAME, password: PASSWORD });
    expect(successful.ok).toBe(true);
    expect(countLoginAttempts(db, "digest") - before).toBe(2);

    // No IP row was ever written by the educator path.
    expect(countLoginAttempts(db, "ip") - beforeIp).toBe(0);
  });

  it("makes overlapping attempts on one username each earn the next delay step", async () => {
    // Load the digest with exactly the threshold, so the next failure is the
    // first delayed one and the failure after it the second. Inserted directly:
    // the point of the test is the two concurrent attempts, not the run-up.
    const digest = educatorRateLimitKey(USERNAME);
    db.insert(loginAttempt)
      .values(
        Array.from({ length: DIGEST_FAILURE_THRESHOLD }, () => ({
          scope: "digest" as const,
          key: digest,
          successful: false,
        })),
      )
      .run();

    // Fired together. The count/verify/record interval contains an argon2id
    // await, so without serialization both attempts read the same pre-burst
    // count, shared one stale delay, and the burst never climbed the
    // progression at all.
    const elapsed = await Promise.all(
      [0, 1].map(async () => {
        const startedAt = Date.now();
        const result = await attemptEducatorSignIn(db, {
          username: USERNAME,
          password: "wrong-password",
        });
        expect(result.ok).toBe(false);
        return Date.now() - startedAt;
      }),
    );

    // The second attempt to reach the credential must have seen the first one's
    // recorded failure, so it owes the next step up rather than a repeat.
    expect(Math.max(...elapsed)).toBeGreaterThanOrEqual(
      delayForFailures(DIGEST_FAILURE_THRESHOLD + 1) - 20,
    );
  });
});

describe("resolveEducatorSession", () => {
  beforeEach(async () => {
    await seedEducator(db, { username: USERNAME, password: PASSWORD });
  });

  const signIn = async () => {
    const result = await attemptEducatorLogin(db, { username: USERNAME, password: PASSWORD });
    if (!result.ok) throw new Error("expected the seeded credential to authenticate");
    return result;
  };

  it("resolves a live session to its educator", async () => {
    const { token } = (await signIn()).session;

    expect(resolveEducatorSession(db, token)?.username).toBe(USERNAME);
  });

  it("returns null for an unknown token", () => {
    expect(resolveEducatorSession(db, "not-a-token")).toBeNull();
  });

  it("returns null once the session has expired", async () => {
    const { token } = (await signIn()).session;
    const afterExpiry = new Date(Date.now() + (EDUCATOR_SESSION_TTL_DAYS + 1) * MS_PER_DAY);

    expect(resolveEducatorSession(db, token, afterExpiry)).toBeNull();
  });

  it("slides the expiry forward on each resolution", async () => {
    const { token, session } = (await signIn()).session;
    const later = new Date(Date.now() + 3 * MS_PER_DAY);

    resolveEducatorSession(db, token, later);

    const stored = db.$client
      .query("SELECT expiresAt FROM session WHERE id = ?")
      .get(session.id) as { expiresAt: number };
    expect(stored.expiresAt).toBe(later.getTime() + EDUCATOR_SESSION_TTL_DAYS * MS_PER_DAY);
  });

  it("is invalidated immediately by force-logout", async () => {
    const { token } = (await signIn()).session;
    const educator = resolveEducatorSession(db, token);
    if (!educator) throw new Error("expected the session to resolve");

    invalidateAllSessionsFor(db, { ownerKind: "educator", ownerId: educator.id });

    expect(resolveEducatorSession(db, token)).toBeNull();
  });
});

/**
 * Role separation (§21, §22).
 *
 * "Educator endpoints require an educator role." These assert the two
 * namespaces cannot be crossed in either direction.
 */
describe("role separation", () => {
  it("refuses to resolve a student session as an educator", () => {
    const classroom = createClassroom(db, { name: "7.B" });
    const student = createStudent(db, {
      classroomId: classroom.id,
      label: "brave-otter",
      credentialDigest: "digest-one",
      credentialHint: "ABCD",
    });
    const { token } = createSession(db, { ownerKind: "student", ownerId: student.id });

    expect(resolveEducatorSession(db, token)).toBeNull();
  });

  it("refuses to resolve an educator session as a student", async () => {
    const { educator } = await seedEducator(db, { username: USERNAME, password: PASSWORD });
    const { token } = createSession(db, { ownerKind: "educator", ownerId: educator.id });

    expect(resolveStudentSession(db, token)).toBeNull();
  });
});
