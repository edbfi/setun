import { type StreamingSegment, streamingMessageSegments } from "$lib/artifacts/segments";
import * as m from "$lib/paraglide/messages";
import type { MessagePart } from "$lib/server/db/schema";
import { toolLabel } from "./tool-labels";

/**
 * What a running turn is doing right now, in one word a pupil can read (PRD §20).
 *
 * "When is it done?" is the question a classroom asks most, and nobody can
 * answer it — but every second of a turn *is* doing something nameable:
 * reasoning, running a tool, writing a particular file, writing the answer. A
 * line that names it, and changes when it changes, is what tells a pupil the
 * model has not frozen.
 *
 * Pure, and derived from what the turn has already accumulated plus the scan
 * the transcript already made, so it costs no second pass over the text (§20).
 * The type imports are erased at compile time.
 */
export type TurnStage =
  /** Nothing has arrived yet. */
  | { readonly kind: "starting" }
  | { readonly kind: "thinking" }
  /** A tool call is out, with no result yet. */
  | { readonly kind: "tool"; readonly toolName: string }
  /** The text so far ends inside an artifact file. */
  | {
      readonly kind: "file";
      /** What to call it: the path, else the title, else null for the language. */
      readonly name: string | null;
      readonly language: string;
      readonly deleting: boolean;
    }
  /** Prose is arriving. */
  | { readonly kind: "answering" }
  /** Between steps: a tool came back, an image landed, and the model goes on. */
  | { readonly kind: "working" }
  /** A permission, a question or a checkpoint is waiting on the pupil. */
  | { readonly kind: "waiting" }
  /** The start of a long conversation is being summarised before the answer (§10). */
  | { readonly kind: "compacting" };

export interface TurnStageInput {
  readonly parts: readonly MessagePart[];
  /** The streaming scan of the last text part, when the last part is text. */
  readonly lastSegments?: readonly StreamingSegment[];
  /** Whether a permission, an elicitation or a checkpoint is open. */
  readonly waiting: boolean;
  /** Whether the server is summarising the conversation before the answer. */
  readonly compacting?: boolean;
}

export function turnStage({
  parts,
  lastSegments = [],
  waiting,
  compacting = false,
}: TurnStageInput): TurnStage {
  if (waiting) return { kind: "waiting" };
  if (compacting) return { kind: "compacting" };

  // The compaction marker is about the context, not the answer: a turn holding
  // only that has not started answering yet.
  const last = parts.findLast((part) => part.type !== "context-compacted");
  if (!last) return { kind: "starting" };

  // A tool still out wins over whatever came after its call: the loop is
  // waiting on it whatever the model said first.
  const answered = new Set(
    parts.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : [])),
  );
  const running = parts.findLast(
    (part): part is Extract<MessagePart, { type: "tool-call" }> =>
      part.type === "tool-call" && part.decision !== "declined" && !answered.has(part.toolCallId),
  );
  if (running) return { kind: "tool", toolName: running.toolName };

  switch (last.type) {
    case "thinking":
      return { kind: "thinking" };
    case "text": {
      const tail = lastSegments.at(-1);
      if (tail?.kind === "pending") {
        return {
          kind: "file",
          name: tail.path ?? tail.title,
          language: tail.language ?? tail.fileKind,
          deleting: tail.deleted,
        };
      }
      return { kind: "answering" };
    }
    default:
      return { kind: "working" };
  }
}

/** The line the activity row shows for a stage; "starting" has its own rotation. */
export function stageLabel(stage: Exclude<TurnStage, { kind: "starting" }>): string {
  switch (stage.kind) {
    case "thinking":
      return m.chat_thinking();
    case "tool":
      return m.chat_tool_running({ tool: toolLabel(stage.toolName) });
    case "file": {
      const path = stage.name ?? m.artifact_untitled({ language: stage.language });
      return stage.deleting
        ? m.artifact_card_deleting({ path })
        : m.artifact_card_writing({ path });
    }
    case "answering":
      return m.chat_stage_answering();
    case "working":
      return m.chat_stage_working();
    case "waiting":
      return m.chat_stage_waiting();
    case "compacting":
      return m.chat_stage_compacting();
  }
}

/**
 * The streaming scan of a turn's text parts, keyed by part index (§13, §20).
 *
 * The parts are scanned together, because a fence can span the boundary a tool
 * call or an image made between two deltas.
 */
export function streamingPartSegments(
  parts: readonly MessagePart[],
): Map<number, StreamingSegment[]> {
  const texts: string[] = [];
  const indexes: number[] = [];
  parts.forEach((part, index) => {
    if (part.type !== "text") return;
    texts.push(part.text);
    indexes.push(index);
  });

  const byIndex = new Map<number, StreamingSegment[]>();
  streamingMessageSegments(texts).forEach((segments, at) => {
    byIndex.set(indexes[at], segments);
  });
  return byIndex;
}
