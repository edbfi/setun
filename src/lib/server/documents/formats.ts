/**
 * The document formats Setun can produce, and what each one is called.
 *
 * The extension and media type come from the validated format, never from a
 * lookup on a type string: the stored type is canonical (`text/csv`, without
 * parameters) and the charset is added only on the wire.
 */

/** The name the model calls. Here, not in `agent/tools`, so pure modules can name it. */
export const CREATE_DOCUMENT_TOOL = "create_document";

export const DOCUMENT_FORMATS = ["docx", "csv"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const DOCUMENT_MEDIA_TYPES: Record<DocumentFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
};

/** What the download sends as `content-type`. */
export function documentContentType(format: DocumentFormat): string {
  return format === "csv" ? "text/csv; charset=utf-8" : DOCUMENT_MEDIA_TYPES.docx;
}

export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return typeof value === "string" && (DOCUMENT_FORMATS as readonly string[]).includes(value);
}

export const DOCUMENT_LIMITS = {
  titleMaxChars: 120,
  markdownMaxChars: 20_000,
  outputMaxBytes: 2 * 1024 * 1024,
} as const;

const FILENAME_MAX_CHARS = 80;

/**
 * The name a downloaded document is saved under.
 *
 * Letters (any script), digits, spaces, underscores and hyphens from the title,
 * whitespace collapsed, at most 80 characters, then the server's extension.
 * `privateFileHeaders` cleans it again on its way into the header; this is the
 * name a pupil sees.
 */
export function documentFilename(title: string, format: DocumentFormat): string {
  const cleaned = title
    .replace(/[^\p{L}\p{N} _-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // By code point, so a letter outside the BMP is never cut in half.
  const stem = [...cleaned].slice(0, FILENAME_MAX_CHARS).join("").trim();

  return `${stem || "document"}.${format}`;
}
