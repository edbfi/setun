import { describe, expect, test } from "bun:test";
import { documentFilename } from "./formats";

describe("documentFilename", () => {
  test("keeps letters in any script and drops punctuation", () => {
    expect(documentFilename("Fotosyntese: æbler & pærer!", "docx")).toBe(
      "Fotosyntese æbler pærer.docx",
    );
    expect(documentFilename("Математика", "csv")).toBe("Математика.csv");
  });

  test("keeps a decomposed letter whole instead of splitting the word", () => {
    // "a" followed by U+030A COMBINING RING ABOVE, as some keyboards and macOS write it.
    expect(documentFilename("Pa\u030Arer", "docx")).toBe("P\u00E5rer.docx");
    expect(documentFilename("नमस्ते", "docx")).toBe("नमस्ते.docx");
  });

  test("falls back to `document` when nothing is left", () => {
    expect(documentFilename("!!!", "docx")).toBe("document.docx");
    expect(documentFilename("   ", "csv")).toBe("document.csv");
  });

  test("caps the name at eighty characters", () => {
    expect(documentFilename("a".repeat(200), "docx")).toBe(`${"a".repeat(80)}.docx`);
  });
});
