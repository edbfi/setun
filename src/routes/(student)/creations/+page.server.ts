import { fail } from "@sveltejs/kit";
import * as v from "valibot";
import { requireStudentPage } from "$lib/server/auth/guards";
import { getDb, getFileStore } from "$lib/server/boot";
import { getConfig } from "$lib/server/config";
import {
  attachSnapshots,
  countArtifactVersions,
  deleteOwnedArtifact,
  listStudentArtifacts,
  pruneOrphanBlobs,
} from "$lib/server/db/queries/artifacts";
import { listStudentDocuments } from "$lib/server/db/queries/documents";
import { deleteOwnedImage, listStudentImages } from "$lib/server/db/queries/images";
import { removeOwnedDocument } from "$lib/server/documents/remove";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The creations gallery (PRD §13, §16, §18).
 *
 * "Creations — artifacts and generated images — are governed separately: by
 * default they persist until the student or educator deletes them (the gallery
 * is the student's portfolio)." So this route reads by owner and not by
 * conversation: a thirty-day-old conversation is gone and its artifacts are not.
 *
 * Thin by §6.1 — authorise, delegate to the query modules, shape the response.
 * Everything returned is owner-scoped in SQL (§21).
 */

const DeleteSchema = v.object({ id: v.pipe(v.string(), v.uuid()) });

export const load: PageServerLoad = ({ locals }) => {
  const student = requireStudentPage(locals);
  const db = getDb();

  return {
    artifacts: attachSnapshots(db, listStudentArtifacts(db, student.id)).map(
      ({ artifact, latest, source, snapshot }) => ({
        id: artifact.id,
        language: artifact.language,
        title: artifact.title,
        versionCount: countArtifactVersions(db, artifact.id),
        latest: {
          id: latest.id,
          revision: latest.revision,
          source,
          entry: snapshot.entry,
          files: snapshot.files,
          // Null reads as "whatever the artifact says"; the gallery frame runs it
          // through `effectiveLanguage` rather than the row's current tag (§13).
          language: latest.language,
          authoredBy: latest.authoredBy,
          createdAt: latest.createdAt.toISOString(),
        },
      }),
    ),
    images: listStudentImages(db, student.id).map((image) => ({
      id: image.id,
      prompt: image.prompt,
      createdAt: image.createdAt.toISOString(),
    })),
    documents: listStudentDocuments(db, student.id).map((document) => ({
      id: document.id,
      title: document.title,
      format: document.format,
      createdAt: document.createdAt.toISOString(),
    })),
    sandboxOrigin: getConfig().sandboxOrigin,
  };
};

export const actions: Actions = {
  /** Students delete their own creations (§16). Plain actions: they work without JS. */
  deleteArtifact: async ({ request, locals }) => {
    const student = requireStudentPage(locals);

    const parsed = v.safeParse(DeleteSchema, { id: (await request.formData()).get("id") });
    if (!parsed.success) return fail(400, { invalid: true });

    // Owner-scoped in the statement: naming somebody else's artifact deletes
    // nothing and is reported exactly as deleting one's own is (§21).
    const db = getDb();
    if (deleteOwnedArtifact(db, { artifactId: parsed.output.id, studentId: student.id })) {
      // A blob is shared between revisions and between artifacts, so it cannot
      // cascade from the rows that went; the sweep is what actually frees it (§16).
      pruneOrphanBlobs(db);
    }

    return { deleted: true };
  },

  deleteImage: async ({ request, locals }) => {
    const student = requireStudentPage(locals);

    const parsed = v.safeParse(DeleteSchema, { id: (await request.formData()).get("id") });
    if (!parsed.success) return fail(400, { invalid: true });

    const storagePath = deleteOwnedImage(getDb(), {
      imageId: parsed.output.id,
      studentId: student.id,
    });
    if (storagePath) await getFileStore().remove(storagePath);

    return { deleted: true };
  },

  /** Bytes first, then the row; see `removeOwnedDocument`. */
  deleteDocument: async ({ request, locals }) => {
    const student = requireStudentPage(locals);

    const parsed = v.safeParse(DeleteSchema, { id: (await request.formData()).get("id") });
    if (!parsed.success) return fail(400, { invalid: true });

    const outcome = await removeOwnedDocument(getDb(), getFileStore(), {
      documentId: parsed.output.id,
      studentId: student.id,
    });
    if (outcome === "failed") return fail(500, { deleteFailed: true });

    return { deleted: true };
  },
};
