import { describe, expect, it } from "bun:test";
import type { GatewayAdapter } from "../gateway/adapter";
import type { ChatRequest, GatewayMessage } from "../gateway/dialect";
import type { GatewayEvent } from "../gateway/events";
import type { DailyBudgetLease } from "./budgets";
import { createSummariser } from "./compaction";
import type { PathMessage } from "./context-plan";
import { fitTurnGrowth, runTurn } from "./loop";

/**
 * The summariser and the loop's own room-making (PRD §10), against fake
 * gateways that record what they were asked and count what they produced.
 */

function fakeGateway(chunks: string[]) {
  const requests: ChatRequest[] = [];
  let produced = 0;
  let aborted = false;
  const adapter = {
    async *streamChat(_dialect: string, request: ChatRequest): AsyncGenerator<GatewayEvent> {
      requests.push(request);
      request.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      for (const text of chunks) {
        if (request.signal?.aborted)
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        produced++;
        yield { type: "text-delta", text };
      }
      yield { type: "usage", inputTokens: 50, outputTokens: produced * 5, estimated: false };
    },
  };
  return {
    adapter: adapter as unknown as GatewayAdapter,
    requests,
    get produced() {
      return produced;
    },
    get aborted() {
      return aborted;
    },
  };
}

function lease(outputTokens: number) {
  const settled: number[] = [];
  const budget: DailyBudgetLease = {
    consumed: () => ({ classroomTokens: 0, studentTokens: 0 }),
    reserve: () => ({ outputTokens, limit: "student-allowance-exhausted" }),
    settle: (tokens) => settled.push(tokens),
    release: () => {},
  };
  return { budget, settled };
}

const messages: PathMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Hej" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hej med dig" }] },
];

describe("createSummariser", () => {
  it("stops at the day's output allowance, and keeps nothing it cut short", async () => {
    const gateway = fakeGateway(Array.from({ length: 20 }, () => "ord ord ord ord "));
    const { budget, settled } = lease(5);
    const summarise = createSummariser({
      adapter: gateway.adapter,
      alias: { id: "a", dialect: "openai", gatewayModelId: "m" },
      budget: 10_000,
      dailyBudget: budget,
      emit: () => {},
    });

    expect(await summarise(null, messages)).toBeNull();
    // Cut off early, not after all twenty chunks…
    expect(gateway.produced).toBeLessThan(20);
    expect(gateway.aborted).toBe(true);
    // …and what was produced is still charged, once.
    expect(settled).toHaveLength(1);
    expect(settled[0]).toBeGreaterThan(0);
  });

  it("sends the output ceiling the plan reserved, and says what it covers", async () => {
    const gateway = fakeGateway(["Eleven siger hej."]);
    const summarise = createSummariser({
      adapter: gateway.adapter,
      alias: { id: "a", dialect: "anthropic", gatewayModelId: "m" },
      budget: 10_000,
      maxOutputTokens: 4_096,
      emit: () => {},
    });

    expect(await summarise(null, messages)).toEqual({ text: "Eleven siger hej.", covered: 2 });
    expect(gateway.requests[0].maxOutputTokens).toBe(4_096);
  });
});

describe("runTurn", () => {
  it("sends the output ceiling the plan reserved with every step", async () => {
    const gateway = fakeGateway(["Svar."]);
    for await (const _event of runTurn({
      adapter: gateway.adapter,
      dialect: "anthropic",
      model: "m",
      path: [{ role: "user", parts: [{ type: "text", text: "Hej" }] }],
      contextBudget: { inputTokens: 10_000, aliasId: "a", maxOutputTokens: 2_048 },
    })) {
      // drained
    }
    expect(gateway.requests[0].maxOutputTokens).toBe(2_048);
  });
});

describe("fitTurnGrowth", () => {
  it("makes several large results of the latest batch fit together", () => {
    const sent: GatewayMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "Søg tre ting" },
      {
        role: "assistant",
        content: "",
        toolCalls: ["1", "2", "3"].map((id) => ({ id, name: "search", arguments: "{}" })),
      },
      ...["1", "2", "3"].map((id) => ({
        role: "tool" as const,
        toolCallId: id,
        content: "r".repeat(6_000),
      })),
    ];

    // About 6,000 tokens of results against a budget of 3,000.
    fitTurnGrowth(sent, 2, [], { inputTokens: 3_000, aliasId: "fit-test" });

    const results = sent.filter((message) => message.role === "tool");
    expect(results).toHaveLength(3);
    const total = results.reduce((sum, message) => sum + String(message.content).length, 0);
    expect(total).toBeLessThanOrEqual(9_000);
    // Each still says something, and says it was shortened.
    for (const message of results) {
      expect(String(message.content).length).toBeGreaterThanOrEqual(1_500);
    }
    expect(results.some((message) => String(message.content).includes("left out to fit"))).toBe(
      true,
    );
  });
});
