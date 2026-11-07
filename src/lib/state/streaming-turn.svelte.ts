import type { MessagePart, TurnNotice as PersistedTurnNotice } from "$lib/server/db/schema";
import type { ContinueCause, ElicitationFieldSpec, GatewayEvent } from "$lib/server/gateway/events";

/**
 * The in-flight turn, client side (PRD §10, §11).
 *
 * A container class rather than bare exported `let`s, so reactivity survives the
 * import boundary — and instantiated per session through context rather than as
 * a module singleton, because a module singleton is shared across every SSR
 * request on the server.
 *
 * The turn is accumulated as the same `MessagePart[]` the server persists, so a
 * turn being watched live and the same turn after a reload render through one
 * component and cannot drift apart. Both are folded from the same normalised
 * event stream; neither is derived from the other (§10).
 *
 * Types only from server modules. Types are erased at compile time, so this does
 * not pull a server module into the client bundle; it is the same normalised
 * contract on both sides of the wire.
 */

/**
 * Why the last turn ended, when it ended in a way worth telling the student.
 *
 * The server's own union, so the live notice and the one persisted on the
 * message cannot name different sets of reasons. Null while the turn is running
 * or when it simply finished.
 */
export type TurnNotice = PersistedTurnNotice | null;

/** A tool call waiting on the student's yes or no (§11). */
export interface PendingPermission {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly serverLabel: string | null;
  readonly sensitive: boolean;
  readonly arguments: unknown;
}

/** A tool call waiting on the student's answers (§11). */
export interface PendingElicitation {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly serverLabel: string | null;
  readonly message: string;
  readonly fields: readonly ElicitationFieldSpec[];
}

/**
 * The day's allowance is 70 % spent, shown while the answer keeps arriving (§10).
 *
 * `acknowledged` is set by the pupil pressing "Keep going", which answers the
 * checkpoint early so the boundary does not stop to ask again.
 */
export interface BudgetWarning {
  readonly requestId: string;
  readonly fraction: number;
  readonly usedTokens: number;
  readonly limitTokens: number;
  readonly acknowledged: boolean;
}

/** A checkpoint waiting on "keep going" or "stop here" (§10). */
export interface PendingContinue {
  readonly requestId: string;
  readonly cause: ContinueCause;
  readonly steps: number;
  readonly tokens: number;
  readonly elapsedMs: number;
  readonly usedTokens: number;
  readonly limitTokens: number;
}

/** A turn that reached its `done` event: how long it took, and why it ended. */
export interface TurnFinished {
  readonly turnId: string | null;
  /** The conversation it answered, so "Done" is shown there and nowhere else. */
  readonly conversationId: string | null;
  readonly elapsedMs: number;
  /** `stop` is the model's own end; anything else cut the answer short. */
  readonly reason: string;
}

export class StreamingTurn {
  /** The turn so far, in the order it happened. Plain text while streaming (§20). */
  parts = $state<MessagePart[]>([]);
  /** When this turn began, so the placeholder can say how long it has been (§20). */
  startedAt = $state<number | null>(null);
  /** When reasoning first arrived, and when the first visible output replaced it. */
  thinkingStartedAt = $state<number | null>(null);
  thinkingSettledAt = $state<number | null>(null);
  /** Each reasoning part has its own interval, including reasoning after a tool result. */
  thinkingTimings = $state<Record<number, { startedAt: number; settledAt: number | null }>>({});
  turnId = $state<string | null>(null);
  /**
   * The conversation this turn answers in (§10).
   *
   * A turn keeps running when the pupil opens another conversation, and a
   * pupil may have one going in each of several. Without this the live answer
   * was drawn into whichever conversation was on screen — so "New
   * conversation" during a long answer seemed to go nowhere. Null once cleared.
   */
  conversationId = $state<string | null>(null);
  /** Last sequence number applied — the cursor a resume continues from (§10). */
  lastSeq = $state(-1);
  notice = $state<TurnNotice>(null);
  /** At most one question is open at a time: the loop asks and then waits (§11). */
  permission = $state<PendingPermission | null>(null);
  elicitation = $state<PendingElicitation | null>(null);
  /**
   * Kept across `clear()` on purpose: the banner is about the pupil's day, not
   * about this turn, and it should still be there once the streaming message has
   * been replaced by the persisted one. Its buttons only appear while streaming.
   */
  budgetWarning = $state<BudgetWarning | null>(null);
  continuePrompt = $state<PendingContinue | null>(null);
  /**
   * How the last turn ended, for the "done" stage and the done cue (§20).
   *
   * Kept across `clear()` like the budget banner: the live message is replaced
   * by the persisted one the moment the turn ends, and "Done · 23 s" belongs
   * under that one. Cleared when the next turn begins. A fresh object per turn,
   * so anything watching for a turn to end sees each one.
   */
  finished = $state<TurnFinished | null>(null);
  /** True while the server summarises a long conversation before answering (§10). */
  compacting = $state(false);
  #streaming = $state(false);
  /** Injectable, so the elapsed figures are testable without waiting (§22). */
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get streaming(): boolean {
    return this.#streaming;
  }

  /** The reasoning so far, as one string. Empty when there is none (§20). */
  get thinking(): string {
    return this.parts
      .filter((part) => part.type === "thinking")
      .map((part) => part.text)
      .join("");
  }

  /**
   * Whether anything the pupil reads as the *answer* has arrived.
   *
   * Thinking does not count: the placeholder should keep running while the model
   * reasons, because the answer has not begun.
   */
  get hasVisibleOutput(): boolean {
    return this.parts.some((part) => part.type !== "thinking" && part.type !== "context-compacted");
  }

  /** The prose so far, for the plain-text render while the turn streams (§20). */
  get text(): string {
    return this.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  get isEmpty(): boolean {
    return this.parts.length === 0;
  }

  /** Whether anything is waiting on the student right now. */
  get waiting(): boolean {
    return this.permission !== null || this.elicitation !== null || this.continuePrompt !== null;
  }

  /** The pupil pressed "Keep going" on the banner; the answer went to the server. */
  acknowledgeWarning(): void {
    if (this.budgetWarning) this.budgetWarning = { ...this.budgetWarning, acknowledged: true };
  }

  begin(turnId: string, conversationId: string | null = null): void {
    this.turnId = turnId;
    this.conversationId = conversationId;
    this.parts = [];
    this.lastSeq = -1;
    this.notice = null;
    this.permission = null;
    this.elicitation = null;
    this.budgetWarning = null;
    this.continuePrompt = null;
    this.finished = null;
    this.compacting = false;
    this.startedAt = this.#now();
    this.thinkingStartedAt = null;
    this.thinkingSettledAt = null;
    this.thinkingTimings = {};
    this.#streaming = true;
  }

  /** Resume an existing turn, keeping any text already rendered. */
  resume(turnId: string, afterSeq: number, conversationId: string | null = null): void {
    this.turnId = turnId;
    this.conversationId = conversationId ?? this.conversationId;
    this.lastSeq = afterSeq;
    this.notice = null;
    this.startedAt ??= this.#now();
    this.#streaming = true;
  }

  /**
   * Apply one normalised event.
   *
   * Events at or below the cursor are ignored, so a resume that overlaps what
   * the tab already rendered cannot duplicate text (§10).
   */
  apply(event: GatewayEvent, seq: number): void {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;

    // A checkpoint is answered or superseded by the very next event: anything
    // else arriving means the loop moved on, and a prompt still on screen would
    // be answering a question nobody is waiting for.
    if (event.type !== "continue-request") this.continuePrompt = null;

    switch (event.type) {
      case "text-delta":
        if (!event.text) break;
        this.#settleThinking();
        this.#appendText(event.text);
        break;

      case "thinking-delta":
        if (!event.text) break;
        this.thinkingStartedAt ??= this.#now();
        this.#appendThinking(event.text);
        break;

      case "permission-request":
        this.permission = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          serverLabel: event.serverLabel ?? null,
          sensitive: event.sensitive,
          arguments: event.arguments,
        };
        break;

      case "elicitation-request":
        this.elicitation = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          serverLabel: event.serverLabel ?? null,
          message: event.message,
          fields: event.fields,
        };
        break;

      case "tool-call-started":
        this.#settleThinking();
        this.permission = null;
        this.parts = [
          ...this.parts,
          {
            type: "tool-call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            serverLabel: event.serverLabel ?? null,
            arguments: event.arguments,
            decision: "auto",
          },
        ];
        break;

      case "tool-result": {
        this.#settleThinking();
        // A call refused by the permission mode never announced itself, so the
        // result is the first the transcript hears of it.
        const announced = this.parts.some(
          (part) => part.type === "tool-call" && part.toolCallId === event.toolCallId,
        );
        const pending = this.permission;
        this.permission = null;
        this.elicitation = null;

        if (!announced && pending?.toolCallId === event.toolCallId) {
          this.parts = [
            ...this.parts,
            {
              type: "tool-call",
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              serverLabel: pending.serverLabel,
              arguments: pending.arguments,
              decision: event.decision ?? "approved",
            },
          ];
        }

        this.parts = [
          ...this.parts,
          {
            type: "tool-result",
            toolCallId: event.toolCallId,
            result: event.result,
            isError: event.isError,
          },
        ];
        break;
      }

      case "budget-warning":
        this.budgetWarning = {
          requestId: event.requestId,
          fraction: event.fraction,
          usedTokens: event.usedTokens,
          limitTokens: event.limitTokens,
          acknowledged: false,
        };
        break;

      case "continue-request":
        this.continuePrompt = {
          requestId: event.requestId,
          cause: event.cause,
          steps: event.turn.steps,
          tokens: event.turn.tokens,
          elapsedMs: event.turn.elapsedMs,
          usedTokens: event.daily.usedTokens,
          limitTokens: event.daily.limitTokens,
        };
        break;

      case "compacting":
        this.compacting = true;
        break;

      case "context-compacted":
        this.compacting = false;
        // At the head of the message, where the persisted one has it.
        if (!this.parts.some((part) => part.type === "context-compacted")) {
          this.parts = [{ type: "context-compacted", mode: event.mode }, ...this.parts];
        }
        break;

      case "image-generated":
        this.#settleThinking();
        this.parts = [
          ...this.parts,
          { type: "generated-image", imageId: event.imageId, prompt: event.prompt },
        ];
        break;

      case "document-created":
        this.#settleThinking();
        this.parts = [
          ...this.parts,
          {
            type: "generated-document",
            documentId: event.documentId,
            title: event.title,
            format: event.format,
          },
        ];
        break;

      case "error":
        this.notice = "error";
        break;

      case "done":
        this.#streaming = false;
        this.compacting = false;
        this.permission = null;
        this.elicitation = null;
        this.continuePrompt = null;
        this.#settleThinking();
        // `stop` is the model reaching its own end and announces nothing. Every
        // other reason cut the answer short, including a per-turn cap, which
        // stops at a clean boundary and keeps the partial answer on screen — a
        // friendly notice, never an error (§10).
        this.notice = event.reason === "stop" ? null : event.reason;
        this.finished = {
          turnId: this.turnId,
          conversationId: this.conversationId,
          elapsedMs: this.startedAt === null ? 0 : Math.max(0, this.#now() - this.startedAt),
          reason: event.reason,
        };
        break;

      default:
        break;
    }
  }

  /** Give up on the stream without claiming the turn ended. */
  detach(): void {
    this.#settleThinking();
    this.#streaming = false;
    this.permission = null;
    this.elicitation = null;
    this.continuePrompt = null;
  }

  clear(): void {
    this.parts = [];
    this.turnId = null;
    this.conversationId = null;
    this.lastSeq = -1;
    this.startedAt = null;
    this.thinkingStartedAt = null;
    this.thinkingSettledAt = null;
    this.thinkingTimings = {};
    this.notice = null;
    this.permission = null;
    this.elicitation = null;
    this.continuePrompt = null;
    // The banner is deliberately not cleared: it is about the day's allowance,
    // and a pupil whose turn has just been persisted should still see it.
    this.#streaming = false;
  }

  /**
   * Grow the trailing text part rather than adding one per delta.
   *
   * A message of ten thousand one-character parts renders the same and costs a
   * great deal more on the target hardware (§20).
   */
  #appendText(text: string): void {
    const last = this.parts.at(-1);

    if (last?.type === "text") {
      this.parts = [...this.parts.slice(0, -1), { type: "text", text: last.text + text }];
    } else {
      this.parts = [...this.parts, { type: "text", text }];
    }
  }

  /** The same growth for the reasoning, which arrives in the same many fragments. */
  #appendThinking(text: string): void {
    const last = this.parts.at(-1);

    if (last?.type === "thinking") {
      const index = this.parts.length - 1;
      const timing = this.thinkingTimings[index];
      if (timing && timing.settledAt !== null) {
        this.thinkingTimings = { ...this.thinkingTimings, [index]: { ...timing, settledAt: null } };
      }
      this.parts = [...this.parts.slice(0, -1), { type: "thinking", text: last.text + text }];
    } else {
      this.thinkingTimings = {
        ...this.thinkingTimings,
        [this.parts.length]: { startedAt: this.#now(), settledAt: null },
      };
      this.parts = [...this.parts, { type: "thinking", text }];
    }
  }

  /** Usage and checkpoint events do not append an answer or end a reasoning part. */
  #settleThinking(): void {
    const index = this.parts.length - 1;
    const timing = this.thinkingTimings[index];
    if (this.parts[index]?.type !== "thinking" || !timing || timing.settledAt !== null) return;
    const settledAt = this.#now();
    this.thinkingTimings = { ...this.thinkingTimings, [index]: { ...timing, settledAt } };
    this.thinkingSettledAt ??= settledAt;
  }
}
