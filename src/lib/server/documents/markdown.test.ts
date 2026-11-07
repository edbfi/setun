import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import {
  type Block,
  parseDocument,
  plainText,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
} from "./markdown";

/**
 * The allowlist between the model's Markdown and a file a child downloads.
 *
 * Everything a renderer can emit comes through here, so these tests are about
 * what is *not* let through as much as what is.
 */

function blocks(markdown: string): readonly Block[] {
  const parsed = parseDocument(markdown);
  if (!parsed.ok) throw new Error(`expected a document, got ${parsed.reason}`);
  return parsed.blocks;
}

function texts(markdown: string): string[] {
  return blocks(markdown).map((block) =>
    "runs" in block ? plainText(block.runs) : block.type === "code" ? block.text : block.type,
  );
}

describe("parseDocument", () => {
  test("keeps headings, paragraphs, quotes, code and rules", () => {
    const parsed = blocks("# Title\n\nSome prose.\n\n> A quote\n\n```js\nlet x = 1;\n```\n\n---\n");
    expect(parsed.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "quote",
      "code",
      "rule",
    ]);
  });

  test("clamps headings deeper than three", () => {
    const [heading] = blocks("###### Deep");
    expect(heading).toMatchObject({ type: "heading", level: 3 });
  });

  test("keeps bold, italic, strikethrough and inline code as styled runs", () => {
    const [paragraph] = blocks("a **b** *c* ~~d~~ `e`");
    if (paragraph?.type !== "paragraph") throw new Error("expected a paragraph");
    expect(paragraph.runs).toContainEqual({ text: "b", bold: true });
    expect(paragraph.runs).toContainEqual({ text: "c", italic: true });
    // Struck-through words are still words.
    expect(paragraph.runs).toContainEqual({ text: "d", strike: true });
    expect(paragraph.runs).toContainEqual({ text: "e", code: true });
  });

  test("drops raw HTML and images", () => {
    expect(texts("<b>bold</b> and ![alt](https://x.dk/y.png) text")).toEqual(["bold and  text"]);
    expect(parseDocument("<div>only html</div>")).toEqual({ ok: false, reason: "empty" });
    expect(parseDocument("![only](https://x.dk/a.png)")).toEqual({ ok: false, reason: "empty" });
  });

  test("writes a link's URL out as text, and a bare URL only once", () => {
    expect(texts("See [the site](https://x.dk) or https://auto.dk")).toEqual([
      "See the site (https://x.dk) or https://auto.dk",
    ]);
  });

  test("resolves escapes and the entities a model writes", () => {
    expect(texts("a\\|b Tom &amp; Jerry &#229; &unknown;")).toEqual([
      "a|b Tom & Jerry å &unknown;",
    ]);
  });

  test("flattens nested lists, clamping depth to three levels", () => {
    const items = blocks("- a\n  - b\n    - c\n      - d").filter(
      (block) => block.type === "list-item",
    );
    expect(items.map((item) => [plainText(item.runs), item.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 2],
    ]);
  });

  test("gives each list its own numbering", () => {
    const items = blocks("1. one\n2. two\n\ntext\n\n1. again").filter(
      (block) => block.type === "list-item",
    );
    expect(new Set(items.map((item) => item.listId)).size).toBe(2);
    expect(items.every((item) => item.ordered)).toBe(true);
  });

  test("marks task list items", () => {
    expect(texts("- [ ] todo\n- [x] done")).toEqual(["☐ todo", "☑ done"]);
  });

  test("keeps a table's header and rows", () => {
    const [table] = blocks("| A | B |\n|---|---|\n| 1 | 2 |");
    if (table?.type !== "table") throw new Error("expected a table");
    expect(table.header.map(plainText)).toEqual(["A", "B"]);
    expect(table.rows.map((row) => row.map(plainText))).toEqual([["1", "2"]]);
  });

  test("refuses a table over the row or column caps", () => {
    const header = `|${" h |".repeat(2)}\n|${"---|".repeat(2)}\n`;
    const tooLong = `${header}${"| a | b |\n".repeat(TABLE_MAX_ROWS + 1)}`;
    expect(parseDocument(tooLong)).toEqual({ ok: false, reason: "table-too-large" });

    const columns = TABLE_MAX_COLUMNS + 1;
    const tooWide = `|${" h |".repeat(columns)}\n|${"---|".repeat(columns)}\n|${" a |".repeat(columns)}`;
    expect(parseDocument(tooWide)).toEqual({ ok: false, reason: "table-too-large" });
  });

  test("is unaffected by options set on the shared marked instance", () => {
    const before = texts("one\ntwo");
    marked.setOptions({ breaks: false, gfm: false });
    try {
      expect(texts("one\ntwo")).toEqual(before);
      expect(blocks("| A |\n|---|\n| 1 |")[0]?.type).toBe("table");
    } finally {
      marked.setOptions({ breaks: true, gfm: true });
    }
  });
});
