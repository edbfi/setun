import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The image's build context (Dockerfile, `.dockerignore`).
 *
 * `COPY . .` sends the whole checkout to the build stage, so `.dockerignore` decides what an
 * image can contain: never a `.env` or an operator's configuration, never local state, and never
 * a host-built `node_modules` or build output, which would be stale or for another platform. It
 * must still keep every source file the build reads.
 */

const ROOT = import.meta.dir;
const IGNORE = join(ROOT, ".dockerignore");

/** Docker's reading of `.dockerignore`: one pattern per line, `#` comments, `!` exceptions. */
function patterns(): { pattern: string; negated: boolean }[] {
  return readFileSync(IGNORE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const pattern = (negated ? line.slice(1) : line).replace(/^\/+/, "").replace(/\/+$/, "");
      return { pattern, negated };
    });
}

/**
 * True when the context leaves `path` out: the last matching pattern decides, and a pattern that
 * matches a directory leaves out everything below it.
 */
function excluded(path: string): boolean {
  const parts = path.split("/");
  const prefixes = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  let result = false;
  for (const { pattern, negated } of patterns()) {
    const glob = new Bun.Glob(pattern);
    if (prefixes.some((prefix) => glob.match(prefix))) result = !negated;
  }
  return result;
}

function trackedFiles(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT, stdout: "pipe" });
  expect(listed.exitCode).toBe(0);
  return listed.stdout.toString().trim().split("\n");
}

describe(".dockerignore", () => {
  test("exists beside the Dockerfile", () => {
    expect(existsSync(IGNORE)).toBe(true);
  });

  test.each([
    ".env",
    ".env.local",
    ".env.production",
    ".git/HEAD",
    "node_modules/@sveltejs/kit/package.json",
    "build/index.js",
    "build-sandbox/index.html",
    ".svelte-kit/output/server/index.js",
    "src/lib/paraglide/messages.js",
    "data/setun.sqlite",
    ".devsuite/instances/default/setun.sqlite",
    "test-results/e2e/setun.sqlite",
    "playwright-report/index.html",
    "cpa/config.yaml",
    "mcp.json",
    "scripts/.venv/bin/python",
    "scripts/lib/devsuite/__pycache__/cli.cpython-314.pyc",
  ])("leaves out %s", (path) => {
    expect(excluded(path)).toBe(true);
  });

  test("keeps every tracked file the build can need", () => {
    // `.env.example` is documentation for operators; the image never reads it.
    const dropped = trackedFiles().filter((path) => path !== ".env.example" && excluded(path));
    expect(dropped).toEqual([]);
  });

  test("keeps what the Dockerfile copies from the context", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    const sources = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((match) =>
      (match[1] ?? "").split(/\s+/),
    );
    expect(sources).toEqual([
      "package.json",
      "bun.lock",
      ".",
      "package.json",
      "bun.lock",
      "server.js",
      "server-guard.js",
    ]);
    for (const source of sources.filter((path) => path !== "."))
      expect(excluded(source)).toBe(false);
  });
});

describe("the image's shutdown budget", () => {
  test("drains within `docker stop`'s default 10 s instead of being killed mid-drain", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    const value = /^ENV SHUTDOWN_TIMEOUT=(\d+)$/m.exec(runtime)?.[1];
    expect(value).toBeDefined();
    // The front's drain ends at SHUTDOWN_TIMEOUT; what follows (closing, removing the socket
    // directory, exiting) needs well under the rest of the 10 s.
    expect(Number(value)).toBeGreaterThan(0);
    expect(Number(value)).toBeLessThanOrEqual(7);
  });

  test("Compose neither shortens the stop budget nor overrides the image's value", () => {
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("stop_grace_period");
    expect(compose).not.toMatch(/^\s+SHUTDOWN_TIMEOUT:/m);
  });
});
