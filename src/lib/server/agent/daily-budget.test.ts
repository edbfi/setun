import { describe, expect, it } from "bun:test";
import { recordUsageEvent } from "../db/queries/usage";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { BUDGET_PRESETS, budgetDayRange } from "./budgets";
import { claimDailyBudget, OUTPUT_RESERVATION } from "./daily-budget";

function setup() {
  const db = createTestDatabase();
  const fixtures = seedTestFixtures(db);
  const input = {
    db,
    classroomId: fixtures.classroom.id,
    studentId: fixtures.student.id,
    range: budgetDayRange("UTC"),
    budgets: {
      ...BUDGET_PRESETS.standard,
      perStudentDailyTokens: 100,
      perClassroomDailyTokens: 150,
    },
  };
  return { input, fixtures };
}

describe("shared daily reservations", () => {
  it("gives overlapping pupils disjoint shares of the remaining classroom allowance", () => {
    const { input } = setup();
    const first = claimDailyBudget(input);
    const second = claimDailyBudget({ ...input, studentId: "another-pupil" });
    expect(first.reserve(10)).toEqual({ outputTokens: 90, limit: "student-allowance-exhausted" });
    expect(second.reserve(10)).toEqual({ outputTokens: 40, limit: "classroom-cap-exhausted" });
    const third = claimDailyBudget({ ...input, studentId: "third-pupil" });
    expect(third.reserve(1)).toEqual({ stop: "classroom-cap-exhausted" });
    first.release();
    second.release();
    third.release();
  });

  it("leaves a pupil's second answer room to start beside the first", () => {
    const { input } = setup();
    const budgets = {
      ...input.budgets,
      perStudentDailyTokens: 100_000,
      perClassroomDailyTokens: 1_000_000,
    };
    const first = claimDailyBudget({ ...input, budgets });
    const second = claimDailyBudget({ ...input, budgets });

    // A share each, not the whole day for whichever asked first.
    expect(first.reserve(1_000)).toEqual({ outputTokens: OUTPUT_RESERVATION, limit: null });
    expect(second.reserve(1_000)).toEqual({ outputTokens: OUTPUT_RESERVATION, limit: null });
    // Together they still cannot hold more than the day has: three shares of
    // 33,000 leave 1,000, which pays for no prompt.
    const third = claimDailyBudget({ ...input, budgets });
    const fourth = claimDailyBudget({ ...input, budgets });
    expect(third.reserve(1_000)).toEqual({ outputTokens: OUTPUT_RESERVATION, limit: null });
    expect(fourth.reserve(1_000)).toEqual({ stop: "student-allowance-exhausted" });
    fourth.release();
    first.release();
    second.release();
    third.release();
  });

  it("holds more for a request already under way, up to what the day has", () => {
    const { input } = setup();
    const budgets = {
      ...input.budgets,
      perStudentDailyTokens: 50_000,
      perClassroomDailyTokens: 1_000_000,
    };
    const own = claimDailyBudget({ ...input, budgets });

    expect(own.reserve(1_000)).toEqual({ outputTokens: OUTPUT_RESERVATION, limit: null });
    // Asked again with what the request has used so far.
    expect(own.reserve(1_000 + OUTPUT_RESERVATION)).toEqual({
      outputTokens: 50_000 - 1_000 - OUTPUT_RESERVATION,
      limit: "student-allowance-exhausted",
    });
    expect(own.reserve(50_000)).toEqual({ stop: "student-allowance-exhausted" });
    own.release();
  });

  it("releases unused reservations after a response or a failed request", () => {
    const { input } = setup();
    const first = claimDailyBudget(input);
    const second = claimDailyBudget({ ...input, studentId: "another-pupil" });
    first.reserve(10);
    first.settle(20);
    expect(second.consumed()).toEqual({ studentTokens: 0, classroomTokens: 20 });
    expect(second.reserve(10)).toEqual({ outputTokens: 90, limit: "student-allowance-exhausted" });
    second.settle(0);
    expect(first.reserve(10)).toEqual({ outputTokens: 70, limit: "student-allowance-exhausted" });
    first.release();
    second.release();
  });

  it("re-reads committed usage and counts a finished turn exactly once", () => {
    const { input, fixtures } = setup();
    const first = claimDailyBudget(input);
    const second = claimDailyBudget({ ...input, studentId: "another-pupil" });
    first.reserve(10);
    first.settle(60);
    recordUsageEvent(input.db, {
      classroomId: input.classroomId,
      studentId: input.studentId,
      modelAliasId: fixtures.alias.id,
      inputTokens: 10,
      outputTokens: 50,
      estimated: false,
    });
    first.release();
    expect(second.consumed()).toEqual({ studentTokens: 0, classroomTokens: 60 });
    expect(second.reserve(10)).toEqual({ outputTokens: 80, limit: "classroom-cap-exhausted" });
    second.release();
  });

  it("does not share reservations with another database", () => {
    const { input } = setup();
    const first = claimDailyBudget(input);
    first.reserve(10);
    const other = setup();
    const second = claimDailyBudget(other.input);
    expect(second.reserve(10)).toEqual({ outputTokens: 90, limit: "student-allowance-exhausted" });
    first.release();
    second.release();
  });

  it("refreshes tool and utility usage before reserving another provider request", () => {
    const { input, fixtures } = setup();
    const lease = claimDailyBudget(input);
    lease.reserve(10);
    lease.settle(0);
    recordUsageEvent(input.db, {
      classroomId: input.classroomId,
      studentId: null,
      modelAliasId: fixtures.alias.id,
      inputTokens: 140,
      outputTokens: 0,
      estimated: false,
    });
    expect(lease.reserve(10)).toEqual({ stop: "classroom-cap-exhausted" });
    lease.release();
  });
});
