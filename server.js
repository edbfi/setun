/**
 * The production entry point (PRD §5): `bun ./server.js`.
 *
 * It installs the process guard from `server-guard.js`, so a failed read of one
 * file fails that request instead of the whole server, and then starts the
 * `@sveltejs/adapter-bun` build in one of two ways:
 *
 *   - **without `ORIGIN`**, the build listens directly on `HOST`/`PORT`, and the
 *     adapter takes the public origin to be `https` plus the request's `Host`,
 *     which is right behind a TLS-terminating proxy that preserves `Host`;
 *   - **with `ORIGIN`**, this file is a small front: it listens on `HOST`/`PORT`
 *     itself, runs the build on a private Unix socket in a fresh temporary
 *     directory, and forwards every request to it with headers that state
 *     `ORIGIN`'s scheme and host. Only the front can reach that socket, so only
 *     the front can set those headers, and it overwrites them on every request.
 *
 * Why a front at all: SvelteKit 3 has no runtime `ORIGIN` (adapter-node's
 * variable is gone, and `paths.origin` is fixed at build time), and Kit checks a
 * form post's `Origin` against the request's origin before any hook runs. A
 * plain-HTTP deployment — Playwright, the dev suite, a classroom server reached
 * by its LAN address — would otherwise have every form post refused with 403.
 * The adapter's documentation names the fix: a protocol header set by "a proxy
 * you control". This is that proxy, owned by the app, so one image serves any
 * origin and `ORIGIN` keeps the meaning it had under adapter-node. The origin
 * is never derived from the request's `Host` header: that would reopen DNS
 * rebinding, and a server on a network has no single origin to derive.
 *
 * `build/index.js` is generated, so it is imported rather than edited, and
 * `Bun.serve` is not patched: the adapter is configured only through the
 * environment variables it documents.
 *
 * ---
 *
 * Why this lives in the repository root, and not in `src/`.
 *
 * Because the root is where a Node or Bun server entry belongs, and because
 * `src/` is the wrong kind of directory for it. `src/` is *input*: Vite and
 * SvelteKit compile everything under it, `svelte-check` and `tsconfig.json`
 * scope to it, and nothing there is executed as it was written. This file is
 * the opposite — it ships unbuilt and runs the build's output — so putting it
 * beside `src/routes` would say something untrue about what it is.
 *
 * It also has to sit next to the build it loads. The Dockerfile copies `build/`,
 * `server.js` and `server-guard.js` into one working directory precisely so that
 * `./build/index.js` resolves; a subdirectory would mean recreating that layout
 * in the image for nothing. And four call sites name this path — `package.json`'s
 * `start`, the Dockerfile `CMD`, and both Playwright `webServer` commands — none
 * of which reads better for the change.
 *
 * `server-guard.js` follows it, being what this file imports, and the tests sit
 * beside the modules they test (`server.test.ts`, `server-guard.test.ts`), as
 * every other test in the repository does. The question is closed: they stay
 * here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installServerGuard } from "./server-guard.js";

/** Header names the adapter reads for the origin and the client address, set only here. */
export const PROTOCOL_HEADER = "x-setun-origin-proto";
export const HOST_HEADER = "x-setun-origin-host";
export const PEER_HEADER = "x-setun-peer";

/** Logged once at startup when nothing tells the adapter the public scheme. */
export const MISSING_ORIGIN_WARNING =
  "server.js: ORIGIN is not set and no PROTOCOL_HEADER is configured, so Setun takes the " +
  "public origin to be https plus the request's Host. Over plain HTTP every sign-in and " +
  "every other form post is then rejected with 403. Set ORIGIN to the public URL (for " +
  "example http://192.168.1.10:3000) when serving plain HTTP; leave it unset only behind " +
  "an HTTPS proxy that preserves Host.";

const ORIGIN_SHAPE = "ORIGIN must be a bare http(s) origin: a scheme, a host and an optional port";

/**
 * Parse `ORIGIN`, which must be a bare `http(s)` origin.
 *
 * The parts are checked one by one, and the result is normalized: surrounding
 * whitespace, an uppercase scheme or host, an explicit default port and a
 * trailing `/` are accepted, as adapter-node accepted them, and
 * `HTTP://Setun.Example:80/` means `http://setun.example`. A path, a query, a
 * fragment or credentials are refused (adapter-node silently dropped them).
 *
 * The error is always a fresh one naming `ORIGIN` and never the value, which
 * could carry credentials; the URL parser's own error is not wrapped either,
 * because it keeps the raw input.
 *
 * @param {string} value
 * @returns {URL}
 */
export function parseOrigin(value) {
  const trimmed = value.trim();
  /** @type {URL | undefined} */
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    // fall through to the redacted error below
  }
  if (!url) throw new Error(`${ORIGIN_SHAPE}; it is not a valid URL.`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${ORIGIN_SHAPE}; the scheme must be http or https.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${ORIGIN_SHAPE}; remove the credentials.`);
  }
  // `?` and `#` are checked on the value itself: an empty query or fragment
  // leaves no trace on the parsed URL.
  if (url.pathname !== "/" || /[?#]/.test(trimmed)) {
    throw new Error(`${ORIGIN_SHAPE}; remove the path, query or fragment.`);
  }
  return url;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {number} max
 */
function integer(name, value, max) {
  if (!/^\d+$/.test(value) || Number(value) > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}.`);
  }
  return Number(value);
}

/**
 * The adapter's `SHUTDOWN_TIMEOUT` in seconds, parsed as adapter-bun parses it
 * (a non-negative integer, default 30). A malformed value is left for the
 * adapter to reject at startup.
 *
 * @param {Record<string, string | undefined>} environment
 */
export function shutdownTimeoutSeconds(environment) {
  const value = environment.SHUTDOWN_TIMEOUT;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : 30;
}

/**
 * @typedef {{ mode: "direct"; warning: string | null }} DirectPlan
 * @typedef {{
 *   mode: "front";
 *   origin: URL;
 *   hostname: string;
 *   port: number;
 *   idleTimeout: number | undefined;
 *   ownPeerHeader: boolean;
 *   directory: string;
 *   socket: string;
 * }} FrontPlan
 */

/**
 * Decide how to start, and prepare the environment the adapter will read.
 *
 * Mutates `environment`, and in front mode creates the socket directory: the
 * adapter reads its configuration once, when the build is imported, so all of
 * this has to happen first.
 *
 * `IDLE_TIMEOUT` is deliberately not mapped to `CONNECTION_IDLE_TIMEOUT`.
 * Under adapter-node it was a systemd socket-activation sleep timer, not a
 * connection timeout, and nothing in Setun's deployment sets it.
 *
 * @param {Record<string, string | undefined>} environment
 * @returns {DirectPlan | FrontPlan}
 */
export function prepare(environment) {
  if (!environment.ORIGIN) {
    const warning = environment.PROTOCOL_HEADER ? null : MISSING_ORIGIN_WARNING;
    return { mode: "direct", warning };
  }

  const origin = parseOrigin(environment.ORIGIN);
  const hostname = environment.HOST || "0.0.0.0";
  const port = integer("PORT", environment.PORT || "3000", 65535);
  const idle = environment.CONNECTION_IDLE_TIMEOUT;
  const idleTimeout = idle ? integer("CONNECTION_IDLE_TIMEOUT", idle, 255) : undefined;

  const directory = mkdtempSync(join(tmpdir(), "setun-"));
  const socket = join(directory, "app.sock");
  environment.SOCKET_PATH = socket;

  // The front overwrites both headers on every request, so no client can forge
  // them, and ORIGIN wins over any protocol, host or port header configured
  // for a proxy.
  environment.PROTOCOL_HEADER = PROTOCOL_HEADER;
  environment.HOST_HEADER = HOST_HEADER;
  delete environment.PORT_HEADER;

  // Behind Caddy, ADDRESS_HEADER is `x-forwarded-for` with XFF_DEPTH=1, and it
  // passes through untouched so the limiter still keys on the hop Caddy
  // appended. Without one, the front reports the TCP peer itself.
  const ownPeerHeader = !environment.ADDRESS_HEADER;
  if (ownPeerHeader) environment.ADDRESS_HEADER = PEER_HEADER;

  // On a Unix socket the adapter's idle exemption for event streams does not
  // take effect (Bun 1.4.2, oven-sh/bun#43816: idle streams close after about
  // 12 s), so the socket side never times out and the public listener below
  // enforces the client idle timeout instead.
  environment.CONNECTION_IDLE_TIMEOUT = "0";

  return { mode: "front", origin, hostname, port, idleTimeout, ownPeerHeader, directory, socket };
}

/**
 * The headers forwarded to the adapter: the client's own, with the origin
 * headers overwritten and the peer header set by the front or removed.
 *
 * @param {Headers} incoming
 * @param {{ origin: URL; ownPeerHeader: boolean; peer: string | undefined }} options
 */
export function frontHeaders(incoming, { origin, ownPeerHeader, peer }) {
  const headers = new Headers(incoming);
  headers.set(PROTOCOL_HEADER, origin.protocol.slice(0, -1));
  headers.set(HOST_HEADER, origin.host);
  if (ownPeerHeader) headers.set(PEER_HEADER, peer ?? "");
  else headers.delete(PEER_HEADER);
  return headers;
}

/**
 * The path and query of a request, exactly as Bun received them.
 *
 * Taken from the URL string rather than re-serialized, so an encoded path stays
 * encoded byte for byte.
 *
 * @param {string} requestUrl
 */
export function forwardPath(requestUrl) {
  const scheme = requestUrl.indexOf("://");
  const start = scheme === -1 ? 0 : requestUrl.indexOf("/", scheme + 3);
  return start === -1 ? "/" : requestUrl.slice(start);
}

/**
 * Where the adapter-bun build lives: `build/` beside this file, or
 * `SETUN_BUILD_DIR`.
 *
 * SETUN_BUILD_DIR is the dev suite's override, matching `out` in
 * vite.config.ts, so two of its instances can each run their own build instead
 * of taking turns emptying one directory. Resolved against this file rather
 * than the working directory, so `bun ./server.js` means the same thing from
 * anywhere; an absolute value wins outright, which is what the suite passes.
 *
 * @param {Record<string, string | undefined>} environment
 */
export function buildEntry(environment) {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(resolve(here, environment.SETUN_BUILD_DIR || "build"), "index.js");
}

/**
 * Start the build, directly or behind the front.
 *
 * @param {Record<string, string | undefined>} [environment]
 * @param {() => Promise<unknown>} [importServer]
 */
export async function serve(
  environment = process.env,
  importServer = () => import(pathToFileURL(buildEntry(environment)).href),
) {
  const plan = prepare(environment);
  if (plan.mode === "direct") {
    if (plan.warning) console.warn(plan.warning);
    await importServer();
    return;
  }

  const { origin, ownPeerHeader, directory, socket } = plan;
  const removeSocketDirectory = () => rmSync(directory, { recursive: true, force: true });
  let markReady = () => {};
  const ready = new Promise((resolveReady) => {
    markReady = () => resolveReady(undefined);
  });

  // The public port is bound before the build loads, so a busy port never
  // starts the application; a request that arrives while it loads waits.
  /** @type {import("bun").Server<undefined>} */
  let listener;
  try {
    listener = Bun.serve({
      hostname: plan.hostname,
      port: plan.port,
      ...(plan.idleTimeout === undefined ? {} : { idleTimeout: plan.idleTimeout }),
      // BODY_SIZE_LIMIT is the adapter's, behind the socket; never cap lower here.
      maxRequestBodySize: Number.MAX_SAFE_INTEGER,
      async fetch(request, server) {
        await ready;
        const headers = frontHeaders(request.headers, {
          origin,
          ownPeerHeader,
          peer: server.requestIP(request)?.address,
        });
        /** @type {Response} */
        let response;
        try {
          response = await fetch(`http://localhost${forwardPath(request.url)}`, {
            method: request.method,
            headers,
            body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
            redirect: "manual",
            decompress: false,
            signal: request.signal,
            unix: socket,
          });
        } catch {
          return new Response("Service Unavailable", { status: 503 });
        }
        // The public listener applies the idle timeout, so an event stream
        // (a chat turn waiting on the model) is exempted here.
        if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
          server.timeout(request, 0);
        }
        return response;
      },
    });
  } catch (error) {
    removeSocketDirectory();
    throw new Error(
      `server.js could not listen on ${plan.hostname}:${plan.port}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Shutdown, within one budget from the first signal. The adapter drains the
  // socket side for up to SHUTDOWN_TIMEOUT and then emits sveltekit:shutdown.
  // A slow client can still be downloading from this listener at that point,
  // so the front waits for its own drain too, until the same deadline, and
  // force-closes only if the deadline passes; closing as soon as the adapter
  // finished would truncate that download.
  let deadline = 0;
  /** @type {Promise<void> | undefined} */
  let publicDrain;
  const startDrain = () => {
    if (publicDrain) return publicDrain;
    deadline = Date.now() + shutdownTimeoutSeconds(environment) * 1000;
    publicDrain = listener.stop();
    return publicDrain;
  };

  // The adapter installs its own SIGTERM/SIGINT handlers only once the build
  // has loaded. A signal that arrives earlier is remembered and delivered again
  // once they exist, so the adapter still drains and emits sveltekit:shutdown.
  let loaded = false;
  /** @type {NodeJS.Signals | undefined} */
  let earlySignal;
  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    startDrain();
    if (!loaded) earlySignal ??= signal;
  };
  const onShutdown = async () => {
    const drain = startDrain();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const drained = await Promise.race([
      drain.then(() => true),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), Math.max(0, deadline - Date.now()));
      }),
    ]);
    clearTimeout(timer);
    if (!drained) await listener.stop(true);
    removeSocketDirectory();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  process.once("sveltekit:shutdown", onShutdown);

  try {
    await importServer();
  } catch (error) {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("sveltekit:shutdown", onShutdown);
    await listener.stop(true);
    removeSocketDirectory();
    throw error;
  }
  loaded = true;
  markReady();
  if (earlySignal) process.kill(process.pid, earlySignal);

  console.log(`Listening on ${listener.url} for ${origin.origin}`);
}

if (import.meta.main) {
  // Before the build is imported, so the listeners exist before anything
  // accepts a connection and the first request cannot outrun them.
  installServerGuard();
  // A startup failure exits here, explicitly: the guard deliberately keeps the
  // process alive after a failed file read, which is right for one request and
  // wrong for a server that never started.
  await serve().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
