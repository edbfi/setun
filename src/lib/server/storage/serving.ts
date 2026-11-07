/**
 * Headers for the files Setun serves back (PRD §14, §21).
 *
 * "Served only to their owner with restrictive content-type headers, and never
 * served to or from the sandbox origin."
 *
 * The owner check happens in the endpoint; what happens here is everything that
 * makes the response itself safe — the browser must not sniff a different type
 * out of the bytes, must not execute anything the file contains, and must not
 * let another origin read it.
 */
export function privateFileHeaders(input: {
  mediaType: string;
  filename?: string;
  /** `inline` unless the file is meant to be saved rather than shown. */
  disposition?: "inline" | "attachment";
}): Record<string, string> {
  const disposition = input.disposition ?? "inline";
  const named = input.filename !== undefined || disposition === "attachment";

  return {
    // The sniffed type, never the uploader's claim (§21).
    "content-type": input.mediaType,
    // Without this a browser may decide a text file is HTML and run it.
    "x-content-type-options": "nosniff",
    // Nothing in a served file may load or execute anything at all.
    "content-security-policy": "default-src 'none'; sandbox",
    // The sandbox origin is a different origin, so this is what stops it
    // reading an attachment even with a session cookie present (§14, §21).
    "cross-origin-resource-policy": "same-origin",
    // Owner-scoped content must never be held by a shared cache.
    "cache-control": "private, no-store",
    ...(named ? { "content-disposition": contentDisposition(disposition, input.filename) } : {}),
  };
}

const UNSAFE = /[\p{Cc}/\\]/gu;
const EXTENSION = /(\.[A-Za-z0-9]{1,8})$/;

/**
 * `<disposition>; filename="<ascii>"; filename*=UTF-8''<encoded>`.
 *
 * Built here, from whatever name the caller passes, so no caller can put a
 * quote, backslash, semicolon or line break into the header. One cleaned name
 * feeds both values: browsers prefer `filename*` (RFC 6266 §4.3), so it must
 * never be empty, a dotfile, or carry a control character or path separator,
 * and the ASCII fallback is the same name reduced further.
 */
function contentDisposition(disposition: "inline" | "attachment", filename = ""): string {
  const withoutUnsafe = filename.replace(UNSAFE, "");
  const extension = EXTENSION.exec(withoutUnsafe)?.[1] ?? "";
  const rawStem = withoutUnsafe.slice(0, withoutUnsafe.length - extension.length);

  const stem = rawStem.replace(/^[.\s]+|[.\s]+$/g, "") || "document";
  const asciiStem =
    stem.replace(/[^A-Za-z0-9 _.-]/g, "").replace(/^[.\s-]+|[.\s-]+$/g, "") || "document";

  return `${disposition}; filename="${asciiStem}${extension}"; filename*=UTF-8''${encodeRfc8187(`${stem}${extension}`)}`;
}

/** `encodeURIComponent`, plus the four characters RFC 8187 also reserves. */
function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
