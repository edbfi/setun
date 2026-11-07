import { and, desc, eq } from "drizzle-orm";
import type { DocumentFormat } from "../../documents/formats";
import type { AppDatabase } from "../client";
import { type GeneratedDocument, generatedDocument } from "../schema";

/**
 * Generated document records.
 *
 * Every read is owner-scoped in the statement itself, as for images: a query
 * that could answer without a student id would be the hole (§21).
 */

export function recordGeneratedDocument(
  db: AppDatabase,
  input: {
    studentId: string;
    conversationId?: string | null;
    title: string;
    format: DocumentFormat;
    mediaType: string;
    storagePath: string;
  },
): GeneratedDocument {
  return db
    .insert(generatedDocument)
    .values({
      studentId: input.studentId,
      conversationId: input.conversationId ?? null,
      title: input.title,
      format: input.format,
      mediaType: input.mediaType,
      storagePath: input.storagePath,
    })
    .returning()
    .get();
}

/** One document, for its owner. Absent rather than forbidden for anyone else (§21). */
export function getOwnedDocument(
  db: AppDatabase,
  input: { documentId: string; studentId: string },
): GeneratedDocument | undefined {
  return db
    .select()
    .from(generatedDocument)
    .where(
      and(
        eq(generatedDocument.id, input.documentId),
        eq(generatedDocument.studentId, input.studentId),
      ),
    )
    .get();
}

/** The student's own documents, newest first. */
export function listStudentDocuments(db: AppDatabase, studentId: string): GeneratedDocument[] {
  return db
    .select()
    .from(generatedDocument)
    .where(eq(generatedDocument.studentId, studentId))
    .orderBy(desc(generatedDocument.createdAt))
    .all();
}

/**
 * Delete one owned document's row. True when a row went.
 *
 * Called only after its bytes are gone: the row is the only record of where
 * they live, so deleting it first would strand them on the volume if the file
 * removal then failed (§16, §21).
 */
export function deleteOwnedDocument(
  db: AppDatabase,
  input: { documentId: string; studentId: string },
): boolean {
  return (
    db
      .delete(generatedDocument)
      .where(
        and(
          eq(generatedDocument.id, input.documentId),
          eq(generatedDocument.studentId, input.studentId),
        ),
      )
      .returning({ id: generatedDocument.id })
      .all().length > 0
  );
}

export function attachDocumentToMessage(
  db: AppDatabase,
  input: { documentId: string; messageId: string },
): void {
  db.update(generatedDocument)
    .set({ messageId: input.messageId })
    .where(eq(generatedDocument.id, input.documentId))
    .run();
}
