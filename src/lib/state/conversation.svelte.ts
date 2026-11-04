import type { ArtifactLanguage, BuildStatus } from "$lib/artifacts/types";
import type { MessagePart } from "$lib/server/db/schema";
import { StreamingTurn } from "./streaming-turn.svelte";

/**
 * The conversation a student is reading (PRD §10).
 *
 * Holds the active path of the message tree, not the whole tree: the tree lives
 * on the server, and the client renders one branch.
 */

/**
 * A message's place among its siblings, when it sits at a branch point (§10).
 *
 * Present only for a persisted message the server found to have siblings — the
 * variants an edit or a regenerate left addressable. `prevId`/`nextId` are the
 * neighbouring variants to step to, or null at an end.
 */
export interface MessageBranch {
  readonly index: number;
  readonly total: number;
  readonly prevId: string | null;
  readonly nextId: string | null;
}

/**
 * An artifact a message produced, as the transcript needs it (§13).
 *
 * One entry per artifact block the server recorded, in the order the blocks were
 * written, so the cards line up with the prose they were written between.
 */
export interface MessageArtifactRef {
  readonly artifactId: string;
  readonly versionId: string;
  readonly revision: number;
  readonly key: string;
  readonly language: ArtifactLanguage;
  readonly title: string | null;
  readonly buildStatus?: BuildStatus | null;
  /** Which file of the project runs (§13). */
  readonly entry?: string;
  /** How many files the project held at this revision. */
  readonly fileCount?: number;
  /** What this revision added and changed, for the card's one-line summary. */
  readonly added?: number;
  readonly modified?: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  /**
   * The message's content in the order it happened (§10, §11, §15).
   *
   * The same shape the server persists and the same shape a streaming turn
   * accumulates, so one component renders all three.
   */
  readonly parts: readonly MessagePart[];
  /** Branch-picker data, or null/absent for a message with no siblings. */
  readonly branch?: MessageBranch | null;
  /** The artifacts this message wrote, in recording order (§13). */
  readonly artifacts?: readonly MessageArtifactRef[];
}

/** The prose of a message, for the composer's edit flow (§10). */
export function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export class ConversationState {
  id = $state<string | null>(null);
  title = $state<string | null>(null);
  messages = $state<ChatMessage[]>([]);
  readonly turn = new StreamingTurn();

  constructor(input?: { id: string; title: string | null; messages: ChatMessage[] }) {
    if (input) {
      this.id = input.id;
      this.title = input.title;
      this.messages = input.messages;
    }
  }

  get lastMessage(): ChatMessage | undefined {
    return this.messages.at(-1);
  }

  /**
   * Whether the live turn belongs to the conversation on screen (§10).
   *
   * A turn keeps running when the pupil opens another conversation; it is drawn,
   * and its prompts and Stop button offered, only in the one it answers.
   */
  get turnHere(): boolean {
    return this.turn.conversationId === null || this.turn.conversationId === this.id;
  }

  /**
   * The conversation a live turn is running in, when that is not this one.
   *
   * Null when nothing is running, or when it is running here.
   */
  get turnElsewhere(): string | null {
    if (!this.turn.streaming || this.turnHere) return null;
    return this.turn.conversationId;
  }

  /** True while a turn is streaming or its text is still on screen unpersisted. */
  get hasPendingAssistantText(): boolean {
    return this.turn.streaming || !this.turn.isEmpty;
  }

  appendUserMessage(text: string, attachments: readonly MessagePart[] = []): ChatMessage {
    // Optimistic: the server assigns the real id, and the reload after the turn
    // reconciles it. Keyed `{#each}` needs a stable key in the meantime.
    const message: ChatMessage = {
      id: `pending-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }, ...attachments],
    };
    this.messages = [...this.messages, message];
    return message;
  }

  /** Fold a finished turn into the message list. */
  commitAssistantMessage(id: string): void {
    if (this.turn.isEmpty) {
      this.turn.clear();
      return;
    }

    this.messages = [...this.messages, { id, role: "assistant", parts: this.turn.parts }];
    this.turn.clear();
  }

  replaceMessages(messages: ChatMessage[]): void {
    this.messages = messages;
  }

  /**
   * Drop everything from a message onward.
   *
   * Editing a prompt branches the tree server-side; the client shows the new
   * branch, so the old one leaves the rendered path (§10).
   */
  truncateFrom(messageId: string): void {
    const index = this.messages.findIndex((message) => message.id === messageId);
    if (index >= 0) this.messages = this.messages.slice(0, index);
  }
}
