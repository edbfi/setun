import { type Block, plainText } from "./markdown";

/**
 * A document's one table as a CSV file.
 *
 * RFC 4180 quoting, CRLF line ends, UTF-8 with a byte-order mark so that æ, ø
 * and å open correctly in Excel.
 *
 * Spreadsheets run a cell that looks like a formula. Every cell, header
 * included, is checked on its final flattened text, before quoting: one that
 * begins — after any leading whitespace or control characters — with a formula
 * character, ASCII or full-width, or that begins with a tab, carriage return or
 * line feed, is prefixed with `'`. A plain number is left alone so that `-5`
 * and `-5,2` stay numbers. This is a mitigation, not a guarantee: spreadsheet
 * applications differ, and a file saved and reopened elsewhere may lose the
 * prefix.
 */

const FORMULA_START = /^[\s\p{Cc}]*[=+\-@＝＋－＠]/u;
const CONTROL_START = /^[\t\r\n]/;
const PLAIN_NUMBER = /^[+-]?\d+([.,]\d+)?$/;
const NEEDS_QUOTES = /[",\r\n]/;

export type CsvResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "needs-one-table" };

export function renderCsv(blocks: readonly Block[]): CsvResult {
  const tables = blocks.filter((block) => block.type === "table");
  if (tables.length !== 1) return { ok: false, reason: "needs-one-table" };

  const [table] = tables;
  const lines = [table.header, ...table.rows].map((row) =>
    row.map((cell) => quote(neutraliseFormula(plainText(cell)))).join(","),
  );

  const text = `\uFEFF${lines.join("\r\n")}\r\n`;
  return { ok: true, bytes: new TextEncoder().encode(text) };
}

/** Exported for its tests: the rule is the part worth checking case by case. */
export function neutraliseFormula(cell: string): string {
  if (PLAIN_NUMBER.test(cell)) return cell;
  if (CONTROL_START.test(cell) || FORMULA_START.test(cell)) return `'${cell}`;
  return cell;
}

function quote(cell: string): string {
  return NEEDS_QUOTES.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}
