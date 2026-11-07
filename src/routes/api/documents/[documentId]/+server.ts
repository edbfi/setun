import { error } from "@sveltejs/kit";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb, getFileStore } from "$lib/server/boot";
import { getOwnedDocument } from "$lib/server/db/queries/documents";
import { documentContentType, documentFilename } from "$lib/server/documents/formats";
import { privateFileHeaders } from "$lib/server/storage/serving";
import type { RequestHandler } from "./$types";

/**
 * Download one generated document.
 *
 * The only way a browser reaches one, owner-scoped in SQL, and always an
 * attachment: a docx or csv is for Word or a spreadsheet, never something to
 * render on Setun's origin. Somebody else's id answers 404, exactly as a
 * missing one does (§21).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const student = requireStudentApi(locals);

  const record = getOwnedDocument(getDb(), {
    documentId: params.documentId,
    studentId: student.id,
  });
  if (!record) error(404, "Not found");

  const bytes = await getFileStore().read(record.storagePath);
  if (!bytes) error(404, "Not found");

  return new Response(bytes as BlobPart, {
    headers: privateFileHeaders({
      mediaType: documentContentType(record.format),
      filename: documentFilename(record.title, record.format),
      disposition: "attachment",
    }),
  });
};
