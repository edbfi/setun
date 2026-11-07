import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { Block, Run } from "./markdown";

/**
 * A document's blocks as a Word file.
 *
 * Built only from what the block model names, with the library's built-in
 * styles: no templates, fields, images or hyperlinks, so the file has no
 * external relationship to reach out through when a child opens it.
 *
 * Metadata is constant. The model-written title can hold a pupil's name, so it
 * goes into the filename and the chat card and never into the file's
 * properties, where it would travel unseen with every copy.
 */

const ORDERED = "setun-ordered";
const CODE_FONT = "Courier New";

/**
 * Characters a Word file must not contain.
 *
 * XML 1.0 allows only tab, line feed, carriage return and U+0020–U+D7FF,
 * U+E000–U+FFFD and U+10000 upward, so the non-characters U+FFFE and U+FFFF
 * and any lone surrogate are out as well as the C0 controls. One stray form
 * feed is enough for Word to refuse the whole file, and the library escapes
 * only `&`, `<` and `>`. Other control characters (DEL, C1) are dropped too:
 * XML tolerates them, but nothing a pupil reads needs them.
 */
const CONTROL = /\p{Cc}/gu;
const NOT_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

export async function renderDocx(blocks: readonly Block[]): Promise<Uint8Array> {
  const document = new Document({
    creator: "Setun",
    lastModifiedBy: "Setun",
    numbering: {
      config: [
        {
          reference: ORDERED,
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: blocks.flatMap(toChildren) }],
  });

  return new Uint8Array(await Packer.toBuffer(document));
}

function toChildren(block: Block): (Paragraph | Table)[] {
  switch (block.type) {
    case "heading":
      return [
        new Paragraph({
          heading:
            block.level === 1
              ? HeadingLevel.HEADING_1
              : block.level === 2
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          children: runs(block.runs),
        }),
      ];
    case "paragraph":
      return [new Paragraph({ children: runs(block.runs) })];
    case "quote":
      return [new Paragraph({ indent: { left: 720 }, children: runs(block.runs, true) })];
    case "list-item":
      return [
        new Paragraph({
          children: runs(block.runs),
          ...(block.ordered
            ? { numbering: { reference: ORDERED, level: block.depth, instance: block.listId } }
            : { bullet: { level: block.depth } }),
        }),
      ];
    case "code":
      return block.text.split("\n").map(
        (line) =>
          new Paragraph({
            children: [new TextRun({ text: clean(line), font: CODE_FONT, size: 20 })],
          }),
      );
    case "table":
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              tableHeader: true,
              children: block.header.map(
                (cell) =>
                  new TableCell({
                    children: [new Paragraph({ children: runs(cell, false, true) })],
                  }),
              ),
            }),
            ...block.rows.map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (cell) =>
                      new TableCell({ children: [new Paragraph({ children: runs(cell) })] }),
                  ),
                }),
            ),
          ],
        }),
      ];
    case "rule":
      return [new Paragraph({ thematicBreak: true, children: [] })];
  }
}

function runs(source: readonly Run[], italic = false, bold = false): TextRun[] {
  return source.map((run) =>
    run.lineBreak
      ? new TextRun({ break: 1 })
      : new TextRun({
          text: clean(run.text),
          bold: run.bold || bold || undefined,
          italics: run.italic || italic || undefined,
          strike: run.strike || undefined,
          ...(run.code ? { font: CODE_FONT } : {}),
        }),
  );
}

/** Everything XML forbids out, and control characters other than tab and line ends. */
function clean(text: string): string {
  return text
    .replace(CONTROL, (character) =>
      character === "\t" || character === "\n" || character === "\r" ? character : "",
    )
    .replace(NOT_XML, "");
}
