import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { listStudentArtifacts } from "../db/queries/artifacts";
import { createConversation, getOwnedConversation } from "../db/queries/conversations";
import { appendMessage, listConversationMessages } from "../db/queries/messages";
import { createTurn, getTurn } from "../db/queries/turns";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { GatewayAdapter } from "../gateway/adapter";
import { promptTextOf } from "../gateway/messages";
import { streamingResponse, stubFetch } from "../gateway/testing";
import { estimateTokens } from "../gateway/usage";
import { BUDGET_PRESETS } from "./budgets";
import {
  assertNoTurnInConversation,
  assertTurnCapacity,
  getActiveTurns,
  TurnInFlightError,
  TurnLimitError,
} from "./concurrency";
import { assembleContext } from "./loop";
import { executeTurn } from "./runner";
import { streamTurnEvents } from "./stream";
import { readBufferedEvents } from "./turn-buffer";

/**
 * Turn execution, buffering order, resume and single-turn enforcement
 * (plan 1.5–1.6, PRD §10, §22).
 */

let db: AppDatabase;
let fixtures: ReturnType<typeof seedTestFixtures>;

beforeEach(() => {
  db = createTestDatabase();
  fixtures = seedTestFixtures(db);
});

const OK_STREAM = [
  JSON.stringify({ choices: [{ delta: { content: "Et " } }] }),
  JSON.stringify({ choices: [{ delta: { content: "loop" } }] }),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }),
  "[DONE]",
];

function adapterOver(responder: Parameters<typeof stubFetch>[0]) {
  return new GatewayAdapter({
    baseUrl: "http://cpa:8317",
    listenerKey: "k",
    fetch: stubFetch(responder).fetch,
  });
}

function startedTurn() {
  const conversation = createConversation(db, {
    studentId: fixtures.student.id,
    modelAliasId: fixtures.alias.id,
  });
  const prompt = appendMessage(db, {
    conversationId: conversation.id,
    parentId: null,
    role: "user",
    parts: [{ type: "text", text: "Forklar loops" }],
  });
  const turn = createTurn(db, {
    conversationId: conversation.id,
    studentId: fixtures.student.id,
    parentMessageId: prompt.id,
  });

  return { conversation, prompt, turn };
}

function runInput(scaffold: ReturnType<typeof startedTurn>, adapter: GatewayAdapter) {
  return {
    db,
    adapter,
    turnId: scaffold.turn.id,
    conversationId: scaffold.conversation.id,
    studentId: fixtures.student.id,
    classroomId: fixtures.classroom.id,
    alias: fixtures.alias,
    parentMessageId: scaffold.prompt.id,
    path: [scaffold.prompt],
  };
}

describe("executeTurn", () => {
  it("buffers every event in emission order with dense sequence numbers", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
    );

    const buffered = readBufferedEvents(db, { turnId: scaffold.turn.id });

    expect(buffered.map((b) => b.seq)).toEqual([0, 1, 2, 3]);
    expect(buffered.map((b) => b.event.type)).toEqual([
      "text-delta",
      "text-delta",
      "usage",
      "done",
    ]);
  });

  /**
   * A pilot classroom logged nothing about the turns it served (§16, §21).
   *
   * The assertion that matters is the second one: §16 permits identifiers,
   * aliases, latency, status and token counts, and permits nothing a pupil or a
   * model wrote. A line built by interpolation rather than from named fields is
   * how a prompt reaches an operator's terminal.
   */
  it("logs one structured line per turn, carrying no content", async () => {
    const lines: unknown[] = [];
    const original = console.info;
    console.info = (...parts: unknown[]) => lines.push(parts[0]);

    try {
      const scaffold = startedTurn();
      await executeTurn(
        runInput(
          scaffold,
          adapterOver(() => streamingResponse(OK_STREAM)),
        ),
      );

      const turnLine = lines.find(
        (line): line is Record<string, unknown> =>
          typeof line === "object" && line !== null && "event" in line && line.event === "turn",
      );

      expect(turnLine).toBeDefined();
      expect(turnLine?.status).toBe("completed");
      expect(turnLine?.modelAlias).toBe(fixtures.alias.name);
      expect(turnLine?.inputTokens).toBe(11);
      expect(turnLine?.outputTokens).toBe(3);
      expect(typeof turnLine?.durationMs).toBe("number");

      // Nothing the pupil typed and nothing the model answered.
      const serialised = JSON.stringify(turnLine);
      expect(serialised).not.toContain("Forklar loops");
      expect(serialised).not.toContain("Et loop");
      // Nor the gateway identifier behind the alias, which is deployment
      // configuration rather than a fact about this turn.
      expect(serialised).not.toContain(fixtures.alias.gatewayModelId);
    } finally {
      console.info = original;
    }
  });

  it("leaves no notice on a turn the model simply finished", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
    );

    const assistant = listConversationMessages(db, scaffold.conversation.id).find(
      (message) => message.role === "assistant",
    );

    expect(assistant?.parts.some((part) => part.type === "turn-notice")).toBe(false);
  });

  /**
   * A turn cut short left the pupil with a sentence that simply ended.
   *
   * The live container carried the reason, but it is cleared the instant the
   * persisted message replaces the streaming one, and nothing was written to the
   * message — so there was no sign before a reload and none after it (§10).
   */
  it("persists why a turn was cut short, so the sign survives a reload", async () => {
    const scaffold = startedTurn();

    await executeTurn({
      ...runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
      // An allowance small enough that the first chunk empties it: the loop
      // stops at a clean boundary and the partial answer is kept (§10).
      budgets: {
        ...BUDGET_PRESETS.standard,
        perStudentDailyTokens: estimateTokens(promptTextOf(assembleContext([scaffold.prompt]))) + 1,
      },
    });

    const assistant = listConversationMessages(db, scaffold.conversation.id).find(
      (message) => message.role === "assistant",
    );

    expect(assistant?.parts.at(-1)).toEqual({
      type: "turn-notice",
      notice: "student-allowance-exhausted",
    });
    // The words that reached the pupil are still there — the notice is added to
    // the answer, never in place of it.
    expect(assistant?.parts.some((part) => part.type === "text")).toBe(true);
    expect(getTurn(db, scaffold.turn.id)?.status).toBe("completed");
  });

  it("persists the assistant message, its usage and the active leaf", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
    );

    const messages = listConversationMessages(db, scaffold.conversation.id);
    const assistant = messages.find((m) => m.role === "assistant");

    expect(assistant?.parts).toEqual([{ type: "text", text: "Et loop" }]);
    expect(assistant?.inputTokens).toBe(11);
    expect(assistant?.outputTokens).toBe(3);
    expect(assistant?.usageEstimated).toBe(false);

    const conversation = getOwnedConversation(db, {
      conversationId: scaffold.conversation.id,
      studentId: fixtures.student.id,
    });
    expect(conversation?.activeLeafId).toBe(assistant?.id);
  });

  it("records a usage event against the student and classroom", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
    );

    const rows = db.$client.query("SELECT * FROM usage_event").all() as {
      studentId: string;
      classroomId: string;
      inputTokens: number;
      estimated: number;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].studentId).toBe(fixtures.student.id);
    expect(rows[0].classroomId).toBe(fixtures.classroom.id);
    expect(rows[0].inputTokens).toBe(11);
  });

  it("marks the turn completed and links the assistant message", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
    );

    const turn = getTurn(db, scaffold.turn.id);

    expect(turn?.status).toBe("completed");
    expect(turn?.assistantMessageId).toBeTruthy();
    expect(turn?.endedAt).not.toBeNull();
  });

  it("marks a failed turn and buffers a student-safe error", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() => new Response("upstream detail", { status: 502 })),
      ),
    );

    const turn = getTurn(db, scaffold.turn.id);
    const buffered = readBufferedEvents(db, { turnId: scaffold.turn.id });

    expect(turn?.status).toBe("failed");
    expect(buffered.map((b) => b.event.type)).toEqual(["error", "done"]);
    expect(JSON.stringify(buffered)).not.toContain("upstream detail");
  });

  it("records usage even when the gateway reported none, flagged estimated", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() =>
          streamingResponse([
            JSON.stringify({ choices: [{ delta: { content: "noget tekst" } }] }),
            "[DONE]",
          ]),
        ),
      ),
    );

    const rows = db.$client.query("SELECT * FROM usage_event").all() as {
      estimated: number;
      outputTokens: number;
    }[];

    expect(rows[0].estimated).toBe(1);
    // Never zero for a response that produced text (§10).
    expect(rows[0].outputTokens).toBeGreaterThan(0);
  });
});

describe("streamTurnEvents", () => {
  it("replays a finished turn from the buffer", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
    );

    const seen = [];
    for await (const buffered of streamTurnEvents(db, scaffold.turn.id)) seen.push(buffered);

    expect(seen.map((b) => b.event.type)).toEqual(["text-delta", "text-delta", "usage", "done"]);
  });

  it("resumes after a cursor, replaying only the remainder", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
    );

    const seen = [];
    for await (const buffered of streamTurnEvents(db, scaffold.turn.id, { afterSeq: 1 })) {
      seen.push(buffered);
    }

    expect(seen.map((b) => b.seq)).toEqual([2, 3]);
  });

  it("closes a turn interrupted by a restart with a cut-short notice", async () => {
    const scaffold = startedTurn();
    // A turn left streaming by a previous process, swept at boot (§10).
    db.$client.query("UPDATE turn SET status = 'interrupted' WHERE id = ?").run(scaffold.turn.id);

    const seen = [];
    for await (const buffered of streamTurnEvents(db, scaffold.turn.id)) seen.push(buffered);

    expect(seen.at(-1)?.event).toEqual({ type: "done", reason: "interrupted" });
  });

  it("tails a live turn and terminates with it", async () => {
    const scaffold = startedTurn();
    const running = executeTurn(
      runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
    );

    const seen = [];
    for await (const buffered of streamTurnEvents(db, scaffold.turn.id)) seen.push(buffered);
    await running;

    expect(seen.at(-1)?.event.type).toBe("done");
    // No duplicates across the buffer-read and live-tail boundary.
    expect(new Set(seen.map((b) => b.seq)).size).toBe(seen.length);
  });
});

describe("answers in flight: one per conversation, the classroom's limit per pupil (§10)", () => {
  const capacity =
    (conversationId: string, limit = 2) =>
    () =>
      assertTurnCapacity(db, { studentId: fixtures.student.id, conversationId, limit });

  it("refuses a second answer in the same conversation, naming the one to wait for", () => {
    const scaffold = startedTurn();

    expect(getActiveTurns(db, fixtures.student.id).map((turn) => turn.id)).toEqual([
      scaffold.turn.id,
    ]);
    try {
      capacity(scaffold.conversation.id)();
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(TurnInFlightError);
      expect((error as TurnInFlightError).activeTurnId).toBe(scaffold.turn.id);
    }
  });

  it("lets an answer start in another conversation, up to the limit", () => {
    startedTurn();
    const second = createConversation(db, {
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
    });

    expect(capacity(second.id)).not.toThrow();
    expect(capacity(second.id, 1)).toThrow(TurnLimitError);
  });

  it("refuses past the limit across all of the pupil's conversations", () => {
    startedTurn();
    startedTurn();
    const third = createConversation(db, {
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
    });

    expect(capacity(third.id, 2)).toThrow(TurnLimitError);
    expect(capacity(third.id, 3)).not.toThrow();
  });

  it("does not count another student's answers", () => {
    startedTurn();
    const other = seedTestFixtures(db, { label: "quiet-heron", digest: "other" });
    const theirs = createConversation(db, {
      studentId: other.student.id,
      modelAliasId: other.alias.id,
    });

    expect(() =>
      assertTurnCapacity(db, { studentId: other.student.id, conversationId: theirs.id, limit: 1 }),
    ).not.toThrow();
  });

  it("guards a branch switch in the busy conversation only", () => {
    const scaffold = startedTurn();
    const quiet = createConversation(db, {
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
    });

    expect(() =>
      assertNoTurnInConversation(db, {
        studentId: fixtures.student.id,
        conversationId: scaffold.conversation.id,
      }),
    ).toThrow(TurnInFlightError);
    expect(() =>
      assertNoTurnInConversation(db, { studentId: fixtures.student.id, conversationId: quiet.id }),
    ).not.toThrow();
  });

  it("releases once the turn reaches a terminal state", async () => {
    const scaffold = startedTurn();
    await executeTurn(
      runInput(
        scaffold,
        adapterOver(() => streamingResponse(OK_STREAM)),
      ),
    );

    expect(getActiveTurns(db, fixtures.student.id)).toEqual([]);
    expect(capacity(scaffold.conversation.id, 1)).not.toThrow();
  });
});

/**
 * The model's reasoning on the way to the transcript (PRD §20, §21).
 *
 * A classroom set to "never shown" is enforced here rather than in the
 * interface: the events are dropped before the turn is buffered, so there is
 * nothing to persist, nothing to publish to a tailing tab, and nothing a resume
 * or a devtools panel could find.
 */
describe("thinking visibility", () => {
  const THINKING_STREAM = [
    {
      event: "response.reasoning_summary_text.delta",
      data: JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        delta: "Overvejer ",
      }),
    },
    {
      event: "response.reasoning_summary_text.delta",
      data: JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "opgaven" }),
    },
    {
      event: "response.output_text.delta",
      data: JSON.stringify({ type: "response.output_text.delta", delta: "Et loop" }),
    },
    {
      event: "response.completed",
      data: JSON.stringify({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 11, output_tokens: 3 } },
      }),
    },
  ];

  function thinkingAdapter(records = THINKING_STREAM) {
    return new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: stubFetch(() => streamingResponse(records), { responses: true }).fetch,
    });
  }

  it("persists the summary as one part, so a reload still has it", async () => {
    const scaffold = startedTurn();
    await executeTurn({ ...runInput(scaffold, thinkingAdapter()), thinkingVisibility: "shown" });

    const assistant = listConversationMessages(db, scaffold.conversation.id).find(
      (message) => message.role === "assistant",
    );

    expect(assistant?.parts[0]).toEqual({ type: "thinking", text: "Overvejer opgaven" });
    expect(assistant?.parts[1]).toEqual({ type: "text", text: "Et loop" });
  });

  it("buffers nothing at all when the classroom says never", async () => {
    const scaffold = startedTurn();
    await executeTurn({ ...runInput(scaffold, thinkingAdapter()), thinkingVisibility: "hidden" });

    const buffered = readBufferedEvents(db, { turnId: scaffold.turn.id });
    expect(buffered.map((b) => b.event.type)).not.toContain("thinking-delta");
    expect(JSON.stringify(buffered)).not.toContain("Overvejer");

    const assistant = listConversationMessages(db, scaffold.conversation.id).find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.parts.some((part) => part.type === "thinking")).toBe(false);
  });

  /**
   * A fence inside a summary is the model thinking about writing a file, not a
   * file. Recording one would put a half-formed idea in a pupil's portfolio.
   */
  it("records no artifact from a fence inside the reasoning", async () => {
    const fenced = [
      {
        event: "response.reasoning_summary_text.delta",
        data: JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          delta: "Måske\n```html id=side\n<p>udkast</p>\n```\n",
        }),
      },
      {
        event: "response.output_text.delta",
        data: JSON.stringify({ type: "response.output_text.delta", delta: "Her er den ikke" }),
      },
      {
        event: "response.completed",
        data: JSON.stringify({
          type: "response.completed",
          response: { status: "completed", usage: { input_tokens: 11, output_tokens: 3 } },
        }),
      },
    ];

    const scaffold = startedTurn();
    await executeTurn({
      ...runInput(scaffold, thinkingAdapter(fenced)),
      thinkingVisibility: "shown",
    });

    expect(listStudentArtifacts(db, fixtures.student.id)).toEqual([]);
  });
});
