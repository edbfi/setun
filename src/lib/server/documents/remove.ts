import type { AppDatabase } from "../db/client";
import { deleteOwnedDocument, getOwnedDocument } from "../db/queries/documents";
import type { FileStore } from "../storage/files";

/**
 * A pupil deleting one of their documents.
 *
 * Bytes first, then the row, and the row only once the bytes are gone: the row
 * is the only record of where they live, so a failed removal must leave it in
 * place to be tried again rather than strand the file (§16, §21). Somebody
 * else's id deletes nothing and is answered as if it had (§21).
 */
export async function removeOwnedDocument(
  db: AppDatabase,
  files: FileStore,
  input: { documentId: string; studentId: string },
): Promise<"deleted" | "failed"> {
  const document = getOwnedDocument(db, input);
  if (!document) return "deleted";

  if (!(await files.remove(document.storagePath))) return "failed";
  deleteOwnedDocument(db, input);
  return "deleted";
}
