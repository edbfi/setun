import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { conversation } from "./conversation";
import { createdAt, primaryId } from "./helpers";
import { message } from "./message";
import { student } from "./student";

export const TURN_STATUSES = [
  "streaming",
  "completed",
  "aborted",
  "interrupted",
  "failed",
] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

/**
 * One pass of the agent loop (PRD §10).
 *
 * §19 describes tables in prose and does not enumerate this one, but §10 makes
 * it necessary: every event is buffered to the database as it streams so resume
 * replays from one source of truth, a restart marks in-flight turns interrupted
 * at boot, and the limit on answers in flight — one per conversation, the
 * classroom's `maxConcurrentTurns` per pupil — needs somewhere to be true. Deriving that from message rows
 * cannot express a turn that produced no message yet.
 */
export const turn = sqliteTable(
  "turn",
  {
    id: primaryId(),
    conversationId: text()
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /** Denormalised from the conversation so the in-flight check is one indexed read (§10). */
    studentId: text()
      .notNull()
      .references(() => student.id, { onDelete: "cascade" }),
    /** The user message this turn answers. */
    parentMessageId: text().references(() => message.id, { onDelete: "cascade" }),
    /** The assistant message, written when the turn reaches a terminal state. */
    assistantMessageId: text().references(() => message.id, { onDelete: "set null" }),
    status: text({ enum: TURN_STATUSES }).notNull().default("streaming"),
    createdAt: createdAt(),
    endedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("turn_student_status_idx").on(t.studentId, t.status)],
);

/**
 * The buffered normalised event stream of a turn (§10).
 *
 * `seq` is dense and per-turn, so a resuming client asks for everything after
 * the last sequence number it saw and the server replays exactly the remainder.
 */
export const turnEvent = sqliteTable(
  "turn_event",
  {
    id: primaryId(),
    turnId: text()
      .notNull()
      .references(() => turn.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    /** A serialised `GatewayEvent`; the adapter's normalised wire format (§9, §10). */
    payload: text({ mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("turn_event_seq_unique").on(t.turnId, t.seq)],
);

export type Turn = typeof turn.$inferSelect;
export type TurnEvent = typeof turnEvent.$inferSelect;
