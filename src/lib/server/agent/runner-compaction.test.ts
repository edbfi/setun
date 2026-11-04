import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { summaryForPath } from "../db/queries/context-summaries";
import { createConversation } from "../db/queries/conversations";
import { appendMessage, getActivePath, listConversationMessages } from "../db/queries/messages";
import { createTurn } from "../db/queries/turns";
import type { Message } from "../db/schema";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { GatewayAdapter } from "../gateway/adapter";
import { type StubFetchCall, streamingResponse, stubFetch } from "../gateway/testing";
import { SUMMARY_INSTRUCTIONS } from "./compaction";
import { resetContextWindowState } from "./context-window";
import { executeTurn } from "./runner";
import { readBufferedEvents } from "./turn-buffer";

/**
 * A long conversation, end to end through the runner (PRD §10).
 *
 * The alias states a small window, so a dozen ordinary exchanges outgrow it;
 * the stub gateway tells a summary request from an answer by its instructions.
 */

let db: AppDatabase;
let fixtures: ReturnType<typeof seedTestFixtures>;

beforeEach(() => {
  db = createTestDatabase();
  fixtures = seedTestFixtures(db);
  resetContextWindowState();
});

const chat = (text: string, usage = { prompt_tokens: 900, completion_tokens: 40 }) =>
  streamingResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [], usage }),
    "[DONE]",
  ]);

const overflow = () =>
  new Response(
    JSON.stringify({
      error: {
        message: "This model's maximum context length is 6000 tokens.",
        code: "context_length_exceeded",
      },
    }),
    { status: 400 },
  );

function isSummary(call: StubFetchCall): boolean {
  const body = call.body as { messages?: { content?: unknown }[] } | undefined;
  return body?.messages?.[0]?.content === SUMMARY_INSTRUCTIONS;
}

/** A conversation of `exchanges` long exchanges, ending on a new prompt. */
function longConversation(exchanges: number) {
  const conversation = createConversation(db, {
    studentId: fixtures.student.id,
    modelAliasId: fixtures.alias.id,
  });
  let parentId: string | null = null;
  for (let n = 0; n < exchanges; n++) {
    parentId = appendMessage(db, {
      conversationId: conversation.id,
      parentId,
      role: "user",
      parts: [{ type: "text", text: `Spørgsmål ${n}: ${"hvorfor ".repeat(60)}` }],
    }).id;
    parentId = appendMessage(db, {
      conversationId: conversation.id,
      parentId,
      role: "assistant",
      parts: [{ type: "text", text: `Svar ${n}: ${"fordi ".repeat(80)}` }],
    }).id;
  }
  const prompt = appendMessage(db, {
    conversationId: conversation.id,
    parentId,
    role: "user",
    parts: [{ type: "text", text: "Og hvad nu?" }],
  });
  const turn = createTurn(db, {
    conversationId: conversation.id,
    studentId: fixtures.student.id,
    parentMessageId: prompt.id,
  });
  return { conversation, prompt, turn, path: getActivePath(db, prompt.id) as Message[] };
}

function run(
  scaffold: ReturnType<typeof longConversation>,
  responder: (call: StubFetchCall) => Response,
) {
  const adapter = new GatewayAdapter({
    baseUrl: "http://cpa:8317",
    listenerKey: "k",
    fetch: stubFetch((call) =>
      call.url.endsWith("/v1/models")
        ? new Response(JSON.stringify({ data: [] }))
        : responder(call),
    ).fetch,
  });

  return executeTurn({
    db,
    adapter,
    turnId: scaffold.turn.id,
    conversationId: scaffold.conversation.id,
    studentId: fixtures.student.id,
    classroomId: fixtures.classroom.id,
    // A small window, stated by the operator: twelve exchanges do not fit.
    alias: { ...fixtures.alias, contextWindowTokens: 6_000 },
    parentMessageId: scaffold.prompt.id,
    path: scaffold.path,
  });
}

function answerOf(conversationId: string) {
  return listConversationMessages(db, conversationId).at(-1);
}

describe("a conversation that outgrows the model", () => {
  it("is summarised, the summary stored, the answer marked, and its cost recorded", async () => {
    const scaffold = longConversation(12);
    const answers: StubFetchCall[] = [];
    let summaries = 0;

    await run(scaffold, (call) => {
      if (isSummary(call)) {
        summaries++;
        return chat("Eleven spørger om hvorfor.", { prompt_tokens: 700, completion_tokens: 20 });
      }
      answers.push(call);
      return chat("Nu dette.");
    });

    const answer = answerOf(scaffold.conversation.id);
    expect(answer?.parts[0]).toEqual({ type: "context-compacted", mode: "summarised" });
    expect(answer?.parts).toContainEqual({ type: "text", text: "Nu dette." });

    // The answer was asked with the summary instead of the old exchanges.
    const sent = JSON.stringify(answers[0].body);
    expect(sent).toContain("Eleven spørger om hvorfor.");
    expect(sent).not.toContain("Spørgsmål 0:");
    expect(sent).toContain("Og hvad nu?");

    // Stored against the last message it covers, for the next turn to reuse.
    const stored = summaryForPath(db, {
      conversationId: scaffold.conversation.id,
      pathIds: scaffold.path.map((message) => message.id),
    });
    expect(stored?.text).toBe("Eleven spørger om hvorfor.");

    // The summary was paid for, as part of the pupil's turn — every request of
    // it, where the history was long enough to take more than one.
    expect(summaries).toBeGreaterThanOrEqual(1);
    const [usage] = db.$client.query("SELECT * FROM usage_event").all() as {
      inputTokens: number;
    }[];
    expect(usage.inputTokens).toBe(700 * summaries + 900);

    // The pupil saw the stage while it happened.
    const types = readBufferedEvents(db, { turnId: scaffold.turn.id }).map(
      (entry) => entry.event.type,
    );
    expect(types.indexOf("compacting")).toBeLessThan(types.indexOf("text-delta"));
  });

  it("compacts harder and asks again once when the provider refuses for length", async () => {
    const scaffold = longConversation(3);
    let answerCalls = 0;

    await run(scaffold, (call) => {
      if (isSummary(call))
        return chat("Kort resumé.", { prompt_tokens: 300, completion_tokens: 10 });
      answerCalls++;
      return answerCalls === 1 ? overflow() : chat("Nu virker det.");
    });

    expect(answerCalls).toBe(2);
    const answer = answerOf(scaffold.conversation.id);
    expect(answer?.parts).toContainEqual({ type: "text", text: "Nu virker det." });
    expect(answer?.parts.some((part) => part.type === "turn-notice")).toBe(false);
    // No error ever reached the pupil.
    const types = readBufferedEvents(db, { turnId: scaffold.turn.id }).map(
      (entry) => entry.event.type,
    );
    expect(types).not.toContain("error");
  });

  it("tells the pupil plainly when it still does not fit", async () => {
    const scaffold = longConversation(3);
    let answerCalls = 0;

    await run(scaffold, (call) => {
      if (isSummary(call))
        return chat("Kort resumé.", { prompt_tokens: 300, completion_tokens: 10 });
      answerCalls++;
      return overflow();
    });

    // Asked twice, never a third time.
    expect(answerCalls).toBe(2);
    expect(answerOf(scaffold.conversation.id)?.parts).toContainEqual({
      type: "turn-notice",
      notice: "context-full",
    });
  });

  it("leaves a conversation that fits exactly as it was", async () => {
    const scaffold = longConversation(1);
    const answers: StubFetchCall[] = [];

    await run(scaffold, (call) => {
      if (isSummary(call)) throw new Error("nothing to summarise");
      answers.push(call);
      return chat("Fint.");
    });

    expect(JSON.stringify(answers[0].body)).toContain("Spørgsmål 0:");
    expect(
      answerOf(scaffold.conversation.id)?.parts.some((part) => part.type === "context-compacted"),
    ).toBe(false);
  });
});
