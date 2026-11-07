import { Marked, type Token, type Tokens } from "marked";

/**
 * Markdown into the small block model the document renderers understand.
 *
 * The model writes a document as Markdown because that is what it writes well.
 * Only the lexer is used, never marked's HTML output: each token is mapped onto
 * an allowlisted block or inline run, and anything else — raw HTML, images,
 * footnote definitions — is dropped. A renderer can therefore only ever emit
 * what this module names, which is what keeps hyperlinks, embedded images and
 * markup out of a file a child downloads.
 *
 * Its own `Marked` instance, not the shared singleton: `$lib/chat/markdown`
 * sets options on the global one, and a document's soft breaks must not depend
 * on which module happened to load first. `breaks: true` matches how the chat
 * shows the same prose, so a document reads the way the answer did.
 */

const lexer = new Marked({ gfm: true, breaks: true });

/** One run of text with the styling a document may carry. */
export interface Run {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
  /** A line break inside a paragraph. Its `text` is empty. */
  readonly lineBreak?: boolean;
}

/** List depth is clamped like heading levels: 0, 1 or 2. */
export type ListDepth = 0 | 1 | 2;

export type Block =
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly runs: readonly Run[] }
  | { readonly type: "paragraph"; readonly runs: readonly Run[] }
  | { readonly type: "quote"; readonly runs: readonly Run[] }
  | {
      readonly type: "list-item";
      readonly ordered: boolean;
      readonly depth: ListDepth;
      /** Each list in the source gets its own, so numbering restarts per list. */
      readonly listId: number;
      readonly runs: readonly Run[];
    }
  | { readonly type: "code"; readonly text: string }
  | {
      readonly type: "table";
      readonly header: readonly (readonly Run[])[];
      readonly rows: readonly (readonly (readonly Run[])[])[];
    }
  | { readonly type: "rule" };

export const TABLE_MAX_ROWS = 200;
export const TABLE_MAX_COLUMNS = 20;

export type ParseResult =
  | { readonly ok: true; readonly blocks: readonly Block[] }
  | { readonly ok: false; readonly reason: "empty" | "table-too-large" };

/** Parse a document's Markdown. Pure. */
export function parseDocument(markdown: string): ParseResult {
  const state: WalkState = { blocks: [], nextListId: 1, tableTooLarge: false };
  walkBlocks(lexer.lexer(markdown), state);

  if (state.tableTooLarge) return { ok: false, reason: "table-too-large" };
  if (state.blocks.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, blocks: state.blocks };
}

/** The plain text of a run sequence, a line break as a space. */
export function plainText(runs: readonly Run[]): string {
  return runs.map((run) => (run.lineBreak ? " " : run.text)).join("");
}

interface WalkState {
  blocks: Block[];
  nextListId: number;
  tableTooLarge: boolean;
}

function walkBlocks(tokens: readonly Token[], state: WalkState, inQuote = false): void {
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const runs = inline((token as Tokens.Heading).tokens);
        if (hasText(runs)) {
          const depth = (token as Tokens.Heading).depth;
          state.blocks.push({ type: "heading", level: depth <= 1 ? 1 : depth === 2 ? 2 : 3, runs });
        }
        break;
      }
      case "paragraph":
      case "text": {
        const children = (token as Tokens.Paragraph | Tokens.Text).tokens;
        const runs = children ? inline(children) : textRuns((token as Tokens.Text).text);
        if (hasText(runs)) state.blocks.push({ type: inQuote ? "quote" : "paragraph", runs });
        break;
      }
      case "blockquote":
        walkBlocks((token as Tokens.Blockquote).tokens, state, true);
        break;
      case "list":
        walkList(token as Tokens.List, 0, state);
        break;
      case "code": {
        const text = (token as Tokens.Code).text;
        if (text.length > 0) state.blocks.push({ type: "code", text });
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        const columns = Math.max(table.header.length, ...table.rows.map((row) => row.length));
        if (table.rows.length > TABLE_MAX_ROWS || columns > TABLE_MAX_COLUMNS) {
          state.tableTooLarge = true;
          break;
        }
        state.blocks.push({
          type: "table",
          header: table.header.map((cell) => inline(cell.tokens)),
          rows: table.rows.map((row) => row.map((cell) => inline(cell.tokens))),
        });
        break;
      }
      case "hr":
        state.blocks.push({ type: "rule" });
        break;
      default:
        // `space`, `html`, `def` and anything a later marked adds: dropped.
        break;
    }
  }
}

function walkList(list: Tokens.List, depth: number, state: WalkState): void {
  const listId = state.nextListId++;
  const clamped = Math.min(depth, 2) as ListDepth;

  for (const item of list.items) {
    // In source order: text gathers into the item until a nested block comes,
    // which is written in its place. Text after it continues as a paragraph,
    // so nothing in the item moves.
    let runs: Run[] = [];
    let hasContent = false;
    let itemWritten = false;

    const flush = () => {
      if (hasText(runs)) {
        state.blocks.push(
          itemWritten
            ? { type: "paragraph", runs }
            : { type: "list-item", ordered: list.ordered, depth: clamped, listId, runs },
        );
        itemWritten = true;
      }
      runs = [];
      hasContent = false;
    };

    for (const child of item.tokens) {
      if (child.type === "checkbox") {
        runs.push({ text: (child as Tokens.Checkbox).checked ? "☑ " : "☐ " });
      } else if (child.type === "text" || child.type === "paragraph") {
        // A second paragraph in a loose item continues on a new line.
        if (hasContent) runs.push({ text: "", lineBreak: true });
        const children = (child as Tokens.Text | Tokens.Paragraph).tokens;
        runs.push(...(children ? inline(children) : textRuns((child as Tokens.Text).text)));
        hasContent = true;
      } else if (child.type === "list") {
        flush();
        walkList(child as Tokens.List, depth + 1, state);
      } else if (child.type !== "space") {
        flush();
        walkBlocks([child], state);
      }
    }
    flush();
  }
}

type Style = Pick<Run, "bold" | "italic" | "strike" | "code">;

function inline(tokens: readonly Token[], style: Style = {}): Run[] {
  const runs: Run[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const children = (token as Tokens.Text).tokens;
        if (children && children.length > 0) runs.push(...inline(children, style));
        else runs.push(...textRuns((token as Tokens.Text).text, style));
        break;
      }
      case "escape":
        runs.push({ ...style, text: (token as Tokens.Escape).text });
        break;
      case "strong":
        runs.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        runs.push(...inline((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "del":
        // Struck-through words are still words: kept, and struck.
        runs.push(...inline((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        runs.push({ ...style, code: true, text: (token as Tokens.Codespan).text });
        break;
      case "br":
        runs.push({ text: "", lineBreak: true });
        break;
      case "link": {
        // Never a hyperlink in the file: the URL is written out as text, and a
        // bare URL is not written twice.
        const link = token as Tokens.Link;
        const label = inline(link.tokens, style);
        runs.push(...label);
        const shown = plainText(label);
        if (!link.autolink && shown !== link.href && link.href) {
          runs.push({ ...style, text: ` (${link.href})` });
        }
        break;
      }
      case "html":
        // A `<br>` is how a model breaks a line inside a table cell, which GFM
        // cannot hold a newline in. Every other tag is dropped.
        if (/^<br\s*\/?>$/i.test((token as Tokens.HTML).text.trim())) {
          runs.push({ text: "", lineBreak: true });
        }
        break;
      default:
        // `image`, `checkbox` outside a list item: dropped.
        break;
    }
  }

  return runs;
}

/** Plain text, decoded of the entities a model writes, newlines kept as breaks. */
function textRuns(text: string, style: Style = {}): Run[] {
  const decoded = decodeEntities(text);
  const runs: Run[] = [];
  decoded.split("\n").forEach((line, index) => {
    if (index > 0) runs.push({ text: "", lineBreak: true });
    if (line.length > 0) runs.push({ ...style, text: line });
  });
  return runs;
}

function hasText(runs: readonly Run[]): boolean {
  return runs.some((run) => !run.lineBreak && run.text.trim().length > 0);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * The handful of entities a model writes in Markdown, decoded.
 *
 * The lexer leaves text as written, so `Tom &amp; Jerry` would otherwise reach
 * the document with its entity showing. Unknown names are left as they are.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
