import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEntry,
  forwardPath,
  frontHeaders,
  HOST_HEADER,
  MISSING_ORIGIN_WARNING,
  PEER_HEADER,
  PROTOCOL_HEADER,
  parseOrigin,
  prepare,
  shutdownTimeoutSeconds,
} from "./server.js";

/**
 * `server.js`, the production entry and ORIGIN-mapping front (PRD §5).
 *
 * The pure parts are tested directly. Everything that depends on a real listener —
 * the warning, the header rewriting on the wire, shutdown and startup failures — runs
 * `bun ./server.js` as a child process against a stand-in for the adapter-bun build:
 * a small `index.js` written to a temporary SETUN_BUILD_DIR that reads the same
 * environment variables as the adapter, listens where it would, and drains and emits
 * `sveltekit:shutdown` on SIGTERM the way it does. Each child gets its own TMPDIR, so
 * a socket directory left behind shows up.
 */

const SERVER = join(import.meta.dir, "server.js");

const STANDIN = String.raw`
import { writeFileSync } from "node:fs";
import process from "node:process";

if (process.env.STANDIN_THROW === "1") throw new Error("stand-in adapter failed to load");
if (process.env.STANDIN_LOAD_DELAY_MS) {
  await new Promise((done) => setTimeout(done, Number(process.env.STANDIN_LOAD_DELAY_MS)));
}

const env = process.env;
const seen = Object.fromEntries(
  ["SOCKET_PATH", "PROTOCOL_HEADER", "HOST_HEADER", "PORT_HEADER", "ADDRESS_HEADER", "XFF_DEPTH",
   "CONNECTION_IDLE_TIMEOUT", "SHUTDOWN_TIMEOUT", "BODY_SIZE_LIMIT", "IDLE_TIMEOUT"]
    .map((name) => [name, env[name] ?? null]),
);
const big = new Uint8Array(Number(env.STANDIN_BIG_BYTES || 8 * 1024 * 1024)).fill(97);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function handle(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/echo")) {
    return Response.json({
      method: request.method,
      url: request.url,
      body: await request.text(),
      headers: Object.fromEntries(request.headers),
      env: seen,
    });
  }
  switch (url.pathname) {
    case "/redirect":
      return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
    case "/gzip":
      return new Response(Bun.gzipSync(new TextEncoder().encode("compressed body")), {
        headers: { "content-encoding": "gzip", "content-type": "text/plain" },
      });
    case "/sse": {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          await sleep(Number(url.searchParams.get("gap") || 3000));
          controller.enqueue(new TextEncoder().encode("data: two\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    case "/hold": {
      request.signal.addEventListener("abort", () => {
        if (env.STANDIN_ABORT_FILE) writeFileSync(env.STANDIN_ABORT_FILE, "aborted");
      });
      const stream = new ReadableStream({
        async pull(controller) {
          await sleep(100);
          controller.enqueue(new TextEncoder().encode("."));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/plain" } });
    }
    case "/big":
      return new Response(big, {
        headers: { "content-type": "application/octet-stream", "content-length": String(big.length) },
      });
    case "/stop":
      setTimeout(() => server.stop(true), 10);
      return new Response("stopping");
    default:
      return new Response("not found", { status: 404 });
  }
}

const options = env.SOCKET_PATH
  ? { unix: env.SOCKET_PATH }
  : { hostname: env.HOST || "0.0.0.0", port: Number(env.PORT || 3000) };
const idle = env.CONNECTION_IDLE_TIMEOUT;
const server = Bun.serve({ ...options, ...(idle ? { idleTimeout: Number(idle) } : {}), fetch: handle });
console.log("standin listening on " + (env.SOCKET_PATH || server.url));

let stopping = false;
async function shutdown(reason) {
  if (stopping) return process.exit(1);
  stopping = true;
  const timeout = Number(env.SHUTDOWN_TIMEOUT || 30) * 1000;
  let timer;
  const drained = await Promise.race([
    server.stop().then(() => true),
    new Promise((done) => { timer = setTimeout(() => done(false), timeout); }),
  ]);
  clearTimeout(timer);
  if (!drained) await server.stop(true);
  console.log("standin drained at " + Date.now());
  process.emit("sveltekit:shutdown", reason);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
`;

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function scratch(prefix = "setun-server-test-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(25);
  }
}

type Started = {
  process: ReturnType<typeof Bun.spawn>;
  port: number;
  temp: string;
  output: () => string;
};

/** Start `bun ./server.js` with the stand-in build and a private TMPDIR. */
async function start(
  env: Record<string, string>,
  { waitFor = "ready" }: { waitFor?: "ready" | "exit" } = {},
): Promise<Started> {
  const build = scratch();
  writeFileSync(join(build, "index.js"), STANDIN);
  const temp = scratch();
  const port = env.PORT ? Number(env.PORT) : await freePort();
  const child = Bun.spawn(["bun", SERVER], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: temp,
      HOST: "127.0.0.1",
      PORT: String(port),
      SETUN_BUILD_DIR: build,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(() => child.kill("SIGKILL"));
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream as ReadableStream<Uint8Array>)
        output += decoder.decode(chunk);
    })();
  }
  if (waitFor === "ready") {
    await until(() => {
      if (child.exitCode !== null) throw new Error(`server.js exited early:\n${output}`);
      return /Listening on http|standin listening on http/.test(output);
    }, 10_000);
  }
  return { process: child, port, temp, output: () => output };
}

type Echo = {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
  env: Record<string, string | null>;
};

async function echo(port: number, init: RequestInit = {}, path = "/echo?x=1"): Promise<Echo> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return (await response.json()) as Echo;
}

/** A raw HTTP/1.1 request, so the Host header and the path are exactly what is written. */
function rawRequest(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(`${head}\r\nConnection: close\r\n\r\n`);
        },
        data(_socket, data) {
          received += data.toString();
        },
        close() {
          resolve(received);
        },
        error(_socket, error) {
          reject(error);
        },
      },
    });
  });
}

const socketDirectories = (temp: string) =>
  readdirSync(temp).filter((name) => name.startsWith("setun-"));

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("parseOrigin", () => {
  test.each([
    "http://192.168.1.10:3000",
    "https://setun.example.org",
    "http://localhost:4173",
    "http://[::1]:8080",
  ])("accepts %s as it is", (value) => {
    expect(parseOrigin(value).origin).toBe(value);
  });

  // adapter-node accepted these and normalized them; ORIGIN keeps its meaning (M2).
  test.each([
    ["a trailing slash", "http://setun.example/", "http://setun.example"],
    ["surrounding whitespace", "  https://setun.example \n", "https://setun.example"],
    ["an uppercase scheme and host", "HTTP://Setun.Example:8080", "http://setun.example:8080"],
    ["an explicit default port on http", "http://setun.example:80", "http://setun.example"],
    ["an explicit default port on https", "https://setun.example:443", "https://setun.example"],
    ["all of them at once", " HTTPS://SETUN.Example:443/ ", "https://setun.example"],
  ])("normalizes %s", (_case, value, expected) => {
    expect(parseOrigin(value).origin).toBe(expected);
  });

  test.each([
    ["a path", "http://setun.example/app", /remove the path, query or fragment/],
    ["a query", "http://setun.example/?a=1", /remove the path, query or fragment/],
    ["an empty query", "http://setun.example/?", /remove the path, query or fragment/],
    ["a fragment", "http://setun.example/#top", /remove the path, query or fragment/],
    ["an empty fragment", "http://setun.example#", /remove the path, query or fragment/],
    ["a non-http(s) scheme", "ftp://setun.example", /the scheme must be http or https/],
    ["garbage", "not a url", /it is not a valid URL/],
    ["an empty host", "http://", /it is not a valid URL/],
  ])("rejects %s with a clear error naming ORIGIN", (_case, value, reason) => {
    expect(() => parseOrigin(value)).toThrow(/^ORIGIN must be a bare http\(s\) origin/);
    expect(() => parseOrigin(value)).toThrow(reason);
  });

  test("never repeats credentials, whether or not the URL parser accepts the value", () => {
    // Built at runtime and obviously fake; it must appear nowhere in what is thrown.
    const secret = ["fake", "pw", crypto.randomUUID()].join("-");
    for (const value of [
      `http://user:${secret}@setun.example`,
      `http://user:${secret}@setun.example/path`,
      `http://user:${secret}@exa mple.com`,
      `http://${secret}@[::1`,
    ]) {
      let caught: unknown;
      try {
        parseOrigin(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error;
      expect(error.message).toStartWith("ORIGIN must be a bare http(s) origin");
      expect(error.cause).toBeUndefined();
      expect(Object.keys(error)).toEqual([]);
      expect(error.message).not.toContain(secret);
      expect(Bun.inspect(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});

describe("prepare", () => {
  test("without ORIGIN changes nothing and warns unless PROTOCOL_HEADER is set", () => {
    const environment: Record<string, string | undefined> = { PORT: "3000" };
    expect(prepare(environment)).toEqual({ mode: "direct", warning: MISSING_ORIGIN_WARNING });
    expect(environment).toEqual({ PORT: "3000" });

    expect(prepare({ PROTOCOL_HEADER: "x-forwarded-proto" })).toEqual({
      mode: "direct",
      warning: null,
    });
    expect(prepare({ ORIGIN: "" })).toEqual({ mode: "direct", warning: MISSING_ORIGIN_WARNING });
  });

  test("with ORIGIN prepares a private socket and the front's headers", () => {
    const environment: Record<string, string | undefined> = {
      ORIGIN: "HTTP://192.168.1.10:3000/",
      PORT_HEADER: "x-forwarded-port",
      PROTOCOL_HEADER: "x-forwarded-proto",
      HOST_HEADER: "x-forwarded-host",
      BODY_SIZE_LIMIT: "2M",
    };
    const plan = prepare(environment);
    if (plan.mode !== "front") throw new Error("expected the front");
    cleanups.push(() => rmSync(plan.directory, { recursive: true, force: true }));

    expect(plan.origin.origin).toBe("http://192.168.1.10:3000");
    expect(plan.hostname).toBe("0.0.0.0");
    expect(plan.port).toBe(3000);
    expect(plan.idleTimeout).toBeUndefined();
    expect(plan.ownPeerHeader).toBe(true);
    expect(plan.directory.startsWith(join(tmpdir(), "setun-"))).toBe(true);
    expect(existsSync(plan.directory)).toBe(true);
    expect(plan.socket).toBe(join(plan.directory, "app.sock"));
    expect(environment).toEqual({
      ORIGIN: "HTTP://192.168.1.10:3000/",
      SOCKET_PATH: plan.socket,
      PROTOCOL_HEADER,
      HOST_HEADER,
      ADDRESS_HEADER: PEER_HEADER,
      CONNECTION_IDLE_TIMEOUT: "0",
      BODY_SIZE_LIMIT: "2M",
    });
  });

  test("keeps an operator ADDRESS_HEADER and XFF_DEPTH, and takes the client idle timeout", () => {
    const environment: Record<string, string | undefined> = {
      ORIGIN: "https://setun.example.org",
      ADDRESS_HEADER: "x-forwarded-for",
      XFF_DEPTH: "1",
      CONNECTION_IDLE_TIMEOUT: "30",
      HOST: "::",
      PORT: "8080",
    };
    const plan = prepare(environment);
    if (plan.mode !== "front") throw new Error("expected the front");
    cleanups.push(() => rmSync(plan.directory, { recursive: true, force: true }));
    expect(plan.ownPeerHeader).toBe(false);
    expect(plan.idleTimeout).toBe(30);
    expect(plan.hostname).toBe("::");
    expect(plan.port).toBe(8080);
    expect(environment.ADDRESS_HEADER).toBe("x-forwarded-for");
    expect(environment.XFF_DEPTH).toBe("1");
    expect(environment.CONNECTION_IDLE_TIMEOUT).toBe("0");
  });

  test("does not map IDLE_TIMEOUT, which adapter-node used as a sleep timer", () => {
    const environment: Record<string, string | undefined> = {
      ORIGIN: "http://setun.example",
      IDLE_TIMEOUT: "20",
    };
    const plan = prepare(environment);
    if (plan.mode !== "front") throw new Error("expected the front");
    cleanups.push(() => rmSync(plan.directory, { recursive: true, force: true }));
    expect(plan.idleTimeout).toBeUndefined();
    expect(environment.IDLE_TIMEOUT).toBe("20");
    expect(environment.CONNECTION_IDLE_TIMEOUT).toBe("0");
  });

  test.each([
    ["PORT", { ORIGIN: "http://a.example", PORT: "http" }],
    ["PORT", { ORIGIN: "http://a.example", PORT: "70000" }],
    ["CONNECTION_IDLE_TIMEOUT", { ORIGIN: "http://a.example", CONNECTION_IDLE_TIMEOUT: "300" }],
    ["ORIGIN", { ORIGIN: "http://a.example/path" }],
  ])("rejects an invalid %s before creating a socket directory", (name, environment) => {
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith("setun-"));
    expect(() => prepare({ ...environment })).toThrow(new RegExp(`^${name} must be`));
    const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith("setun-"));
    expect(after).toEqual(before);
  });

  test("reads SHUTDOWN_TIMEOUT as the adapter does, and keeps its 30 s default", () => {
    expect(shutdownTimeoutSeconds({})).toBe(30);
    expect(shutdownTimeoutSeconds({ SHUTDOWN_TIMEOUT: "5" })).toBe(5);
    expect(shutdownTimeoutSeconds({ SHUTDOWN_TIMEOUT: "soon" })).toBe(30);
  });
});

describe("frontHeaders", () => {
  const origin = new URL("http://192.168.1.10:3000");

  test("overwrites the origin and peer headers a client sent", () => {
    const headers = frontHeaders(
      new Headers({
        [PROTOCOL_HEADER]: "https",
        [HOST_HEADER]: "attacker.test",
        [PEER_HEADER]: "203.0.113.9",
        cookie: "a=b",
      }),
      { origin, ownPeerHeader: true, peer: "198.51.100.7" },
    );
    expect(headers.get(PROTOCOL_HEADER)).toBe("http");
    expect(headers.get(HOST_HEADER)).toBe("192.168.1.10:3000");
    expect(headers.get(PEER_HEADER)).toBe("198.51.100.7");
    expect(headers.get("cookie")).toBe("a=b");
  });

  test("drops a client peer header when the operator's ADDRESS_HEADER is used", () => {
    const headers = frontHeaders(
      new Headers({ [PEER_HEADER]: "203.0.113.9", "x-forwarded-for": "203.0.113.9, 198.51.100.7" }),
      { origin, ownPeerHeader: false, peer: "127.0.0.1" },
    );
    expect(headers.has(PEER_HEADER)).toBe(false);
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.9, 198.51.100.7");
  });
});

describe("forwardPath and buildEntry", () => {
  test("forwards the path and query byte for byte", () => {
    expect(forwardPath("http://x/_app/immutable/a%20b.js?v=%2F&q")).toBe(
      "/_app/immutable/a%20b.js?v=%2F&q",
    );
    expect(forwardPath("http://x//double")).toBe("//double");
    expect(forwardPath("http://x")).toBe("/");
  });

  test("resolves the build beside server.js, or from SETUN_BUILD_DIR", () => {
    expect(buildEntry({})).toBe(join(import.meta.dir, "build", "index.js"));
    expect(buildEntry({ SETUN_BUILD_DIR: "/srv/setun/build-a" })).toBe(
      "/srv/setun/build-a/index.js",
    );
    expect(buildEntry({ SETUN_BUILD_DIR: "other" })).toBe(
      join(import.meta.dir, "other", "index.js"),
    );
  });
});

describe("bun ./server.js", () => {
  test("without ORIGIN starts the build directly and warns exactly once", async () => {
    const server = await start({});
    const seen = await echo(server.port);
    expect(seen.env).toMatchObject({ SOCKET_PATH: null, PROTOCOL_HEADER: null, HOST_HEADER: null });
    await sleep(100);
    expect(count(server.output(), MISSING_ORIGIN_WARNING)).toBe(1);
    expect(socketDirectories(server.temp)).toEqual([]);
  });

  test("does not warn when ORIGIN or PROTOCOL_HEADER is set", async () => {
    const withProtocol = await start({ PROTOCOL_HEADER: "x-forwarded-proto" });
    await echo(withProtocol.port);

    const port = await freePort();
    const fronted = await start({ ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port) });
    await echo(fronted.port);

    await sleep(100);
    expect(withProtocol.output()).not.toContain(MISSING_ORIGIN_WARNING);
    expect(fronted.output()).not.toContain(MISSING_ORIGIN_WARNING);
  });

  test("with ORIGIN fronts the build and overwrites the origin and peer headers", async () => {
    const port = await freePort();
    const server = await start({ ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port) });
    expect(server.output()).toContain(`for http://127.0.0.1:${port}`);
    expect(socketDirectories(server.temp)).toHaveLength(1);

    const seen = await echo(server.port, {
      headers: {
        host: "attacker.test",
        [PROTOCOL_HEADER]: "https",
        [HOST_HEADER]: "attacker.test",
        [PEER_HEADER]: "203.0.113.9",
        "x-forwarded-for": "203.0.113.9",
      },
    });
    expect(seen.env).toMatchObject({
      PROTOCOL_HEADER,
      HOST_HEADER,
      ADDRESS_HEADER: PEER_HEADER,
      PORT_HEADER: null,
      CONNECTION_IDLE_TIMEOUT: "0",
    });
    expect(seen.env.SOCKET_PATH).toMatch(/setun-[^/]+\/app\.sock$/);
    expect(seen.headers[PROTOCOL_HEADER]).toBe("http");
    expect(seen.headers[HOST_HEADER]).toBe(`127.0.0.1:${port}`);
    expect(seen.headers[PEER_HEADER]).toBe("127.0.0.1");
    // Forwarded headers pass through; the adapter trusts only the ones it is told to.
    expect(seen.headers["x-forwarded-for"]).toBe("203.0.113.9");
  });

  test.each([
    ["an uppercase scheme and host", (port: number) => `HTTP://LocalHost:${port}`],
    ["a trailing slash", (port: number) => `http://localhost:${port}/`],
    ["surrounding whitespace", (port: number) => `  http://localhost:${port}  `],
  ])("normalizes ORIGIN with %s and sends the canonical origin", async (_case, origin) => {
    const port = await freePort();
    const server = await start({ ORIGIN: origin(port), PORT: String(port) });
    const seen = await echo(server.port);
    expect(seen.headers[PROTOCOL_HEADER]).toBe("http");
    expect(seen.headers[HOST_HEADER]).toBe(`localhost:${port}`);
    expect(server.output()).toContain(`for http://localhost:${port}`);
  });

  test.each([
    ["http", "HTTP://Setun.Example:80", "http", "setun.example"],
    ["https", "https://SETUN.example:443/", "https", "setun.example"],
  ])("drops an explicit default port on %s", async (_scheme, origin, proto, host) => {
    const server = await start({ ORIGIN: origin });
    const seen = await echo(server.port);
    expect(seen.headers[PROTOCOL_HEADER]).toBe(proto);
    expect(seen.headers[HOST_HEADER]).toBe(host);
  });

  test("passes an operator ADDRESS_HEADER through untouched and drops a client peer header", async () => {
    const port = await freePort();
    const server = await start({
      ORIGIN: `http://127.0.0.1:${port}`,
      PORT: String(port),
      ADDRESS_HEADER: "x-forwarded-for",
      XFF_DEPTH: "1",
    });
    const seen = await echo(server.port, {
      headers: { [PEER_HEADER]: "203.0.113.9", "x-forwarded-for": "203.0.113.9, 198.51.100.7" },
    });
    expect(seen.env).toMatchObject({ ADDRESS_HEADER: "x-forwarded-for", XFF_DEPTH: "1" });
    expect(seen.headers["x-forwarded-for"]).toBe("203.0.113.9, 198.51.100.7");
    expect(seen.headers).not.toHaveProperty(PEER_HEADER);
  });

  test("forwards method, path, query and body, and leaves redirects and encodings alone", async () => {
    const port = await freePort();
    const server = await start({ ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port) });

    const posted = await echo(server.port, { method: "POST", body: "hello" });
    expect(posted).toMatchObject({ method: "POST", body: "hello" });
    expect(new URL(posted.url).search).toBe("?x=1");
    expect((await echo(server.port)).body).toBe("");

    const encoded = await rawRequest(
      server.port,
      "GET /echo/caf%C3%A9%2Fx%20y?q=a%20b&r=%2F HTTP/1.1\r\nHost: anything",
    );
    expect(encoded).toContain("/echo/caf%C3%A9%2Fx%20y?q=a%20b&r=%2F");

    const redirect = await fetch(`http://127.0.0.1:${server.port}/redirect`, {
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/elsewhere");

    const gzip = await fetch(`http://127.0.0.1:${server.port}/gzip`, {
      headers: { "accept-encoding": "gzip" },
      decompress: false,
    });
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(await gzip.arrayBuffer()).subarray(0, 2)).toEqual(
      new Uint8Array([0x1f, 0x8b]),
    );
  });

  test("leaves the body limit to the adapter", async () => {
    const port = await freePort();
    const server = await start({
      ORIGIN: `http://127.0.0.1:${port}`,
      PORT: String(port),
      BODY_SIZE_LIMIT: "2M",
    });
    const body = "a".repeat(3 * 1024 * 1024);
    const seen = await echo(server.port, { method: "POST", body });
    expect(seen.env.BODY_SIZE_LIMIT).toBe("2M");
    // The stand-in sets no limit, so a body above the adapter's limit reaches it intact.
    expect(seen.body.length).toBe(body.length);
  });

  test("propagates a client abort to the build", async () => {
    const port = await freePort();
    const marker = join(scratch(), "aborted");
    const server = await start({
      ORIGIN: `http://127.0.0.1:${port}`,
      PORT: String(port),
      STANDIN_ABORT_FILE: marker,
    });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}/hold`, {
      signal: controller.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    await until(() => existsSync(marker));
  });

  test("answers 503 when the build is unreachable", async () => {
    const port = await freePort();
    const server = await start({ ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port) });
    await fetch(`http://127.0.0.1:${server.port}/stop`);
    await sleep(100);
    const reply = await fetch(`http://127.0.0.1:${server.port}/echo`);
    expect(reply.status).toBe(503);
  });

  test("keeps an idle event stream open past the client idle timeout", async () => {
    const port = await freePort();
    const server = await start({
      ORIGIN: `http://127.0.0.1:${port}`,
      PORT: String(port),
      CONNECTION_IDLE_TIMEOUT: "1",
    });
    const reply = await fetch(`http://127.0.0.1:${server.port}/sse?gap=2500`);
    expect(reply.headers.get("content-type")).toBe("text/event-stream");
    expect(await reply.text()).toBe("data: one\n\ndata: two\n\n");
  }, 15_000);

  test("exits 0 on SIGTERM with nothing in flight, and removes the socket directory", async () => {
    const port = await freePort();
    const server = await start({ ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port) });
    expect(socketDirectories(server.temp)).toHaveLength(1);
    server.process.kill("SIGTERM");
    expect(await server.process.exited).toBe(0);
    expect(socketDirectories(server.temp)).toEqual([]);
  }, 15_000);

  /**
   * The regression this front exists to avoid: the build finishes its side of a response,
   * drains and emits `sveltekit:shutdown`, while a slow client is still downloading from the
   * front. Closing then truncated the download (2026-10-02: HTTP 200 with curl error 18,
   * 8,125,243 of 8,388,608 bytes). curl's rate limit makes the client slow.
   */
  test("on SIGTERM a slow client still receives the whole body after the build has drained", async () => {
    const port = await freePort();
    const server = await start({
      ORIGIN: `http://127.0.0.1:${port}`,
      PORT: String(port),
      SHUTDOWN_TIMEOUT: "20",
    });
    const curl = Bun.spawn(
      [
        "curl",
        "-sS",
        "--limit-rate",
        "2M",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code} %{size_download} %{size_header}",
        `http://127.0.0.1:${server.port}/big`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await sleep(500);
    server.process.kill("SIGTERM");

    await until(() => server.output().includes("standin drained"), 10_000);
    const drainedAt = Number(/standin drained at (\d+)/.exec(server.output())?.[1]);
    // Stops accepting new connections while the slow download continues.
    await expect(fetch(`http://127.0.0.1:${server.port}/echo`)).rejects.toThrow();

    const code = await curl.exited;
    const finishedAt = Date.now();
    const [status, bytes] = (await new Response(curl.stdout).text()).split(" ");
    const curlErrors = await new Response(curl.stderr).text();
    expect(curlErrors).toBe("");
    expect(code).toBe(0);
    expect(status).toBe("200");
    expect(Number(bytes)).toBe(8 * 1024 * 1024);
    // The build had drained and emitted sveltekit:shutdown before the client finished.
    expect(drainedAt).toBeLessThan(finishedAt);
    expect(await server.process.exited).toBe(0);
    expect(socketDirectories(server.temp)).toEqual([]);
  }, 40_000);

  test("force-closes a client that cannot finish within SHUTDOWN_TIMEOUT", async () => {
    const port = await freePort();
    const server = await start({
      ORIGIN: `http://127.0.0.1:${port}`,
      PORT: String(port),
      SHUTDOWN_TIMEOUT: "5",
    });
    const curl = Bun.spawn(
      [
        "curl",
        "-sS",
        "--limit-rate",
        "64K",
        "-o",
        "/dev/null",
        "-w",
        "%{size_download}",
        `http://127.0.0.1:${server.port}/big`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await sleep(500);
    const signalled = Date.now();
    server.process.kill("SIGTERM");

    expect(await server.process.exited).toBe(0);
    const elapsed = (Date.now() - signalled) / 1000;
    expect(elapsed).toBeGreaterThanOrEqual(4.5);
    expect(elapsed).toBeLessThan(8);
    await curl.exited;
    expect(Number(await new Response(curl.stdout).text())).toBeLessThan(8 * 1024 * 1024);
    expect(socketDirectories(server.temp)).toEqual([]);
  }, 30_000);

  test("shuts down cleanly when SIGTERM arrives while the build is still loading", async () => {
    const port = await freePort();
    const server = await start(
      { ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port), STANDIN_LOAD_DELAY_MS: "1500" },
      { waitFor: "exit" },
    );
    // The public port is bound before the build loads: wait for a TCP connect (an HTTP
    // request would be held until the build is ready), then signal mid-load.
    await until(async () => {
      try {
        const socket = await Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: { data() {} },
        });
        socket.end();
        return true;
      } catch {
        return false;
      }
    });
    expect(server.output()).not.toContain("standin listening");
    server.process.kill("SIGTERM");
    const exited = await Promise.race([server.process.exited, sleep(8_000).then(() => "timeout")]);
    expect(exited).toBe(0);
    expect(socketDirectories(server.temp)).toEqual([]);
  }, 20_000);

  test("leaves nothing behind when the build fails to load", async () => {
    const port = await freePort();
    const server = await start(
      { ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port), STANDIN_THROW: "1" },
      { waitFor: "exit" },
    );
    expect(await server.process.exited).not.toBe(0);
    expect(server.output()).toContain("stand-in adapter failed to load");
    expect(socketDirectories(server.temp)).toEqual([]);
    // The public port is free again.
    const probe: Server = createServer();
    await new Promise<void>((done, fail) => {
      probe.once("error", fail);
      probe.listen(port, "127.0.0.1", done);
    });
    await new Promise((done) => probe.close(done));
  }, 15_000);

  test("fails clearly when the public port is taken, without starting the build", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", done));
    cleanups.push(() => blocker.close());
    const { port } = blocker.address() as { port: number };

    const server = await start(
      { ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port) },
      { waitFor: "exit" },
    );
    expect(await server.process.exited).not.toBe(0);
    expect(server.output()).toContain(`server.js could not listen on 127.0.0.1:${port}`);
    expect(server.output()).not.toContain("standin listening");
    expect(socketDirectories(server.temp)).toEqual([]);
  }, 15_000);

  test("fails clearly on a malformed ORIGIN without repeating it", async () => {
    const secret = ["fake", "pw", crypto.randomUUID()].join("-");
    for (const origin of [
      `http://user:${secret}@exa mple.com`,
      `http://user:${secret}@setun.example`,
    ]) {
      const server = await start({ ORIGIN: origin }, { waitFor: "exit" });
      expect(await server.process.exited).not.toBe(0);
      expect(server.output()).toContain("ORIGIN must be a bare http(s) origin");
      expect(server.output()).not.toContain(secret);
      expect(server.output()).not.toContain("standin listening");
      expect(socketDirectories(server.temp)).toEqual([]);
    }
  }, 15_000);
});
