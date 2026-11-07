import type { AppDatabase } from "../db/client";
import { getClassroom } from "../db/queries/classrooms";
import { recordGeneratedDocument } from "../db/queries/documents";
import type { GeneratedDocument } from "../db/schema";
import { describeCause, log } from "../logging";
import type { FileStore } from "../storage/files";
import { renderCsv } from "./csv";
import { renderDocx } from "./docx";
import { DOCUMENT_LIMITS, DOCUMENT_MEDIA_TYPES, type DocumentFormat } from "./formats";
import { parseDocument } from "./markdown";

/**
 * Writing one document: the single path every caller goes through.
 *
 * Modelled on image generation. The classroom's switch is read from the
 * database here, at the moment of writing, not from the turn's snapshot: in
 * strict mode a call can wait on the pupil's approval for as long as they take,
 * and an educator who switches documents off in the meantime has switched them
 * off.
 *
 * No fixed token charge: the document is the model's own output, already paid
 * for as output tokens, and the input caps bound what rendering it can cost.
 */

export type DocumentRefusal =
  /** The classroom has documents switched off. */
  | "disabled"
  /** Title or Markdown missing, or over their length caps. */
  | "invalid"
  /** Nothing in the Markdown survived the allowlist. */
  | "empty"
  | "table-too-large"
  /** A csv needs exactly one table to become the file. */
  | "needs-one-table"
  /** The rendered file is over the output cap. */
  | "too-large";

export type CreateDocumentResult =
  | { readonly ok: true; readonly document: GeneratedDocument; readonly byteLength: number }
  | { readonly ok: false; readonly refusal: DocumentRefusal };

export interface CreateDocumentInput {
  readonly db: AppDatabase;
  readonly files: FileStore;
  readonly classroomId: string;
  readonly studentId: string;
  readonly conversationId?: string | null;
  readonly format: DocumentFormat;
  readonly title: string;
  readonly markdown: string;
}

export async function createDocument(input: CreateDocumentInput): Promise<CreateDocumentResult> {
  if (!getClassroom(input.db, input.classroomId)?.documentsEnabled) {
    return { ok: false, refusal: "disabled" };
  }

  const title = input.title.trim();
  if (
    title.length === 0 ||
    title.length > DOCUMENT_LIMITS.titleMaxChars ||
    input.markdown.trim().length === 0 ||
    input.markdown.length > DOCUMENT_LIMITS.markdownMaxChars
  ) {
    return { ok: false, refusal: "invalid" };
  }

  const parsed = parseDocument(input.markdown);
  if (!parsed.ok) return { ok: false, refusal: parsed.reason };

  let bytes: Uint8Array;
  if (input.format === "csv") {
    const csv = renderCsv(parsed.blocks);
    if (!csv.ok) return { ok: false, refusal: csv.reason };
    bytes = csv.bytes;
  } else {
    bytes = await renderDocx(parsed.blocks);
  }

  if (bytes.byteLength > DOCUMENT_LIMITS.outputMaxBytes) return { ok: false, refusal: "too-large" };

  const stored = await input.files.write({
    category: "documents",
    ownerId: input.studentId,
    bytes,
    extension: input.format,
  });

  try {
    const document = recordGeneratedDocument(input.db, {
      studentId: input.studentId,
      conversationId: input.conversationId ?? null,
      title,
      format: input.format,
      mediaType: DOCUMENT_MEDIA_TYPES[input.format],
      storagePath: stored.storagePath,
    });
    return { ok: true, document, byteLength: bytes.byteLength };
  } catch (cause) {
    // Without its row the file is unreachable but still on the volume (§21).
    if (!(await input.files.remove(stored.storagePath))) {
      log.error("document file left behind after a failed record", {
        cause: describeCause(cause),
      });
    }
    throw cause;
  }
}
