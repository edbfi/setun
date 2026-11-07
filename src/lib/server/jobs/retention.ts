import { subDays } from "date-fns";
import type { AppDatabase } from "../db/client";
import { pruneOrphanBlobs } from "../db/queries/artifacts";
import { listClassrooms } from "../db/queries/classrooms";
import {
  attachmentFilesFor,
  deleteArtifacts,
  deleteConversations,
  deleteGeneratedDocuments,
  deleteGeneratedImages,
  expiredConversationIds,
  expiredCreations,
} from "../db/queries/retention";
import type { Classroom } from "../db/schema";
import { log } from "../logging";
import type { FileStore } from "../storage/files";
import type { ScheduledJob } from "./scheduler";

/**
 * Retention, enforced by the server rather than promised by the interface
 * (PRD §16, §21).
 *
 * "Conversation retention is server-enforced by the job scheduler and
 * configurable per classroom, defaulting to thirty days; expiring a conversation
 * deletes its messages and attachments. Creations — artifacts and generated
 * images — are governed separately: by default they persist until the student or
 * educator deletes them (the gallery is the student's portfolio), and each
 * classroom may instead set a creations retention period."
 *
 * Two policies, two cut-offs, one pass. The creations cut-off is absent by
 * default and that absence is the policy — a classroom that has not set one
 * keeps its pupils' work indefinitely, and this job must not invent a number.
 */

/** Hourly. The policy is in days, so the tick only has to be well inside one. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export interface RetentionOutcome {
  readonly conversations: number;
  readonly artifacts: number;
  readonly images: number;
  readonly documents: number;
  readonly files: number;
}

/**
 * The cut-offs one classroom's policy implies at `now`.
 *
 * Whole days subtracted from the instant rather than from local midnight: the
 * policy is "thirty days old", not "the thirtieth day of the month", so there is
 * no local-midnight boundary for a timezone to move — and `date-fns` does the
 * arithmetic either way (§5).
 */
export function retentionCutoffs(
  classroom: Pick<Classroom, "conversationRetentionDays" | "creationRetentionDays">,
  now: Date,
): { conversationsBefore: Date; creationsBefore: Date | null } {
  return {
    conversationsBefore: subDays(now, classroom.conversationRetentionDays),
    // Null is the default and means "kept until deleted" — never a cut-off (§16).
    creationsBefore:
      classroom.creationRetentionDays === null || classroom.creationRetentionDays === undefined
        ? null
        : subDays(now, classroom.creationRetentionDays),
  };
}

/**
 * Apply every classroom's retention policy once.
 *
 * Files go before their rows: a cascade deletes the row that names a file and
 * leaves the bytes on the volume otherwise, which would make "expiring a
 * conversation deletes its attachments" false in the only sense that matters
 * (§16). The order also decides what a failed removal costs — the row is the
 * only record of where those bytes are, so it stays until they are gone and the
 * next hourly pass tries again.
 */
export async function runRetention(
  db: AppDatabase,
  files: FileStore,
  now: Date = new Date(),
): Promise<RetentionOutcome> {
  let conversations = 0;
  let artifacts = 0;
  let images = 0;
  let documents = 0;
  let removedFiles = 0;

  for (const classroom of listClassrooms(db)) {
    const cutoffs = retentionCutoffs(classroom, now);

    const expired = expiredConversationIds(db, {
      classroomId: classroom.id,
      before: cutoffs.conversationsBefore,
    });
    if (expired.length > 0) {
      const removedAttachmentIds: string[] = [];
      for (const file of attachmentFilesFor(db, expired)) {
        if (!(await files.remove(file.storagePath))) continue;
        removedFiles += 1;
        removedAttachmentIds.push(file.id);
      }

      // Only the rows whose bytes are gone. A conversation still holding an
      // attachment — one that could not be removed, or one uploaded while this
      // pass ran — keeps its row, and with it the only path back to the bytes.
      conversations += deleteConversations(db, {
        conversationIds: expired,
        removedAttachmentIds,
      });
    }

    if (!cutoffs.creationsBefore) continue;

    const creations = expiredCreations(db, {
      classroomId: classroom.id,
      before: cutoffs.creationsBefore,
    });
    artifacts += deleteArtifacts(db, creations.artifactIds);

    const removed: string[] = [];
    for (const image of creations.images) {
      if (!(await files.remove(image.storagePath))) continue;
      removedFiles += 1;
      removed.push(image.id);
    }
    images += deleteGeneratedImages(db, removed);

    // Documents as images: bytes first, and only the rows whose bytes went.
    const removedDocuments: string[] = [];
    for (const document of creations.documents) {
      if (!(await files.remove(document.storagePath))) continue;
      removedFiles += 1;
      removedDocuments.push(document.id);
    }
    documents += deleteGeneratedDocuments(db, removedDocuments);
  }

  // Cascades from educator deletions can orphan blobs even without an expired
  // creation (or any remaining classroom). Shared, still-referenced blobs stay.
  pruneOrphanBlobs(db);

  return { conversations, artifacts, images, documents, files: removedFiles };
}

/** The scheduler's view of the pass above. Counts only — no identifiers, no content (§16). */
export function retentionJob(db: AppDatabase, files: FileStore): ScheduledJob {
  return {
    name: "retention",
    intervalMs: RETENTION_INTERVAL_MS,
    runAtStart: true,
    async run(now) {
      const outcome = await runRetention(db, files, now);
      if (outcome.conversations + outcome.artifacts + outcome.images + outcome.documents > 0) {
        log.info("retention pass", outcome);
      }
    },
  };
}
