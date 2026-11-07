import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { AppDatabase } from "../client";
import {
  artifact,
  attachment,
  conversation,
  generatedDocument,
  generatedImage,
  session,
  student,
} from "../schema";
import { removeConversationFromIndex } from "./search";

/**
 * The reads and writes retention needs (PRD §16, §21).
 *
 * Kept apart from the owner-scoped query modules on purpose: every function here
 * deletes across owners, driven by a classroom policy rather than by a request,
 * and mixing that into modules whose contract is "always scoped to the caller"
 * would blur the invariant those modules exist to hold (§21).
 */

/** A file whose row is about to go, so the bytes can go with it. */
export interface DoomedFile {
  readonly storagePath: string;
}

/** The same, carrying the attachment row that names it. */
export interface DoomedAttachment extends DoomedFile {
  readonly id: string;
}

/** Conversations in one classroom last touched before `before`. */
export function expiredConversationIds(
  db: AppDatabase,
  input: { classroomId: string; before: Date },
): string[] {
  return db
    .select({ id: conversation.id })
    .from(conversation)
    .innerJoin(student, eq(student.id, conversation.studentId))
    .where(
      and(eq(student.classroomId, input.classroomId), lt(conversation.updatedAt, input.before)),
    )
    .all()
    .map((row) => row.id);
}

/**
 * Attachment files belonging to a set of conversations, before the rows go.
 *
 * Each file is returned with its row's id, so the caller can delete exactly the
 * rows whose bytes it managed to remove (§16).
 */
export function attachmentFilesFor(
  db: AppDatabase,
  conversationIds: readonly string[],
): DoomedAttachment[] {
  if (conversationIds.length === 0) return [];

  return db
    .select({ id: attachment.id, storagePath: attachment.storagePath })
    .from(attachment)
    .where(inArray(attachment.conversationId, [...conversationIds]))
    .all();
}

/**
 * Delete expired conversations, and the attachment rows whose bytes are gone.
 *
 * Messages, turns and any remaining attachments follow through the schema
 * cascades; artifacts and generated images do not, because their conversation
 * reference is nullable precisely so creations outlive the conversation that
 * produced them (§16).
 *
 * The two deletes share one synchronous transaction because they must not be
 * separable. An upload that landed after the caller read the attachment list
 * would otherwise be cascaded away by the conversation delete with its file
 * still on the volume and nothing left naming it — the orphan the caller's
 * bytes-before-rows ordering exists to prevent. A conversation still holding an
 * attachment row, whether from that race or from a removal that failed, is left
 * for the next pass, which reads it normally.
 */
export function deleteConversations(
  db: AppDatabase,
  input: { conversationIds: readonly string[]; removedAttachmentIds: readonly string[] },
): number {
  if (input.conversationIds.length === 0) return 0;

  return db.transaction((tx) => {
    if (input.removedAttachmentIds.length > 0) {
      tx.delete(attachment)
        .where(inArray(attachment.id, [...input.removedAttachmentIds]))
        .run();
    }

    const holding = new Set(
      tx
        .select({ conversationId: attachment.conversationId })
        .from(attachment)
        .where(inArray(attachment.conversationId, [...input.conversationIds]))
        .all()
        .map((row) => row.conversationId),
    );

    const deletable = input.conversationIds.filter((id) => !holding.has(id));
    if (deletable.length === 0) return 0;

    const deleted = tx
      .delete(conversation)
      .where(inArray(conversation.id, deletable))
      .returning({ id: conversation.id })
      .all();

    for (const row of deleted) removeConversationFromIndex(tx, row.id);

    return deleted.length;
  });
}

/** Creations in one classroom made before `before`, when the classroom sets a period (§16). */
export function expiredCreations(
  db: AppDatabase,
  input: { classroomId: string; before: Date },
): {
  artifactIds: string[];
  images: { id: string; storagePath: string }[];
  documents: { id: string; storagePath: string }[];
} {
  const artifactIds = db
    .select({ id: artifact.id })
    .from(artifact)
    .innerJoin(student, eq(student.id, artifact.studentId))
    .where(and(eq(student.classroomId, input.classroomId), lt(artifact.updatedAt, input.before)))
    .all()
    .map((row) => row.id);

  const images = db
    .select({ id: generatedImage.id, storagePath: generatedImage.storagePath })
    .from(generatedImage)
    .innerJoin(student, eq(student.id, generatedImage.studentId))
    .where(
      and(eq(student.classroomId, input.classroomId), lt(generatedImage.createdAt, input.before)),
    )
    .all();

  const documents = db
    .select({ id: generatedDocument.id, storagePath: generatedDocument.storagePath })
    .from(generatedDocument)
    .innerJoin(student, eq(student.id, generatedDocument.studentId))
    .where(
      and(
        eq(student.classroomId, input.classroomId),
        lt(generatedDocument.createdAt, input.before),
      ),
    )
    .all();

  return { artifactIds, images, documents };
}

export function deleteArtifacts(db: AppDatabase, artifactIds: readonly string[]): number {
  if (artifactIds.length === 0) return 0;

  return db
    .delete(artifact)
    .where(inArray(artifact.id, [...artifactIds]))
    .returning({ id: artifact.id })
    .all().length;
}

export function deleteGeneratedImages(db: AppDatabase, imageIds: readonly string[]): number {
  if (imageIds.length === 0) return 0;

  return db
    .delete(generatedImage)
    .where(inArray(generatedImage.id, [...imageIds]))
    .returning({ id: generatedImage.id })
    .all().length;
}

export function deleteGeneratedDocuments(db: AppDatabase, documentIds: readonly string[]): number {
  if (documentIds.length === 0) return 0;

  return db
    .delete(generatedDocument)
    .where(inArray(generatedDocument.id, [...documentIds]))
    .returning({ id: generatedDocument.id })
    .all().length;
}

/** Every stored file belonging to one pupil — attachments, generated images and documents (§16, §21). */
export function studentFiles(db: AppDatabase, studentId: string): DoomedFile[] {
  return [
    ...db
      .select({ storagePath: attachment.storagePath })
      .from(attachment)
      .where(eq(attachment.studentId, studentId))
      .all(),
    ...db
      .select({ storagePath: generatedImage.storagePath })
      .from(generatedImage)
      .where(eq(generatedImage.studentId, studentId))
      .all(),
    ...db
      .select({ storagePath: generatedDocument.storagePath })
      .from(generatedDocument)
      .where(eq(generatedDocument.studentId, studentId))
      .all(),
  ];
}

/**
 * Remove session rows that can never authenticate again (§7).
 *
 * Expiry and invalidation are already decided when a session is resolved, so
 * this frees rows rather than enforcing anything — which is why it may run
 * unhurried and why the grace period exists at all: a row deleted the instant it
 * expires makes "your session ended" indistinguishable from "no such session"
 * while support is still looking at it.
 */
export function deleteDeadSessions(db: AppDatabase, before: Date): number {
  return db
    .delete(session)
    .where(
      or(
        lt(session.expiresAt, before),
        and(isNotNull(session.invalidatedAt), lt(session.invalidatedAt, before)),
      ),
    )
    .returning({ id: session.id })
    .all().length;
}
