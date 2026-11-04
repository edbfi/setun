import { describe, expect, it } from "bun:test";
import type { GatewayAdapter } from "../gateway/adapter";
import type { ChatRequest, GatewayMessage } from "../gateway/dialect";
import type { GatewayEvent } from "../gateway/events";
import type { DailyBudgetLease } from "./budgets";
import { createSummariser } from "./compaction";
import type { PathMessage } from "./context-plan";
import { recordCalibration, requestTokens } from "./context-window";
import { fitTurnGrowth, runTurn } from "./loop";

/**
 * The summariser and the loop's own room-making (PRD §10), against fake
 * gateways that record what they were asked and count what they produced.
 */

function fakeGateway(chunks: string[], finishReason?: "length" | "stop") {
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
      yield {
        type: "usage",
        inputTokens: 50,
        outputTokens: produced * 5,
        estimated: false,
        ...(finishReason ? { finishReason } : {}),
      };
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

  it("keeps no summary the provider cut off at its own output ceiling", async () => {
    const gateway = fakeGateway(["The pupil requires "], "length");
    const summarise = createSummariser({
      adapter: gateway.adapter,
      alias: { id: "a", dialect: "openai", gatewayModelId: "m" },
      budget: 10_000,
      emit: () => {},
    });

    expect(await summarise(null, messages)).toBeNull();
  });

  it("caps summary calls per turn, across every pass that shares the count", async () => {
    const gateway = fakeGateway(["Kort."]);
    const calls = { count: 0 };
    const make = () =>
      createSummariser({
        adapter: gateway.adapter,
        alias: { id: "a", dialect: "openai", gatewayModelId: "m" },
        budget: 10_000,
        calls,
        emit: () => {},
      });

    for (let pass = 0; pass < 6; pass++) await make()(null, messages);
    expect(gateway.requests).toHaveLength(4);
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
  it("fits a large batch, each result still saying something and saying truly how much is gone", () => {
    // Twenty results already capped as they arrived, against a 13,000-token budget.
    const capped = `${"r".repeat(7_800)}\n[… 2200 more characters left out to fit the model's context]`;
    const sent: GatewayMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "Søg tyve ting" },
      {
        role: "assistant",
        content: "",
        toolCalls: Array.from({ length: 20 }, (_, n) => ({
          id: `${n}`,
          name: "search",
          arguments: "{}",
        })),
      },
      ...Array.from({ length: 20 }, (_, n) => ({
        role: "tool" as const,
        toolCallId: `${n}`,
        content: capped,
      })),
    ];

    fitTurnGrowth(sent, 2, [], { inputTokens: 13_000, aliasId: "fit-test-large" });

    const results = sent
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content));
    const total = results.reduce((sum, text) => sum + text.length, 0);
    expect(total / 3).toBeLessThan(13_000);
    for (const text of results) {
      const kept = text.indexOf("\n[…");
      const said = Number(/\[… (\d+) more/.exec(text)?.[1]);
      // What is shown plus what it says was left out is the whole result.
      expect(kept + said).toBe(10_000);
    }
  });

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

describe("summary requests on a densely counting model", () => {
  it("are sized as the alias counts, and never sent over budget", async () => {
    // This alias's provider has reported 2.5 tokens for every estimated one.
    recordCalibration("dense", 1_000, 2_500);
    const gateway = fakeGateway(["Kort."]);
    const summarise = createSummariser({
      adapter: gateway.adapter,
      alias: { id: "dense", dialect: "openai", gatewayModelId: "m" },
      budget: 4_050,
      emit: () => {},
    });
    const long: PathMessage[] = Array.from({ length: 12 }, (_, n) => ({
      id: `m${n}`,
      role: n % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `besked ${n} `.repeat(200) }],
    }));

    expect(await summarise(null, long)).not.toBeNull();
    for (const request of gateway.requests) {
      expect(requestTokens("dense", request.messages)).toBeLessThanOrEqual(4_050);
    }
  });
});

describe("fitTurnGrowth on older results", () => {
  it("names a capped older result by its whole length", () => {
    const capped = `${"r".repeat(4_000)}\n[… 36000 more characters left out to fit the model's context]`;
    const sent: GatewayMessage[] = [
      { role: "user", content: "Søg" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "search", arguments: "{}" }] },
      { role: "tool", toolCallId: "1", content: capped },
      { role: "assistant", content: "", toolCalls: [{ id: "2", name: "search", arguments: "{}" }] },
      { role: "tool", toolCallId: "2", content: "kort" },
    ];

    fitTurnGrowth(sent, 0, [], { inputTokens: 100, aliasId: "older-test" });

    expect(String(sent[2].content)).toContain("(40000 characters)");
  });
});
