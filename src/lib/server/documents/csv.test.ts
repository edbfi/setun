import { describe, expect, test } from "bun:test";
import { neutraliseFormula, renderCsv } from "./csv";
import { parseDocument } from "./markdown";

function csvOf(markdown: string): string {
  const parsed = parseDocument(markdown);
  if (!parsed.ok) throw new Error(parsed.reason);
  const result = renderCsv(parsed.blocks);
  if (!result.ok) throw new Error(result.reason);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.bytes);
}

describe("renderCsv", () => {
  test("writes a BOM, CRLF line ends and the header row first", () => {
    expect(csvOf("| Navn | Alder |\n|---|---|\n| Åse | 12 |")).toBe(
      "\uFEFFNavn,Alder\r\nÅse,12\r\n",
    );
  });

  test("quotes cells with commas, quotes and line ends", () => {
    expect(csvOf('| A |\n|---|\n| a, b |\n| say "hi" |')).toBe(
      '\uFEFFA\r\n"a, b"\r\n"say ""hi"""\r\n',
    );
  });

  test("turns a <br> in a cell into a space rather than gluing the words", () => {
    expect(csvOf("| A |\n|---|\n| a<br>b |\n| c<br />d |")).toBe("\uFEFFA\r\na b\r\nc d\r\n");
  });

  test("flattens inline styling to plain text", () => {
    expect(csvOf("| A |\n|---|\n| **bold** `code` a\\|b |")).toBe("\uFEFFA\r\nbold code a|b\r\n");
  });

  test("neutralises formulas in headers as well as cells", () => {
    expect(csvOf("| =SUM(A1) |\n|---|\n| @x |")).toBe("\uFEFF'=SUM(A1)\r\n'@x\r\n");
  });

  test("needs exactly one table", () => {
    const none = parseDocument("just prose");
    const two = parseDocument("| A |\n|---|\n| 1 |\n\ntext\n\n| B |\n|---|\n| 2 |");
    if (!none.ok || !two.ok) throw new Error("expected documents");
    expect(renderCsv(none.blocks)).toEqual({ ok: false, reason: "needs-one-table" });
    expect(renderCsv(two.blocks)).toEqual({ ok: false, reason: "needs-one-table" });
  });
});

describe("neutraliseFormula", () => {
  test.each([
    ["=1+1"],
    [" =1+1"],
    ["\n=X"],
    ["\t5"],
    ["\r=X"],
    ["＝1+1"],
    ["＋1"],
    ["@SUM(A1)"],
    ["-1+cmd"],
    ["+cmd"],
    ["-3 kg"],
    ["--"],
  ])("prefixes %p", (cell) => {
    expect(neutraliseFormula(cell)).toBe(`'${cell}`);
  });

  test.each([["-5"], ["-5,2"], ["+3.25"], ["-5%"], ["42"], ["-"], ["hello"], ["e-mail"], [""]])(
    "leaves %p alone",
    (cell) => {
      expect(neutraliseFormula(cell)).toBe(cell);
    },
  );
});
