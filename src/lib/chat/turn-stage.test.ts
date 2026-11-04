import { describe, expect, it } from "bun:test";
import { streamingSegments } from "$lib/artifacts/segments";
import * as m from "$lib/paraglide/messages";
import type { MessagePart } from "$lib/server/db/schema";
import { stageLabel, streamingPartSegments, turnStage } from "./turn-stage";

/**
 * The stage a running turn is in, named for a pupil (PRD §20).
 *
 * "When is it done?" cannot be answered, but "what is it doing?" always can —
 * and a turn that names a stage which never changes is the frozen-looking
 * screen this replaces.
 */

const call = (id: string, toolName = "search"): MessagePart => ({
  type: "tool-call",
  toolCallId: id,
  toolName,
  serverLabel: null,
  arguments: {},
  decision: "auto",
});

const result = (id: string): MessagePart => ({
  type: "tool-result",
  toolCallId: id,
  result: "ok",
  isError: false,
});

describe("turnStage", () => {
  it("is starting before anything arrives", () => {
    expect(turnStage({ parts: [], waiting: false })).toEqual({ kind: "starting" });
  });

  it("is thinking while the reasoning is the last thing to arrive", () => {
    expect(turnStage({ parts: [{ type: "thinking", text: "Hm" }], waiting: false })).toEqual({
      kind: "thinking",
    });
  });

  it("is answering while prose arrives", () => {
    const text = "Et loop gentager";
    expect(
      turnStage({
        parts: [{ type: "text", text }],
        lastSegments: streamingSegments(text),
        waiting: false,
      }),
    ).toEqual({ kind: "answering" });
  });

  it("names the file the text ends inside", () => {
    const text = "Her:\n```css id=side path=src/styles.css\np {";
    expect(
      turnStage({
        parts: [{ type: "text", text }],
        lastSegments: streamingSegments(text),
        waiting: false,
      }),
    ).toEqual({ kind: "file", name: "src/styles.css", language: "css", deleting: false });
  });

  it("names a single-file page by its title, and says when a file is being removed", () => {
    const titled = 'Her:\n```html id=side title="Min side"\n<p>';
    expect(
      turnStage({
        parts: [{ type: "text", text: titled }],
        lastSegments: streamingSegments(titled),
        waiting: false,
      }),
    ).toEqual({ kind: "file", name: "Min side", language: "html", deleting: false });

    const removing = "```ts id=side path=src/old.ts delete\n";
    expect(
      turnStage({
        parts: [{ type: "text", text: removing }],
        lastSegments: streamingSegments(removing),
        waiting: false,
      }),
    ).toMatchObject({ kind: "file", deleting: true });
  });

  it("names the tool still out, whatever came after its call", () => {
    expect(turnStage({ parts: [call("a", "load_skill")], waiting: false })).toEqual({
      kind: "tool",
      toolName: "load_skill",
    });
    // Answered: the model is working with what came back.
    expect(turnStage({ parts: [call("a"), result("a")], waiting: false })).toEqual({
      kind: "working",
    });
  });

  it("does not report a declined call as running", () => {
    const declined = { ...call("a"), decision: "declined" } as MessagePart;
    expect(turnStage({ parts: [declined], waiting: false })).toEqual({ kind: "working" });
  });

  it("says the conversation is being made room for while it is summarised", () => {
    expect(turnStage({ parts: [], waiting: false, compacting: true })).toEqual({
      kind: "compacting",
    });
    expect(stageLabel({ kind: "compacting" })).toBe(m.chat_stage_compacting());
  });

  it("is still starting when the only part is the compaction marker", () => {
    expect(
      turnStage({ parts: [{ type: "context-compacted", mode: "summarised" }], waiting: false }),
    ).toEqual({ kind: "starting" });
  });

  it("is waiting on the pupil whenever a question is open", () => {
    expect(turnStage({ parts: [call("a")], waiting: true })).toEqual({ kind: "waiting" });
  });
});

describe("stageLabel", () => {
  it("says each stage in the pupil's words", () => {
    expect(stageLabel({ kind: "thinking" })).toBe(m.chat_thinking());
    expect(stageLabel({ kind: "answering" })).toBe(m.chat_stage_answering());
    expect(stageLabel({ kind: "waiting" })).toBe(m.chat_stage_waiting());
    expect(
      stageLabel({ kind: "file", name: "home-page.html", language: "html", deleting: false }),
    ).toBe(m.artifact_card_writing({ path: "home-page.html" }));
    expect(stageLabel({ kind: "file", name: null, language: "svg", deleting: false })).toBe(
      m.artifact_card_writing({ path: m.artifact_untitled({ language: "svg" }) }),
    );
  });
});

describe("streamingPartSegments", () => {
  it("keys the scan by part index, across a tool call inside a fence", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "```html id=side\n<p>" },
      call("a"),
      { type: "text", text: "</p>\n```\nFærdig." },
    ];
    const byPart = streamingPartSegments(parts);

    expect([...byPart.keys()]).toEqual([0, 2]);
    expect(byPart.get(0)?.map((segment) => segment.kind)).toEqual(["artifact"]);
    expect(byPart.get(2)).toEqual([{ kind: "text", text: "Færdig." }]);
  });
});
