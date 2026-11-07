import { describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { renderDocx } from "./docx";
import { parseDocument } from "./markdown";

async function filesOf(markdown: string): Promise<Record<string, string>> {
  const parsed = parseDocument(markdown);
  if (!parsed.ok) throw new Error(parsed.reason);
  const entries = unzipSync(await renderDocx(parsed.blocks));
  return Object.fromEntries(
    Object.entries(entries).map(([name, bytes]) => [name, strFromU8(bytes)]),
  );
}

/** The timestamps differ on every run; everything else is asserted whole. */
function normalised(xml: string | undefined): string | undefined {
  return xml?.replace(/(<dcterms:(created|modified)[^>]*>)[^<]*/g, "$1T");
}

const SAMPLE = [
  "# Åse Hansens opgave",
  "",
  "Fotosyntese **fed** *kursiv* ~~væk~~ `kode` og [et link](https://x.dk).",
  "",
  "- et",
  "  - to",
  "1. første",
  "",
  "> citat",
  "",
  "| Blad | Farve |",
  "|---|---|",
  "| Eg | Grøn |",
  "",
  "---",
].join("\n");

describe("renderDocx", () => {
  test("writes the text into the document", async () => {
    const document = (await filesOf(SAMPLE))["word/document.xml"] ?? "";
    for (const text of ["Åse Hansens opgave", "fed", "kursiv", "væk", "kode", "Grøn", "citat"]) {
      expect(document).toContain(text);
    }
    // The URL is written out as text beside the label, not linked.
    expect(document).toContain(">et link<");
    expect(document).toContain("> (https://x.dk)<");
  });

  test("has no hyperlink and nothing that reaches outside the file", async () => {
    const files = await filesOf(SAMPLE);
    for (const [name, xml] of Object.entries(files)) {
      expect({ name, external: xml.includes('TargetMode="External"') }).toEqual({
        name,
        external: false,
      });
    }
    expect(files["word/_rels/document.xml.rels"]).not.toContain("hyperlink");
    expect(files["word/document.xml"]).not.toContain("<w:hyperlink");
  });

  test("keeps the title and the pupil out of the file's properties", async () => {
    // A title can hold a pupil's name; the properties must not repeat it.
    const files = await filesOf("# Åse Hansens opgave\n\nTekst");

    expect(normalised(files["docProps/core.xml"])).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Setun</dc:creator><cp:lastModifiedBy>Setun</cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">T</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">T</dcterms:modified></cp:coreProperties>',
    );
    expect(files["docProps/app.xml"]).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>',
    );
    expect(files["docProps/custom.xml"]).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>',
    );
  });

  test("strips control characters XML does not allow", async () => {
    const document = (await filesOf("Hej\fverden\u0001!\n\n```\na\u000bb\n```"))[
      "word/document.xml"
    ];
    expect(document).toContain("Hejverden!");
    expect(document).not.toMatch(/\p{Cc}/u);
  });

  test("strips the non-characters and lone surrogates XML forbids", async () => {
    const document = (await filesOf("a\uFFFEb &#xFFFF; c\uD800d"))["word/document.xml"] ?? "";
    expect(document).toContain("ab  cd");
    // Anything outside the XML 1.0 character ranges, anywhere in the part.
    expect(document).not.toMatch(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u);
  });
});
