import type { AppDatabase } from "../db/client";
import { dailyConsumption, usageRevision } from "../db/queries/usage";
import type { BudgetSettings, DailyBudgetLease, DailyConsumption } from "./budgets";

interface Claim {
  classroomId: string;
  studentId: string;
  day: number;
  spent: number;
  reserved: number;
}

/**
 * The output one provider request reserves before it starts (§10).
 *
 * Not the whole of what is left: a pupil may have two answers being written at
 * once, and a request that held their entire allowance would refuse the other
 * one as if the day were spent. A request whose answer runs past this asks for
 * more as it goes, and is stopped only when the day really has none.
 */
export const OUTPUT_RESERVATION = 32_000;

// Process infrastructure, like liveTurns: claims coordinate pupils in the same
// database and live only until their turn's usage is persisted.
const claimsByDb = new WeakMap<AppDatabase, { claims: Set<Claim>; generation: number }>();

/** Synchronous reservations prevent overlapping turns from claiming the same tokens. */
export function claimDailyBudget(input: {
  db: AppDatabase;
  classroomId: string;
  studentId: string;
  range: { start: Date; end: Date };
  budgets: BudgetSettings;
}): DailyBudgetLease {
  const shared = claimsByDb.get(input.db) ?? { claims: new Set<Claim>(), generation: 0 };
  claimsByDb.set(input.db, shared);
  const { claims } = shared;
  const own: Claim = {
    classroomId: input.classroomId,
    studentId: input.studentId,
    day: input.range.start.getTime(),
    spent: 0,
    reserved: 0,
  };
  claims.add(own);
  let persisted: DailyConsumption = { studentTokens: 0, classroomTokens: 0 };
  let generation = -1;
  let revision = -1;

  function consumed(includeReservations = false, refresh = false) {
    // Refresh when any chat, utility or image usage is written, or another turn
    // finishes. Unchanged deltas only sum the small live claim set.
    const currentRevision = usageRevision(input.db);
    if (refresh || generation !== shared.generation || revision !== currentRevision) {
      persisted = dailyConsumption(input.db, {
        classroomId: input.classroomId,
        studentId: input.studentId,
        from: input.range.start,
        until: input.range.end,
      });
      generation = shared.generation;
      revision = currentRevision;
    }
    const used = { ...persisted };
    for (const claim of claims) {
      if (claim === own || claim.classroomId !== own.classroomId || claim.day !== own.day) continue;
      const tokens = claim.spent + (includeReservations ? claim.reserved : 0);
      used.classroomTokens += tokens;
      if (claim.studentId === own.studentId) used.studentTokens += tokens;
    }
    return used;
  }

  return {
    consumed,
    reserve(promptTokens, outputTokens = OUTPUT_RESERVATION) {
      const used = consumed(true, true);
      const classroomLeft =
        input.budgets.perClassroomDailyTokens - used.classroomTokens - own.spent;
      const studentLeft = input.budgets.perStudentDailyTokens - used.studentTokens - own.spent;
      if (classroomLeft <= promptTokens) return { stop: "classroom-cap-exhausted" };
      if (studentLeft <= promptTokens) return { stop: "student-allowance-exhausted" };
      // Reserve the prompt and a share of output before yielding to the
      // network. Per-turn checkpoints remain soft; only daily tokens bind.
      const left = Math.floor(Math.min(classroomLeft, studentLeft));
      own.reserved = Math.min(left, promptTokens + outputTokens);
      return {
        outputTokens: own.reserved - promptTokens,
        // When the reservation is all the day has left, reaching it is the end
        // of the day; otherwise the request reserves again (§10).
        limit:
          own.reserved < left
            ? null
            : classroomLeft <= studentLeft
              ? "classroom-cap-exhausted"
              : "student-allowance-exhausted",
      };
    },
    settle(tokens) {
      own.spent += tokens;
      own.reserved = 0;
    },
    release() {
      claims.delete(own);
      shared.generation++;
    },
  };
}
