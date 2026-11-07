import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DOCUMENT_FORMATS } from "../../documents/formats";
import { conversation } from "./conversation";
import { createdAt, primaryId } from "./helpers";
import { message } from "./message";
import { student } from "./student";

/**
 * A document the model wrote for a pupil (docx or csv).
 *
 * A creation, like a generated image: the conversation and message references
 * are nullable so the document outlives the conversation that produced it, and
 * the classroom's creation retention governs it rather than the thirty-day
 * conversation expiry (§16).
 *
 * The bytes are the record. The Markdown it was rendered from is not kept here;
 * it stays in the tool call's arguments on the message, for as long as the
 * conversation does.
 */
export const generatedDocument = sqliteTable(
  "generated_document",
  {
    id: primaryId(),
    studentId: text()
      .notNull()
      .references(() => student.id, { onDelete: "cascade" }),
    /** Null once the conversation that produced it has expired (§16). */
    conversationId: text().references(() => conversation.id, { onDelete: "set null" }),
    messageId: text().references(() => message.id, { onDelete: "set null" }),
    /** Model-written; shown on the card and used for the filename, never in the file. */
    title: text().notNull(),
    format: text({ enum: DOCUMENT_FORMATS }).notNull(),
    mediaType: text().notNull(),
    /** Relative to the storage root, which is outside any web root (§21). */
    storagePath: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("generated_document_student_idx").on(t.studentId, t.createdAt)],
);

export type GeneratedDocument = typeof generatedDocument.$inferSelect;
