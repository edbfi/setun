import { describe, expect, it } from "bun:test";
import { GatewayAdapter } from "../gateway/adapter";
import type { GatewayEvent } from "../gateway/events";
import { promptTextOf } from "../gateway/messages";
import { streamingResponse, stubFetch } from "../gateway/testing";
import { estimateTokens } from "../gateway/usage";
import { assembleContext, runTurn } from "./loop";
import { FIXED_SYSTEM_PROMPT } from "./system-prompt";

/**
 * Agent-loop termination conditions and context assembly
 * (plan 1.5, PRD §10, §22).
 */

function adapterOver(responder: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(responder);
  return {
    adapter: new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: stub.fetch,
    }),
    stub,
  };
}

const path = [
  { role: "user" as const, parts: [{ type: "text" as const, text: "Hej" }] },
  { role: "assistant" as const, parts: [{ type: "text" as const, text: "Hej med dig" }] },
  { role: "user" as const, parts: [{ type: "text" as const, text: "Forklar loops" }] },
];

async function collect(events: AsyncGenerator<GatewayEvent>): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const OK_STREAM = [
  JSON.stringify({ choices: [{ delta: { content: "Et loop" } }] }),
  JSON.stringify({ choices: [{ delta: { content: " gentager" } }] }),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
  "[DONE]",
];

describe("assembleContext", () => {
  it("puts the layered system prompt first, then the path oldest first", () => {
    const messages = assembleContext(path);

    expect(messages[0]).toEqual({ role: "system", content: FIXED_SYSTEM_PROMPT });
    expect(messages.slice(1)).toEqual([
      { role: "user", content: "Hej" },
      { role: "assistant", content: "Hej med dig" },
      { role: "user", content: "Forklar loops" },
    ]);
  });

  it("carries the educator's layers into the system message", () => {
    const messages = assembleContext(path, { classroomInstructions: "Svar på dansk." });

    expect(messages[0].content).toContain("Svar på dansk.");
  });

  it("sends only the active path, not every message in the tree", () => {
    // The caller supplies one branch; the loop never widens it (§10).
    expect(assembleContext([path[0]])).toHaveLength(2);
  });

  it("is unchanged when no artifact context is supplied", () => {
    expect(assembleContext(path)).toEqual(assembleContext(path, undefined, undefined, undefined));
  });

  it("appends the state note to the last user message, not to the system prompt", () => {
    const artifacts = {
      index: new Map(),
      state: [
        {
          key: "side",
          language: "html" as const,
          title: "Min side",
          revision: 2,
          authoredBy: "model" as const,
          buildStatus: "failed" as const,
          buildMessage: "SyntaxError",
          files: [],
        },
      ],
      carried: [],
    };

    const messages = assembleContext(path, undefined, undefined, artifacts);

    // The system prefix stays byte-identical, so it stays cacheable (§10, §13).
    expect(messages[0]).toEqual({ role: "system", content: FIXED_SYSTEM_PROMPT });
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.at(-1)?.content).toContain("Forklar loops");
    expect(messages.at(-1)?.content).toContain("id=side (html)");
    expect(messages.at(-1)?.content).toContain("last run failed: SyntaxError");
    // And nowhere else: the note describes this moment and belongs to one message.
    expect(messages[1].content).not.toContain("id=side");
  });

  it("carries a current source the path does not hold, behind the note", () => {
    const artifacts = {
      index: new Map(),
      state: [
        {
          key: "side",
          language: "html" as const,
          title: "Min side",
          revision: 2,
          authoredBy: "model" as const,
          buildStatus: null,
          buildMessage: null,
          files: [],
        },
      ],
      carried: [
        {
          key: "side",
          language: "html" as const,
          title: "Min side",
          revision: 2,
          entry: "index.html",
          allPaths: ["index.html"],
          missing: { "index.html": "<p>to</p>" },
        },
      ],
    };

    const messages = assembleContext(path, undefined, undefined, artifacts);
    const last = messages.at(-1);

    // The cacheable system prefix is untouched: the sources travel in the same
    // never-persisted slot as the note (§10, §13).
    expect(messages[0]).toEqual({ role: "system", content: FIXED_SYSTEM_PROMPT });
    expect(last?.role).toBe("user");
    expect(String(last?.content)).toContain("does not appear above");
    expect(String(last?.content)).toContain("<p>to</p>");
    // Behind the note, not in front of it.
    expect(String(last?.content).indexOf('id=side (html) "Min side" — revision 2')).toBeLessThan(
      String(last?.content).indexOf("does not appear above"),
    );
  });

  it("appends nothing extra when the path holds every current source", () => {
    const state = [
      {
        key: "side",
        language: "html" as const,
        title: null,
        revision: 1,
        authoredBy: "model" as const,
        buildStatus: null,
        buildMessage: null,
        files: [],
      },
    ];

    const messages = assembleContext(path, undefined, undefined, {
      index: new Map(),
      state,
      carried: [],
    });

    expect(String(messages.at(-1)?.content)).not.toContain("does not appear above");
  });

  it("appends no note when the conversation has built nothing", () => {
    const messages = assembleContext(path, undefined, undefined, {
      index: new Map(),
      state: [],
      carried: [],
    });

    expect(messages).toEqual(assembleContext(path));
  });
});

describe("runTurn termination", () => {
  it("terminates with exactly one done event on a normal stop", async () => {
    const { adapter } = adapterOver(() => streamingResponse(OK_STREAM));

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toEqual({ type: "done", reason: "stop" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });

  it("emits deltas then usage then done, in that order", async () => {
    const { adapter } = adapterOver(() => streamingResponse(OK_STREAM));

    const kinds = (await collect(runTurn({ adapter, dialect: "openai", model: "m", path }))).map(
      (e) => e.type,
    );

    expect(kinds.filter((k, i, all) => k !== all[i - 1])).toEqual(["text-delta", "usage", "done"]);
  });

  it("terminates with reason aborted when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter } = adapterOver(() => streamingResponse(OK_STREAM));

    const events = await collect(
      runTurn({ adapter, dialect: "openai", model: "m", path, signal: controller.signal }),
    );

    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    // An abort is not an error; the student cancelled deliberately (§10).
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("still accounts for the tokens when the signal fires mid-stream", async () => {
    /**
     * The regression this guards (PRD §10): a cancelled read leaves the stream
     * loop by throwing, so the trailing `resolveUsage` was skipped and an
     * aborted turn recorded no usage at all — the gateway had generated and
     * billed the text, and neither the pupil's allowance nor the classroom cap
     * moved. "Usage is never counted as zero" has to hold here above all,
     * because a pupil can abort as often as they like.
     */
    /**
     * The stream delivers text and is then cancelled, which is what the read
     * sees when a pupil presses Stop: an `AbortError` out of the body, after
     * deltas and before the gateway reports usage. Driving it from the response
     * rather than the signal is deliberate — the fetch stub only inspects the
     * signal when the request is made, so a signal fired later would let the
     * turn finish normally and test nothing.
     */
    const { adapter } = adapterOver(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              const frame = JSON.stringify({
                choices: [{ delta: { content: "Et loop gentager noget" } }],
              });
              stream.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
            },
            // Erroring here rather than in `start` lets the delta be read first,
            // so the cancellation lands mid-turn instead of before it began.
            pull(stream) {
              stream.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });

    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    const [only] = usage;
    if (only?.type !== "usage") throw new Error("expected a usage event");
    // Estimated, because the gateway never got to report: the figures below are
    // whatever the text produced so far costs, and the point is that they are
    // not zero.
    expect(only.estimated).toBe(true);
    expect(only.inputTokens).toBeGreaterThan(0);
    expect(only.outputTokens).toBeGreaterThan(0);
  });

  it("terminates with an error event and reason error when the gateway fails", async () => {
    const { adapter } = adapterOver(() => new Response("upstream boom", { status: 502 }));

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    expect(events).toEqual([
      { type: "error", message: "unavailable" },
      { type: "done", reason: "error" },
    ]);
  });

  it("never leaks upstream detail into the student-facing error event", async () => {
    const upstream = "https://api.anthropic.com rejected key sk-ant-abc123: quota exceeded";
    const { adapter } = adapterOver(() => new Response(upstream, { status: 500 }));

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));
    const serialised = JSON.stringify(events);

    expect(serialised).not.toContain("anthropic.com");
    expect(serialised).not.toContain("sk-ant");
    expect(serialised).not.toContain("quota exceeded");
  });

  it("preserves partial text emitted before a mid-stream failure", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([
        JSON.stringify({ choices: [{ delta: { content: "halvvejs" } }] }),
        "{malformed",
      ]),
    );

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    expect(events[0]).toEqual({ type: "text-delta", text: "halvvejs" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "error" });
  });

  it("terminates on an empty upstream stream rather than hanging", async () => {
    const { adapter } = adapterOver(() => streamingResponse(["[DONE]"]));

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });

  it("terminates identically in the anthropic dialect", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([
        {
          event: "content_block_delta",
          data: JSON.stringify({ type: "content_block_delta", delta: { text: "svar" } }),
        },
      ]),
    );

    const events = await collect(runTurn({ adapter, dialect: "anthropic", model: "m", path }));

    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });
});

describe("replaying a turn that used tools (§10, §11)", () => {
  it("pairs each stored call with the result it was given", () => {
    const messages = assembleContext([
      { role: "user", parts: [{ type: "text", text: "Slå det op" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Et øjeblik" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "docs__search",
            serverLabel: "Docs",
            arguments: { q: "loops" },
            decision: "auto",
          },
          { type: "tool-result", toolCallId: "call-1", result: "42 treffer", isError: false },
        ],
      },
    ]);

    expect(messages.slice(1)).toEqual([
      { role: "user", content: "Slå det op" },
      {
        role: "assistant",
        content: "Et øjeblik",
        toolCalls: [{ id: "call-1", name: "docs__search", arguments: '{"q":"loops"}' }],
      },
      { role: "tool", toolCallId: "call-1", content: "42 treffer" },
    ]);
  });

  it("replays a declined call with its refusal, so the model is not left guessing (§11)", () => {
    const messages = assembleContext([
      {
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "docs__search",
            serverLabel: "Docs",
            arguments: {},
            decision: "declined",
          },
          {
            type: "tool-result",
            toolCallId: "call-1",
            result: "The student declined this tool call.",
            isError: true,
          },
        ],
      },
    ]);

    expect(messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-1",
      content: "The student declined this tool call.",
    });
  });

  it("drops a result whose call is not in the same message", () => {
    const messages = assembleContext([
      {
        role: "assistant",
        parts: [{ type: "tool-result", toolCallId: "orphan", result: "x", isError: false }],
      },
    ]);

    // An orphan tool message would leave the upstream waiting on a call it
    // never saw, so it does not travel.
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
  });

  it("sends an image attachment inline, and nothing when its file has gone (§10, §21)", () => {
    const path = [
      {
        role: "user" as const,
        parts: [
          { type: "text" as const, text: "Hvad er der på billedet?" },
          {
            type: "attachment" as const,
            attachmentId: "att-1",
            kind: "image" as const,
            filename: "foto.png",
            mediaType: "image/png",
          },
        ],
      },
    ];

    const withImage = assembleContext(
      path,
      undefined,
      new Map([["att-1", { kind: "image", mediaType: "image/png", data: "AAA" }]]),
    );
    expect(withImage[1].content).toEqual([
      { type: "text", text: "Hvad er der på billedet?" },
      { type: "image", mediaType: "image/png", data: "AAA" },
    ]);

    // A file that has gone is simply not sent; the message still makes sense.
    expect(assembleContext(path)[1].content).toBe("Hvad er der på billedet?");
  });

  it("inlines a text attachment's fenced content into the message the model reads", () => {
    const path = [
      {
        role: "user" as const,
        parts: [
          { type: "text" as const, text: "Hvad returnerer funktionen?" },
          {
            type: "attachment" as const,
            attachmentId: "att-txt",
            kind: "text" as const,
            filename: "script.py",
            mediaType: "text/plain",
          },
        ],
      },
    ];

    const fenced = "script.py:\n```\ndef hej():\n    return 42\n```";
    const withText = assembleContext(
      path,
      undefined,
      new Map([["att-txt", { kind: "text", text: fenced }]]),
    );

    // Text files travel inline as part of the message text, not as a separate
    // content part — the model reads them the way it reads what the pupil typed.
    expect(withText[1].content).toBe(`Hvad returnerer funktionen?\n\n${fenced}`);

    // A text file that has gone leaves the typed message unchanged.
    expect(assembleContext(path)[1].content).toBe("Hvad returnerer funktionen?");
  });
});

/**
 * The model's reasoning, on its way to the pupil (PRD §20, §10).
 *
 * It is kept separate from the answer and never replayed to the model. Until
 * usage arrives, its estimate counts toward the same daily ceiling as text.
 */
describe("thinking passes through the loop", () => {
  const THINKING_STREAM = [
    {
      event: "response.reasoning_summary_text.delta",
      data: JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "Overvejer" }),
    },
    {
      event: "response.output_text.delta",
      data: JSON.stringify({ type: "response.output_text.delta", delta: "Svar" }),
    },
    {
      event: "response.completed",
      data: JSON.stringify({
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 5, output_tokens: 1 } },
      }),
    },
  ];

  function responsesAdapter(records = THINKING_STREAM) {
    const stub = stubFetch(() => streamingResponse(records), { responses: true });
    return {
      adapter: new GatewayAdapter({
        baseUrl: "http://cpa:8317",
        listenerKey: "k",
        fetch: stub.fetch,
      }),
      stub,
    };
  }

  it("yields the reasoning ahead of the answer", async () => {
    const { adapter } = responsesAdapter();
    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    expect(events[0]).toEqual({ type: "thinking-delta", text: "Overvejer" });
    expect(events[1]).toEqual({ type: "text-delta", text: "Svar" });
  });

  /**
   * A summary is a window onto how the answer was reached, not part of it. Sent
   * back it would be both wasted context and a confusing thing for a model to
   * read as its own previous words.
   */
  it("never replays a stored thinking part to the model", () => {
    const messages = assembleContext([
      { role: "user", parts: [{ type: "text", text: "Hej" }] },
      {
        role: "assistant",
        parts: [
          { type: "thinking", text: "Overvejer om det er et loop" },
          { type: "text", text: "Et loop gentager noget" },
        ],
      },
    ]);

    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Et loop gentager noget");
    expect(JSON.stringify(messages)).not.toContain("Overvejer");
  });

  /**
   * `output_tokens` already includes reasoning: settlement must replace the
   * combined provisional estimate, rather than adding provider usage to it.
   */
  it("replaces the combined reasoning/text estimate with reported usage", async () => {
    const { adapter } = responsesAdapter();
    const events = await collect(
      runTurn({
        adapter,
        dialect: "openai",
        model: "m",
        path,
        budgets: {
          perTurnStepCap: 20,
          perTurnWallClockSeconds: 300,
          perTurnTokenCap: 100_000,
          // Four estimated output tokens fit. Adding the reported six tokens
          // instead of replacing the provisional total would exhaust this cap.
          perStudentDailyTokens: estimateTokens(promptTextOf(assembleContext(path))) + 5,
          perClassroomDailyTokens: 2_500_000,
        },
      }),
    );

    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(events.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", inputTokens: 5, outputTokens: 1, estimated: false, finishReason: "stop" },
    ]);
  });

  it("warns and stops during reasoning before an answer or provider usage arrives", async () => {
    const { adapter } = responsesAdapter(
      Array.from({ length: 20 }, () => ({
        event: "response.reasoning_summary_text.delta",
        data: JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          delta: "r".repeat(400),
        }),
      })),
    );
    const promptTokens = estimateTokens(promptTextOf(assembleContext(path)));
    const events = await collect(
      runTurn({
        adapter,
        dialect: "openai",
        model: "m",
        path,
        budgets: {
          perTurnStepCap: 20,
          perTurnWallClockSeconds: 300,
          perTurnTokenCap: 100_000,
          perStudentDailyTokens: promptTokens + 500,
          perClassroomDailyTokens: 2_500_000,
        },
      }),
    );
    expect(events.filter((event) => event.type === "thinking-delta")).toHaveLength(5);
    expect(events.some((event) => event.type === "text-delta")).toBe(false);
    expect(events.filter((event) => event.type === "budget-warning")).toHaveLength(1);
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      inputTokens: promptTokens,
      outputTokens: 500,
      estimated: true,
    });
    expect(events.at(-1)).toEqual({ type: "done", reason: "student-allowance-exhausted" });
  });
});

describe("the day's reservation, held a share at a time (§10)", () => {
  /** Ten deltas of 300 characters: about a thousand estimated tokens of answer. */
  const LONG_STREAM = [
    ...Array.from({ length: 10 }, () =>
      JSON.stringify({ choices: [{ delta: { content: "x".repeat(300) } }] }),
    ),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 1_000 } }),
    "[DONE]",
  ];

  /** A lease that hands out `share` tokens of output a time, then what `after` says. */
  function lease(share: number, after: "more" | "stop") {
    const asked: number[] = [];
    return {
      asked,
      dailyBudget: {
        consumed: () => ({ studentTokens: 0, classroomTokens: 0 }),
        reserve(promptTokens: number) {
          asked.push(promptTokens);
          if (asked.length > 1 && after === "stop") {
            return { stop: "student-allowance-exhausted" as const };
          }
          return { outputTokens: share, limit: null };
        },
        settle() {},
        release() {},
      },
    };
  }

  it("holds more as a long answer runs past its share, and finishes it", async () => {
    const { adapter } = adapterOver(() => streamingResponse(LONG_STREAM));
    const { asked, dailyBudget } = lease(300, "more");

    const events = await collect(
      runTurn({ adapter, dialect: "openai", model: "m", path, dailyBudget }),
    );

    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(events.filter((event) => event.type === "text-delta")).toHaveLength(10);
    // Each time again with what the request had used so far.
    expect(asked.length).toBeGreaterThan(2);
    expect(asked).toEqual([...asked].sort((a, b) => a - b));
  });

  it("stops where the day has nothing more to hold", async () => {
    const { adapter } = adapterOver(() => streamingResponse(LONG_STREAM));
    const { dailyBudget } = lease(300, "stop");

    const events = await collect(
      runTurn({ adapter, dialect: "openai", model: "m", path, dailyBudget }),
    );

    expect(events.at(-1)).toEqual({ type: "done", reason: "student-allowance-exhausted" });
    expect(events.filter((event) => event.type === "text-delta").length).toBeLessThan(10);
  });
});
