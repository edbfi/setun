import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cookieDeletion, localeCookieOptions, secureCookie } from "./cookies";

/**
 * The `Secure` flag follows the public origin's scheme (PRD §7, §21).
 *
 * Browsers refuse a `Secure` cookie, and a `Secure` deletion, over plain HTTP from anywhere
 * but loopback, so a flag that ignored the scheme left plain-HTTP sign-outs and language
 * choices silently undone on a classroom LAN.
 */
const HTTPS = new URL("https://setun.example/chat");
const HTTP = new URL("http://192.0.2.10:3000/chat");

describe("secureCookie", () => {
  test("is true on an https origin and false on a plain-HTTP one", () => {
    expect(secureCookie(HTTPS)).toBe(true);
    expect(secureCookie(HTTP)).toBe(false);
    expect(secureCookie(new URL("http://localhost:4173/"))).toBe(false);
  });
});

describe("cookieDeletion", () => {
  test("keeps the cookie's path and follows the scheme", () => {
    expect(cookieDeletion(HTTPS, "/")).toEqual({ path: "/", secure: true });
    expect(cookieDeletion(HTTP, "/")).toEqual({ path: "/", secure: false });
    expect(cookieDeletion(HTTPS, "/setup")).toEqual({ path: "/setup", secure: true });
    expect(cookieDeletion(HTTP, "/setup")).toEqual({ path: "/setup", secure: false });
  });
});

describe("localeCookieOptions", () => {
  test("follows the scheme and stays readable by Paraglide's client", () => {
    for (const [url, secure] of [
      [HTTPS, true],
      [HTTP, false],
    ] as const) {
      expect(localeCookieOptions(url)).toEqual({
        path: "/",
        httpOnly: false,
        sameSite: "lax",
        secure,
        maxAge: 60 * 60 * 24 * 365,
      });
    }
  });
});

/**
 * Every server-side cookie write states its `Secure` flag through these helpers.
 *
 * SvelteKit's default is `Secure` everywhere but development and `http://localhost`, so a
 * call that forgets the option passes every loopback test and fails only on a LAN. This
 * reads the source: each `cookies.set` must pass `secure: secureCookie(...)` or
 * `localeCookieOptions(...)`, and each `cookies.delete` must pass `cookieDeletion(...)`.
 */
const SRC = join(import.meta.dir, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "paraglide" ? [] : sourceFiles(path);
    return /\.(ts|svelte)$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

/** The argument list of each call, up to its matching closing parenthesis. */
function calls(source: string, name: "set" | "delete" | "serialize"): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`cookies\\.${name}\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    while (depth > 0 && index < source.length) {
      if (source[index] === "(") depth++;
      if (source[index] === ")") depth--;
      index++;
    }
    found.push(source.slice(start, index - 1));
  }
  return found;
}

describe("every cookie write in src/", () => {
  const files = sourceFiles(SRC).map((path) => ({
    path: relative(SRC, path),
    source: readFileSync(path, "utf8"),
  }));

  test("finds the known call sites", () => {
    const total = files.reduce(
      (n, { source }) => n + calls(source, "set").length + calls(source, "delete").length,
      0,
    );
    // 4 sets of session or claim cookies, the locale cookie, and 7 deletions.
    expect(total).toBe(12);
  });

  test("states the Secure flag through the helpers", () => {
    const offenders: string[] = [];
    for (const { path, source } of files) {
      for (const args of calls(source, "set")) {
        if (!/secure: secureCookie\(|localeCookieOptions\(/.test(args))
          offenders.push(`${path}: set(${args})`);
      }
      for (const args of calls(source, "delete")) {
        if (!/cookieDeletion\(/.test(args)) offenders.push(`${path}: delete(${args})`);
      }
      for (const args of calls(source, "serialize")) offenders.push(`${path}: serialize(${args})`);
    }
    expect(offenders).toEqual([]);
  });
});
