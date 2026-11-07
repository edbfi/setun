import { describe, expect, test } from "bun:test";
import { privateFileHeaders } from "./serving";

function disposition(filename: string | undefined, kind?: "inline" | "attachment") {
  return privateFileHeaders({ mediaType: "text/plain", filename, disposition: kind })[
    "content-disposition"
  ];
}

describe("privateFileHeaders", () => {
  test("keeps the restrictive headers on every response", () => {
    expect(privateFileHeaders({ mediaType: "image/png" })).toEqual({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, no-store",
    });
  });

  test("sends no disposition for an unnamed inline file, as images are served", () => {
    expect(disposition(undefined)).toBeUndefined();
  });

  test("names an attachment in plain ASCII and in UTF-8", () => {
    expect(disposition("Fotosyntese.docx", "attachment")).toBe(
      "attachment; filename=\"Fotosyntese.docx\"; filename*=UTF-8''Fotosyntese.docx",
    );
    expect(disposition("notes.txt")).toBe(
      "inline; filename=\"notes.txt\"; filename*=UTF-8''notes.txt",
    );
  });

  test("keeps Danish in filename* and drops it from the ASCII fallback", () => {
    expect(disposition("Æbler og pærer.csv", "attachment")).toBe(
      "attachment; filename=\"bler og prer.csv\"; filename*=UTF-8''%C3%86bler%20og%20p%C3%A6rer.csv",
    );
  });

  test("never produces an empty name or a dotfile", () => {
    expect(disposition("Математика.docx", "attachment")).toBe(
      "attachment; filename=\"document.docx\"; filename*=UTF-8''%D0%9C%D0%B0%D1%82%D0%B5%D0%BC%D0%B0%D1%82%D0%B8%D0%BA%D0%B0.docx",
    );
    expect(disposition("", "attachment")).toBe(
      "attachment; filename=\"document\"; filename*=UTF-8''document",
    );
    expect(disposition(undefined, "attachment")).toBe(
      "attachment; filename=\"document\"; filename*=UTF-8''document",
    );
    expect(disposition("   ", "attachment")).toBe(
      "attachment; filename=\"document\"; filename*=UTF-8''document",
    );
    expect(disposition(".docx", "attachment")).toBe(
      "attachment; filename=\"document.docx\"; filename*=UTF-8''document.docx",
    );
  });

  test("lets nothing break out of the header", () => {
    const header = disposition('evil";\r\nSet-Cookie: x=1;\\..\\a/b.txt', "attachment") ?? "";
    expect(header).not.toMatch(/[\r\n]/);
    // One quoted value, and nothing after the encoded one.
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header).toBe(
      "attachment; filename=\"evilSet-Cookie x1..ab.txt\"; filename*=UTF-8''evil%22%3BSet-Cookie%3A%20x%3D1%3B..ab.txt",
    );
  });

  test("drops a lone surrogate instead of throwing, and keeps a whole pair", () => {
    // An upload name cut by UTF-16 length can end in half a character.
    expect(disposition("ab\uD835.txt")).toBe(
      "inline; filename=\"ab.txt\"; filename*=UTF-8''ab.txt",
    );
    expect(disposition("\u{1D49C}.txt")).toBe(
      "inline; filename=\"document.txt\"; filename*=UTF-8''%F0%9D%92%9C.txt",
    );
  });

  test("encodes the characters RFC 8187 reserves beyond encodeURIComponent", () => {
    expect(disposition("it's (a) *test*.txt")).toBe(
      "inline; filename=\"its a test.txt\"; filename*=UTF-8''it%27s%20%28a%29%20%2Atest%2A.txt",
    );
  });

  test("handles an extensionless name, as an uploaded attachment may have", () => {
    expect(disposition("README")).toBe("inline; filename=\"README\"; filename*=UTF-8''README");
  });

  test("does not truncate a long name; the documents route caps titles itself", () => {
    const long = `${"a".repeat(300)}.docx`;
    expect(disposition(long, "attachment")).toBe(
      `attachment; filename="${long}"; filename*=UTF-8''${long}`,
    );
  });
});
