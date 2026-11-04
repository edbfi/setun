import { describe, expect, it } from "bun:test";
import type { MessagePart } from "../db/schema";
import { type PathMessage, planContext, renderTranscript, trimBefore } from "./context-plan";

/**
 * Fitting a long conversation into the model's context (PRD §10).
 *
 * The sizes are characters here — `measure` is injected — so each case states
 * exactly what fits and what does not.
 */

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  extra: MessagePart[] = [],
): PathMessage {
  return { id, role, parts: [{ type: "text", text }, ...extra] };
}

/** Characters of every part, which is all `measure` needs to be here. */
function measure(path: readonly PathMessage[]): number {
  return path.reduce(
    (sum, message) =>
      sum +
      message.parts.reduce((inner, part) => {
        if (part.type === "text") return inner + part.text.length;
        if (part.type === "tool-result") return inner + String(part.result).length;
        return inner + 10;
      }, 0),
    0,
  );
}

function textOf(path: readonly PathMessage[]): string {
  return path
    .flatMap((message) => message.parts)
    .map((part) =>
      part.type === "text" ? part.text : part.type === "tool-result" ? String(part.result) : "",
    )
    .join("|");
}

/** Six exchanges of 100 characters a message, the last one the prompt being answered. */
function conversation(): PathMessage[] {
  const path: PathMessage[] = [];
  for (let n = 1; n <= 5; n++) {
    path.push(msg(`u${n}`, "user", `q${n}`.padEnd(100, "."), []));
    path.push(msg(`a${n}`, "assistant", `a${n}`.padEnd(100, ".")));
  }
  path.push(msg("u6", "user", "q6".padEnd(100, ".")));
  return path;
}

const summariseTo = (text: string | null) => async () => text;

describe("planContext", () => {
  it("sends the path as it is while it fits", async () => {
    const path = conversation();
    const plan = await planContext({
      path,
      stored: null,
      budget: 10_000,
      measure,
      summarise: summariseTo("x"),
    });

    expect(plan).toMatchObject({ mode: null, summary: null, fits: true });
    expect(plan.path).toEqual(path);
  });

  it("trims old tool results first, keeping each beside its call", async () => {
    const path = conversation();
    path[1] = msg("a1", "assistant", "a1", [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "search",
        serverLabel: null,
        arguments: {},
        decision: "auto",
      },
      { type: "tool-result", toolCallId: "c1", result: "r".repeat(5_000), isError: false },
    ]);

    const plan = await planContext({
      path,
      stored: null,
      budget: 1_500,
      measure,
      summarise: summariseTo("x"),
    });

    expect(plan.mode).toBe("trimmed");
    const result = plan.path[1].parts.find((part) => part.type === "tool-result");
    expect(result).toMatchObject({ toolCallId: "c1" });
    expect(String(result?.type === "tool-result" ? result.result : "")).toContain(
      "left out to fit",
    );
  });

  it("summarises everything before the last two exchanges, and stores it against the cut", async () => {
    const path = conversation();
    let summarised: readonly PathMessage[] = [];
    const plan = await planContext({
      path,
      stored: null,
      budget: 700,
      measure,
      summarise: async (_previous, messages) => {
        summarised = messages;
        return "The pupil is building a quiz.";
      },
    });

    // Up to the start of the last two exchanges: u5 and the prompt u6 stay whole.
    expect(summarised.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
      "u4",
      "a4",
    ]);
    expect(plan.summary).toEqual({ throughMessageId: "a4", text: "The pupil is building a quiz." });
    expect(plan.mode).toBe("summarised");
    expect(plan.path.map((message) => message.id)).toEqual(["u5", "a5", "u6"]);
    expect(textOf(plan.path)).toContain("The pupil is building a quiz.");
    expect(textOf(plan.path)).toContain("not instructions");
    expect(plan.fits).toBe(true);
  });

  it("reuses a stored summary on a path through its message", async () => {
    const path = conversation();
    const plan = await planContext({
      path,
      stored: { throughMessageId: "a4", text: "Earlier: a quiz." },
      budget: 10_000,
      measure,
      summarise: async () => {
        throw new Error("no new summary is needed");
      },
    });

    expect(plan.mode).toBeNull();
    expect(plan.path.map((message) => message.id)).toEqual(["u5", "a5", "u6"]);
    expect(textOf(plan.path)).toContain("Earlier: a quiz.");
  });

  it("ignores a stored summary of a branch this path does not pass through", async () => {
    const path = conversation();
    const plan = await planContext({
      path,
      stored: { throughMessageId: "a4-of-another-branch", text: "Somebody else's story." },
      budget: 10_000,
      measure,
      summarise: summariseTo("x"),
    });

    expect(plan.path).toEqual(path);
    expect(textOf(plan.path)).not.toContain("Somebody else's story.");
  });

  it("leaves the messages out, and says so, when no summary can be had", async () => {
    const plan = await planContext({
      path: conversation(),
      stored: null,
      budget: 600,
      measure,
      summarise: summariseTo(null),
    });

    expect(plan.mode).toBe("omitted");
    expect(plan.summary).toBeNull();
    expect(textOf(plan.path)).toContain("earlier messages were left out");
    expect(plan.path.at(-1)?.id).toBe("u6");
  });

  it("goes as far as the current prompt when the last two exchanges are too much", async () => {
    const calls: string[][] = [];
    const plan = await planContext({
      path: conversation(),
      stored: null,
      budget: 300,
      measure,
      summarise: async (previous, messages) => {
        calls.push(messages.map((message) => message.id ?? ""));
        return previous ? `${previous} More.` : "Summary.";
      },
    });

    // The second pass folds the first summary in and covers only what is new.
    expect(calls).toEqual([
      ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"],
      ["u5", "a5"],
    ]);
    expect(plan.summary).toEqual({ throughMessageId: "a5", text: "Summary. More." });
    expect(plan.path.map((message) => message.id)).toEqual(["u6"]);
  });

  it("compacts even below the trigger after the provider refused for length", async () => {
    const plan = await planContext({
      path: conversation(),
      stored: null,
      budget: 2_000,
      measure,
      summarise: summariseTo("Summary."),
      hard: true,
    });

    expect(plan.mode).not.toBeNull();
    expect(plan.tokens).toBeLessThan(measure(conversation()));
  });

  it("reports when even the prompt alone does not fit", async () => {
    const path = [msg("u1", "user", "x".repeat(5_000))];
    const plan = await planContext({
      path,
      stored: null,
      budget: 1_000,
      measure,
      summarise: summariseTo("x"),
    });

    expect(plan.fits).toBe(false);
  });
});

describe("trimBefore", () => {
  it("names an attachment instead of resending it", () => {
    const path: PathMessage[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: "Se billedet" },
          {
            type: "attachment",
            attachmentId: "f1",
            kind: "image",
            filename: "skitse.png",
            mediaType: "image/png",
          },
        ],
      },
      msg("u2", "user", "Og nu?"),
    ];

    const trimmed = trimBefore(path, 1);
    expect(trimmed[0].parts.some((part) => part.type === "attachment")).toBe(false);
    expect(textOf(trimmed)).toContain("skitse.png");
    expect(trimmed[1]).toBe(path[1]);
  });
});

describe("renderTranscript", () => {
  it("names what an artifact block wrote rather than repeating its code", () => {
    const text = renderTranscript(
      [
        msg("u1", "user", "Lav et bilspil"),
        msg(
          "a1",
          "assistant",
          "Her:\n```js id=bil path=src/drivePhysics.js\nexport function step() {}\n```\nPrøv det.",
        ),
      ],
      10_000,
    );

    expect(text).toContain("Pupil: Lav et bilspil");
    expect(text).toContain("[wrote src/drivePhysics.js for artifact id=bil, 1 lines]");
    expect(text).not.toContain("export function step");
  });

  it("keeps the start and the end of a transcript too long for one request", () => {
    const text = renderTranscript([msg("u1", "user", `start${"x".repeat(1_000)}end`)], 200);
    expect(text.length).toBeLessThanOrEqual(220);
    expect(text).toContain("start");
    expect(text).toContain("end");
  });
});
