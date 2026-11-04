import { describe, expect, it } from "bun:test";
import { BUDGET_PRESETS } from "../server/agent/budgets";
import { MIN_CONTEXT_CEILING, turnContextCeiling } from "./context-ceiling";

describe("turnContextCeiling (§10)", () => {
  it("is a quarter of the per-turn cap under each preset", () => {
    expect(turnContextCeiling(BUDGET_PRESETS.cautious)).toBe(12_500);
    expect(turnContextCeiling(BUDGET_PRESETS.standard)).toBe(25_000);
    expect(turnContextCeiling(BUDGET_PRESETS.generous)).toBe(50_000);
  });

  it("follows the daily allowance when that is the smaller", () => {
    expect(turnContextCeiling({ perTurnTokenCap: 400_000, perStudentDailyTokens: 100_000 })).toBe(
      25_000,
    );
  });

  it("never falls below what a system prompt and tools take on their own", () => {
    expect(turnContextCeiling({ perTurnTokenCap: 1_000, perStudentDailyTokens: 1_000 })).toBe(
      MIN_CONTEXT_CEILING,
    );
  });
});
