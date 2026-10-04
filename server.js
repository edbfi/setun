/**
 * The production entry point (PRD §5): `bun ./server.js`.
 *
 * It installs the process guard from `server-guard.js`, so a failed read of one
 * file fails that request instead of the whole server, and then starts the
 * `@sveltejs/adapter-bun` build in one of two ways:
 *
 *   - **without `ORIGIN`** (or `SETUN_APP_ORIGIN`, which stands in for it), the
 *     build listens directly on `HOST`/`PORT`, and the adapter takes the public
 *     origin to be `https` plus the request's `Host`, which is right behind a
 *     TLS-terminating proxy that preserves `Host`;
 *   - **with `ORIGIN`**, this file is a small front: it listens on `HOST`/`PORT`
 *     itself, runs the build on a private Unix socket in a fresh temporary
 *     directory, and forwards every request to it with headers that state
 *     `ORIGIN`'s scheme and host. Only the front can reach that socket, so only
 *     the front can set those headers, and it overwrites them on every request.
 *     It also stops a request for a static file from asking for a
 *     pre-compressed variant that has gone missing on disk, which the adapter
 *     would answer with a 500 (`dropMissingEncodings` in `server-guard.js`).
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

import { dropMissingEncodings, installServerGuard } from "./server-guard.js";

/** Header names the adapter reads for the origin and the client address, set only here. */
export const PROTOCOL_HEADER = "x-setun-origin-proto";
export const HOST_HEADER = "x-setun-origin-host";
export const PEER_HEADER = "x-setun-peer";

/**
 * Logged once at startup when nothing tells the adapter the public scheme. The
 * wording is the one every edbfi front uses (the shared origin contract).
 */
export const MISSING_ORIGIN_WARNING =
  "ORIGIN is not set: Setun assumes it is served over HTTPS behind a proxy that preserves the " +
  "Host header. Over plain HTTP, signing in and saving changes will fail. Set ORIGIN to the " +
  "address users open, for example ORIGIN=http://192.168.1.10:3000.";

/**
 * The request body limit unless the operator sets BODY_SIZE_LIMIT: just above
 * the 1 MB project cap in src/lib/artifacts/project.ts, because restoring an
 * artifact posts its whole file list, and the adapter's own 512K default
 * refuses a project of a few large files with 413.
 */
export const DEFAULT_BODY_SIZE_LIMIT = "2M";

/** The one startup error for an unusable ORIGIN; it never repeats the value. */
export const ORIGIN_ERROR =
  "ORIGIN must be a bare http(s) origin such as http://192.168.1.10:3000 (no path, query, fragment or credentials).";

/**
 * Parse `ORIGIN`, which must be a bare `http(s)` origin.
 *
 * The value is trimmed and parsed, and the parts are checked one by one: the
 * scheme is `http` or `https`, there are no credentials, the path is `/` and the
 * value has no `?` or `#` (checked on the value itself, because an empty query
 * or fragment leaves no trace on the parsed URL). What remains is normalized to
 * `url.origin`: an uppercase scheme or host, an explicit default port and a
 * trailing `/` are accepted, as adapter-node accepted them, and
 * `HTTP://Setun.Example:80/` means `http://setun.example`.
 *
 * Every failure is the same fresh error, which never contains the value (it
 * could carry credentials); the URL parser's own error is not wrapped either,
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
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    /[?#]/.test(trimmed)
  ) {
    throw new Error(ORIGIN_ERROR);
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
 * Decide how to start, and prepare the environment the adapter will read:
 * the body limit's default, and in front mode the socket, the origin headers,
 * the peer header and the idle timeout.
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
  // In both modes: the adapter enforces it, directly or behind the socket.
  environment.BODY_SIZE_LIMIT ??= DEFAULT_BODY_SIZE_LIMIT;

  // One variable suffices: SETUN_APP_ORIGIN (the URL Setun prints on access
  // slips, which Compose requires) stands in for ORIGIN when ORIGIN is unset,
  // and ORIGIN wins when both are set.
  const configured = environment.ORIGIN?.trim() || environment.SETUN_APP_ORIGIN?.trim();
  if (!configured) {
    // Blank means unset; the app must not read a blank ORIGIN either.
    delete environment.ORIGIN;
    const warning = environment.PROTOCOL_HEADER ? null : MISSING_ORIGIN_WARNING;
    return { mode: "direct", warning };
  }

  const origin = parseOrigin(configured);
  const hostname = environment.HOST || "0.0.0.0";
  const port = integer("PORT", environment.PORT || "3000", 65535);
  const idle = environment.CONNECTION_IDLE_TIMEOUT;
  const idleTimeout = idle ? integer("CONNECTION_IDLE_TIMEOUT", idle, 255) : undefined;

  // The canonical value, so the app reads the same string the front sends.
  environment.ORIGIN = origin.origin;

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
 * For a static file request (any path, not only `/_app/`), stop asking for a
 * pre-compressed variant that is missing on disk (see `dropMissingEncodings`
 * in server-guard.js).
 *
 * @param {Headers} headers modified in place
 * @param {string} method
 * @param {string} path the forwarded path and query
 * @param {string} clientDir
 */
export function guardEncodings(headers, method, path, clientDir) {
  if (method !== "GET" && method !== "HEAD") return;
  const replacement = dropMissingEncodings(
    headers.get("accept-encoding"),
    path.split("?")[0] ?? "",
    clientDir,
  );
  if (replacement !== null) headers.set("accept-encoding", replacement);
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
 * An event-stream body that ends normally when the adapter breaks it off.
 *
 * At the end of its shutdown drain the adapter force-closes the streams still
 * open, and a body passed through as is would then fail on the public side too,
 * which a browser reports as a connection reset. Ending it cleanly instead lets
 * `EventSource` and the chat's resumable turn reconnect as they would after any
 * ordinary end of stream. A client that goes away still cancels the upstream.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @returns {ReadableStream<Uint8Array>}
 */
export function endQuietly(body) {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
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
  const clientDir = join(dirname(buildEntry(environment)), "client");
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
        const path = forwardPath(request.url);
        guardEncodings(headers, request.method, path, clientDir);
        /** @type {Response} */
        let response;
        try {
          response = await fetch(`http://localhost${path}`, {
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
        // (a chat turn waiting on the model) is exempted here, and it ends
        // normally if the adapter breaks it off at shutdown.
        if (
          response.headers.get("content-type")?.startsWith("text/event-stream") &&
          response.body
        ) {
          server.timeout(request, 0);
          return new Response(endQuietly(response.body), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
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
  // A second signal before then exits with status 1, as the adapter does for a
  // second signal. These handlers stay registered, so a signal never falls
  // through to the default handler, which would skip the cleanup on exit.
  let loaded = false;
  /** @type {NodeJS.Signals | undefined} */
  let earlySignal;
  /** @param {NodeJS.Signals} signal */
  const onSignal = (signal) => {
    startDrain();
    if (loaded) return;
    if (earlySignal) process.exit(1);
    earlySignal = signal;
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
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.once("sveltekit:shutdown", onShutdown);
  // Every exit removes the socket directory, including the adapter's
  // process.exit(1) on a second signal, which never emits sveltekit:shutdown
  // (synchronously, as exit handlers must).
  process.once("exit", removeSocketDirectory);

  try {
    await importServer();
  } catch (error) {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("sveltekit:shutdown", onShutdown);
    process.off("exit", removeSocketDirectory);
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
