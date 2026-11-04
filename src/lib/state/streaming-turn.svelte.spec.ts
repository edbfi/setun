import { describe, expect, it } from "vitest";
import { ConversationState } from "./conversation.svelte";
import { StreamingTurn } from "./streaming-turn.svelte";

/**
 * Folding checkpoint events into the in-flight turn (PRD §10, §22).
 *
 * The banner and the prompt have different lifetimes on purpose: the prompt is
 * a question about this turn and dies with it, the banner is a fact about the
 * pupil's day and outlives the streaming message it appeared beside.
 */

describe("StreamingTurn — the 70 % banner", () => {
  it("records the figures the pupil is shown", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");

    turn.apply(
      {
        type: "budget-warning",
        requestId: "daily-warning",
        fraction: 0.72,
        usedTokens: 72_000,
        limitTokens: 100_000,
      },
      0,
    );

    expect(turn.budgetWarning).toEqual({
      requestId: "daily-warning",
      fraction: 0.72,
      usedTokens: 72_000,
      limitTokens: 100_000,
      acknowledged: false,
    });
  });

  it("survives the streaming message being replaced by the persisted one", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(
      {
        type: "budget-warning",
        requestId: "daily-warning",
        fraction: 0.9,
        usedTokens: 90,
        limitTokens: 100,
      },
      0,
    );

    turn.clear();

    expect(turn.budgetWarning).not.toBeNull();
    expect(turn.parts).toEqual([]);
  });

  it("starts clean on the next turn", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(
      {
        type: "budget-warning",
        requestId: "daily-warning",
        fraction: 0.9,
        usedTokens: 90,
        limitTokens: 100,
      },
      0,
    );

    turn.begin("turn-2");

    expect(turn.budgetWarning).toBeNull();
  });

  it("remembers that the pupil answered it", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(
      {
        type: "budget-warning",
        requestId: "daily-warning",
        fraction: 0.9,
        usedTokens: 90,
        limitTokens: 100,
      },
      0,
    );

    turn.acknowledgeWarning();

    expect(turn.budgetWarning?.acknowledged).toBe(true);
  });
});

describe("StreamingTurn — the checkpoint prompt", () => {
  const request = {
    type: "continue-request",
    requestId: "continue-1",
    cause: "steps",
    caps: ["steps"],
    turn: { steps: 20, tokens: 4_000, elapsedMs: 120_000 },
    daily: { usedTokens: 40_000, limitTokens: 100_000 },
  } as const;

  it("flattens the request into what the prompt renders", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");

    turn.apply(request, 0);

    expect(turn.continuePrompt).toEqual({
      requestId: "continue-1",
      cause: "steps",
      steps: 20,
      tokens: 4_000,
      elapsedMs: 120_000,
      usedTokens: 40_000,
      limitTokens: 100_000,
    });
    expect(turn.waiting).toBe(true);
  });

  it("clears the moment the loop moves on", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(request, 0);

    turn.apply({ type: "text-delta", text: "videre" }, 1);

    expect(turn.continuePrompt).toBeNull();
    expect(turn.waiting).toBe(false);
  });

  it("clears when the turn ends", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(request, 0);

    turn.apply({ type: "done", reason: "budget" }, 1);

    expect(turn.continuePrompt).toBeNull();
    expect(turn.notice).toBe("budget");
  });

  it("clears when the tab gives up on the stream", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(request, 0);

    turn.detach();

    expect(turn.continuePrompt).toBeNull();
  });

  it("names a daily ceiling that ran out mid-turn", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");

    turn.apply({ type: "done", reason: "student-allowance-exhausted" }, 0);

    expect(turn.notice).toBe("student-allowance-exhausted");
  });
});

/**
 * The reasoning, folded into the turn (PRD §20, §22).
 *
 * It grows into one trailing part the way text does, and it is not "visible
 * output": the placeholder keeps running while the model reasons, because the
 * answer has not begun.
 */
describe("StreamingTurn — thinking", () => {
  it("reopens a reasoning interval when a detached stream resumes", () => {
    let clock = 0;
    const turn = new StreamingTurn(() => clock);
    turn.begin("turn-1");
    turn.apply({ type: "thinking-delta", text: "First" }, 0);
    clock = 1_000;
    turn.detach();
    expect(turn.thinkingTimings[0]?.settledAt).toBe(1_000);
    turn.resume("turn-1", 0);
    turn.apply({ type: "thinking-delta", text: " continued" }, 1);
    expect(turn.thinkingTimings[0]?.settledAt).toBeNull();
    clock = 3_000;
    turn.apply({ type: "done", reason: "stop" }, 2);
    expect(turn.thinkingTimings[0]).toEqual({ startedAt: 0, settledAt: 3_000 });
  });

  it("ignores usage and checkpoints, and times reasoning after tool output separately", () => {
    let clock = 0;
    const turn = new StreamingTurn(() => clock);
    turn.begin("turn-1");
    turn.apply({ type: "thinking-delta", text: "First" }, 0);
    clock = 1_000;
    turn.apply({ type: "usage", inputTokens: 10, outputTokens: 20, estimated: false }, 1);
    turn.apply(
      {
        type: "continue-request",
        requestId: "continue-1",
        cause: "steps",
        caps: ["steps"],
        turn: { steps: 20, tokens: 30, elapsedMs: 1_000 },
        daily: { usedTokens: 30, limitTokens: 100 },
      },
      2,
    );
    expect(turn.thinkingTimings[0]).toEqual({ startedAt: 0, settledAt: null });
    clock = 2_000;
    turn.apply({ type: "tool-result", toolCallId: "tool-1", result: "Found", isError: false }, 3);
    expect(turn.thinkingTimings[0]).toEqual({ startedAt: 0, settledAt: 2_000 });
    clock = 5_000;
    turn.apply({ type: "thinking-delta", text: "Second" }, 4);
    clock = 9_000;
    turn.apply({ type: "text-delta", text: "Answer" }, 5);
    expect(turn.thinkingTimings[0]).toEqual({ startedAt: 0, settledAt: 2_000 });
    expect(turn.thinkingTimings[2]).toEqual({ startedAt: 5_000, settledAt: 9_000 });
  });

  it("grows into one trailing part rather than one per delta", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");

    turn.apply({ type: "thinking-delta", text: "Overvejer " }, 0);
    turn.apply({ type: "thinking-delta", text: "opgaven" }, 1);

    expect(turn.parts).toEqual([{ type: "thinking", text: "Overvejer opgaven" }]);
    expect(turn.thinking).toBe("Overvejer opgaven");
  });

  it("does not count as the answer having begun", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply({ type: "thinking-delta", text: "Overvejer" }, 0);

    expect(turn.hasVisibleOutput).toBe(false);

    turn.apply({ type: "text-delta", text: "Et loop" }, 1);
    expect(turn.hasVisibleOutput).toBe(true);
  });

  it("settles the moment the first visible output arrives, not when the turn ends", () => {
    let clock = 1_000;
    const turn = new StreamingTurn(() => clock);
    turn.begin("turn-1");

    clock = 3_000;
    turn.apply({ type: "thinking-delta", text: "Overvejer" }, 0);
    expect(turn.thinkingStartedAt).toBe(3_000);
    expect(turn.thinkingSettledAt).toBeNull();

    clock = 9_000;
    turn.apply({ type: "text-delta", text: "Et loop" }, 1);
    expect(turn.thinkingSettledAt).toBe(9_000);

    // The answer streaming on does not move it again.
    clock = 20_000;
    turn.apply({ type: "text-delta", text: " gentager" }, 2);
    expect(turn.thinkingSettledAt).toBe(9_000);
  });

  it("settles at the end for a turn that reasoned and then said nothing", () => {
    let clock = 1_000;
    const turn = new StreamingTurn(() => clock);
    turn.begin("turn-1");
    turn.apply({ type: "thinking-delta", text: "Overvejer" }, 0);

    clock = 12_000;
    turn.apply({ type: "done", reason: "stop" }, 1);

    expect(turn.thinkingSettledAt).toBe(12_000);
  });

  it("leaves the settle time alone for a turn that never reasoned", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply({ type: "text-delta", text: "Et loop" }, 0);
    turn.apply({ type: "done", reason: "stop" }, 1);

    expect(turn.thinkingStartedAt).toBeNull();
    expect(turn.thinkingSettledAt).toBeNull();
  });

  it("shows the compaction stage, then the marker at the head of the answer", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");

    turn.apply({ type: "compacting" }, 0);
    expect(turn.compacting).toBe(true);
    expect(turn.hasVisibleOutput).toBe(false);

    turn.apply({ type: "context-compacted", mode: "summarised" }, 1);
    turn.apply({ type: "text-delta", text: "Svar" }, 2);

    expect(turn.compacting).toBe(false);
    expect(turn.parts).toEqual([
      { type: "context-compacted", mode: "summarised" },
      { type: "text", text: "Svar" },
    ]);
  });
});

/**
 * A turn belongs to the conversation it answers (§10).
 *
 * It keeps running when the pupil opens another one, and is drawn, asked about
 * and stopped only in its own.
 */
describe("StreamingTurn — the conversation it answers", () => {
  it("carries its conversation from begin or resume to its finish, and drops it on clear", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1", "conv-a");
    expect(turn.conversationId).toBe("conv-a");

    turn.apply({ type: "done", reason: "stop" }, 0);
    expect(turn.finished?.conversationId).toBe("conv-a");

    turn.clear();
    expect(turn.conversationId).toBeNull();
    // "Done" outlives the live message, for the conversation it answered.
    expect(turn.finished?.conversationId).toBe("conv-a");

    turn.resume("turn-2", -1, "conv-b");
    expect(turn.conversationId).toBe("conv-b");
  });

  it("keeps one answer per conversation, each running while the pupil is elsewhere", () => {
    const conversation = new ConversationState({ id: "conv-a", title: null, messages: [] });
    conversation.turnFor("conv-a").begin("turn-1", "conv-a");
    expect(conversation.turn.turnId).toBe("turn-1");
    expect(conversation.turnsElsewhere).toEqual([]);

    // A second answer, in another conversation, beside the first.
    conversation.id = "conv-b";
    expect(conversation.turn.streaming).toBe(false);
    conversation.turnFor("conv-b").begin("turn-2", "conv-b");
    expect(conversation.turn.turnId).toBe("turn-2");
    expect(conversation.streamingCount).toBe(2);
    expect(conversation.turnsElsewhere.map((entry) => entry.conversationId)).toEqual(["conv-a"]);

    // The first finishes: nothing is running anywhere else.
    conversation.turnFor("conv-a").apply({ type: "done", reason: "stop" }, 0);
    expect(conversation.turnsElsewhere).toEqual([]);
    expect(conversation.streamingCount).toBe(1);
  });

  it("reads an idle answer in a conversation that has none", () => {
    const conversation = new ConversationState({ id: "conv-c", title: null, messages: [] });
    expect(conversation.turn.streaming).toBe(false);
    expect(conversation.turn.isEmpty).toBe(true);
    expect(conversation.turns).toEqual([]);
  });
});
