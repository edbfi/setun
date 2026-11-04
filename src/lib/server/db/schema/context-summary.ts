import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { conversation } from "./conversation";
import { createdAt, primaryId } from "./helpers";
import { message } from "./message";

/**
 * What the model was told about the start of a long conversation (PRD §10).
 *
 * A conversation that outgrows the model's context window has its older part
 * summarised, and the summary stands in for those messages on every later turn.
 * It is derived data: the messages themselves are never changed, the pupil can
 * still scroll back through all of them, and the row goes with the conversation.
 *
 * Keyed by the last message it covers rather than by the conversation alone,
 * because the conversation is a tree (§10). A summary is valid on every path
 * through `throughMessageId` — so editing or regenerating something *after* it
 * reuses it, and a branch made *before* it never sees a summary of messages
 * that are not on that branch.
 */
export const contextSummary = sqliteTable(
  "context_summary",
  {
    id: primaryId(),
    conversationId: text()
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    throughMessageId: text()
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    /** Written by the model, for the model. Never shown to the pupil, never logged (§16, §21). */
    text: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("context_summary_conversation_idx").on(t.conversationId)],
);

export type ContextSummary = typeof contextSummary.$inferSelect;
