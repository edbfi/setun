import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dropMissingEncodings,
  installServerGuard,
  isRecoverableFileError,
} from "./server-guard.js";

/**
 * A stand-in for `process` that records what was registered and whether the
 * guard tried to exit.
 *
 * The guard must never be installed on the real process here: an
 * `uncaughtException` listener registered by a test outlives the test and
 * changes how the runner reports every later failure.
 */
function stubProcess() {
  const listeners = new Map<string, (value: unknown) => void>();
  const exits: number[] = [];

  return {
    on(event: string, listener: (value: unknown) => void) {
      listeners.set(event, listener);
    },
    exit(code: number) {
      exits.push(code);
    },
    emit(event: string, value: unknown) {
      listeners.get(event)?.(value);
    },
    listeners,
    exits,
  };
}

/** The exact shape Node and Bun produce for a failed `open`. */
function fsError(code: string, syscall = "open", path = "/app/build/client/_app/x.js.br") {
  return Object.assign(new Error(`${code}: no such file or directory, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
    errno: -2,
  });
}

describe("isRecoverableFileError", () => {
  test("accepts a failed read of one named file", () => {
    expect(isRecoverableFileError(fsError("ENOENT"))).toBe(true);
    expect(isRecoverableFileError(fsError("EACCES"))).toBe(true);
    expect(isRecoverableFileError(fsError("EISDIR", "read"))).toBe(true);
  });

  test("rejects resource exhaustion, where restarting is the right answer", () => {
    expect(isRecoverableFileError(fsError("EMFILE"))).toBe(false);
    expect(isRecoverableFileError(fsError("ENOMEM"))).toBe(false);
  });

  test("rejects an error that merely carries a familiar code", () => {
    // No syscall, no path — not a file read, whatever the code says.
    expect(isRecoverableFileError(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe(
      false,
    );
  });

  test("rejects ordinary faults and non-errors", () => {
    expect(isRecoverableFileError(new TypeError("undefined is not a function"))).toBe(false);
    expect(isRecoverableFileError("ENOENT")).toBe(false);
    expect(isRecoverableFileError(null)).toBe(false);
    expect(isRecoverableFileError(undefined)).toBe(false);
  });
});

describe("installServerGuard", () => {
  test("registers both process-level listeners", () => {
    const target = stubProcess();
    installServerGuard(target as unknown as NodeJS.Process);

    expect([...target.listeners.keys()].sort()).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
  });

  test("a missing static asset does not end the process", () => {
    const target = stubProcess();
    installServerGuard(target as unknown as NodeJS.Process);

    target.emit("uncaughtException", fsError("ENOENT"));
    target.emit("unhandledRejection", fsError("ENOENT"));

    expect(target.exits).toEqual([]);
  });

  test("anything else still exits, as before", () => {
    const target = stubProcess();
    installServerGuard(target as unknown as NodeJS.Process);

    target.emit("uncaughtException", new TypeError("boom"));

    expect(target.exits).toEqual([1]);
  });
});

/**
 * A build `client` directory holding one chunk with its gzip sibling and
 * deliberately no Brotli sibling — the divergence that fails the request — one
 * chunk with both, and one with neither; and, outside `/_app/`, a copied
 * `static/` file in each of the first two states.
 */
function clientDir() {
  const root = mkdtempSync(join(tmpdir(), "setun-guard-"));
  const chunks = join(root, "_app", "immutable", "chunks");
  mkdirSync(chunks, { recursive: true });
  writeFileSync(join(chunks, "a.js"), "export const a = 1;");
  writeFileSync(join(chunks, "a.js.gz"), "gz");
  writeFileSync(join(chunks, "both.js"), "export const b = 1;");
  writeFileSync(join(chunks, "both.js.br"), "br");
  writeFileSync(join(chunks, "both.js.gz"), "gz");
  writeFileSync(join(chunks, "none.js"), "export const n = 1;");
  writeFileSync(join(root, "setun-mark.svg"), "<svg/>");
  writeFileSync(join(root, "setun-mark.svg.gz"), "gz");
  writeFileSync(join(root, "robots.txt"), "User-agent: *");
  writeFileSync(join(root, "robots.txt.br"), "br");
  writeFileSync(join(root, "robots.txt.gz"), "gz");
  return root;
}

describe("dropMissingEncodings", () => {
  const dir = clientDir();
  const a = "/_app/immutable/chunks/a.js";

  test("leaves the header alone when every asked-for variant is on disk", () => {
    expect(dropMissingEncodings("br, gzip", "/_app/immutable/chunks/both.js", dir)).toBeNull();
    expect(dropMissingEncodings("gzip", a, dir)).toBeNull();
  });

  test("drops only the encoding whose file is missing", () => {
    expect(dropMissingEncodings("br, gzip", a, dir)).toBe("gzip");
    expect(dropMissingEncodings("gzip, deflate, br, zstd", a, dir)).toBe("gzip, deflate, zstd");
  });

  test("falls back to identity rather than leaving the header empty", () => {
    expect(dropMissingEncodings("br", a, dir)).toBe("identity");
    expect(dropMissingEncodings("br, gzip", "/_app/immutable/chunks/none.js", dir)).toBe(
      "identity",
    );
  });

  test("compares names the way adapter-bun does: lower-cased and whole", () => {
    // adapter-bun lower-cases each name, so `BR` selects the missing `.br` file.
    expect(dropMissingEncodings("BR", a, dir)).toBe("identity");
    expect(dropMissingEncodings("Br;q=1.0, GZip", a, dir)).toBe("GZip");
    // It compares whole names, so an alias such as `x-gzip` or `brotli` selects
    // nothing there and is left as it is.
    expect(dropMissingEncodings("x-gzip, brotli", a, dir)).toBeNull();
  });

  test("ignores a part that says q=0, as adapter-bun does", () => {
    expect(dropMissingEncodings("br;q=0, gzip", a, dir)).toBeNull();
    expect(dropMissingEncodings("br;q=0.0", a, dir)).toBeNull();
  });

  test("replaces a wildcard with the encodings still on disk", () => {
    expect(dropMissingEncodings("*", a, dir)).toBe("gzip");
    expect(dropMissingEncodings("*", "/_app/immutable/chunks/both.js", dir)).toBeNull();
    expect(dropMissingEncodings("*", "/_app/immutable/chunks/none.js", dir)).toBe("identity");
  });

  test("covers every static file, not only the build's /_app/ assets", () => {
    // A file copied from static/ is precompressed and served the same way.
    expect(dropMissingEncodings("gzip, deflate, br", "/setun-mark.svg", dir)).toBe("gzip, deflate");
    expect(dropMissingEncodings("br", "/setun-mark.svg", dir)).toBe("identity");
    expect(dropMissingEncodings("br, gzip", "/robots.txt", dir)).toBeNull();
  });

  test("ignores a path that is no file in the build, such as a page", () => {
    expect(dropMissingEncodings("br", "/chat", dir)).toBeNull();
    expect(dropMissingEncodings("br", "/", dir)).toBeNull();
    expect(dropMissingEncodings("br", "/_app/immutable", dir)).toBeNull();
    expect(dropMissingEncodings("br", "/_app/immutable/chunks/gone.js", dir)).toBeNull();
  });

  test("ignores a request that asks for no encoding", () => {
    expect(dropMissingEncodings(null, a, dir)).toBeNull();
    expect(dropMissingEncodings(undefined, a, dir)).toBeNull();
    expect(dropMissingEncodings("", a, dir)).toBeNull();
  });

  test("survives input a client is free to send", () => {
    // `decodeURIComponent` throws on a malformed escape.
    for (const path of ["/_app/%", "/_app/%zz"]) {
      expect(() => dropMissingEncodings("br", path, dir)).not.toThrow();
      expect(dropMissingEncodings("br", path, dir)).toBeNull();
    }

    // A path with a null byte does not throw either; it simply matches no file.
    expect(() => dropMissingEncodings("br", "/_app/a%00b.js", dir)).not.toThrow();
  });

  test("refuses to look outside the build directory", () => {
    expect(dropMissingEncodings("br", "/_app/../../../../etc/hosts", dir)).toBeNull();
    expect(dropMissingEncodings("br", "/_app/%2e%2e/%2e%2e/%2e%2e/etc/hosts", dir)).toBeNull();
    expect(dropMissingEncodings("br", "/../../../../etc/hosts", dir)).toBeNull();
    expect(dropMissingEncodings("br", "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/hosts", dir)).toBeNull();
  });
});
