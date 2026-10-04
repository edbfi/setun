/**
 * Keeping a static-file problem from becoming an outage (PRD §5, §21).
 *
 * Two helpers, both used by `server.js` and both about the same failure: the
 * set of files the server believes it can serve and the set actually on disk
 * are allowed to disagree. `installServerGuard` keeps that from ending the
 * process; `dropMissingEncodings` keeps it from failing the request.
 *
 * They live here rather than in `server.js` so a test can exercise them without
 * starting a server.
 *
 * ---
 *
 * Keeping the server alive when a single file read fails.
 *
 * The set of files on disk and the set the server believes in diverge whenever
 * a deployment writes into `build/` under a running server, whenever a copy
 * lands `.js` before its `.br`, and whenever a build is interrupted. Under
 * adapter-node a failed read there reached nothing that handled it, and the
 * process exited: a single unauthenticated `GET` for one asset ended the lesson
 * for every pupil in the school, and nothing served again until an operator
 * restarted.
 *
 * `@sveltejs/adapter-bun` serves those files from Bun's native routes, and Bun
 * answers a failed read with a 500 and keeps serving (reproduced 2026-10-04,
 * with and without this guard). The guard stays all the same: it costs two
 * listeners, and it is what keeps any other failed read of one file — one that
 * reaches the process level from anywhere in the application — from taking the
 * server down. Narrowly:
 *
 *   - a filesystem error about a specific path is logged and swallowed;
 *   - everything else keeps the old behaviour and exits, because an unexpected
 *     fault may well have left the process in a state where continuing is worse
 *     than restarting.
 *
 * `server.js` installs this before it imports the build. Nothing here logs a
 * URL, a body or a header — only the syscall, the error code and the path,
 * which is the same class of detail §16 already permits.
 */

import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";

/**
 * Error codes that mean "this one file could not be read", and nothing worse.
 *
 * Deliberately not a catch-all. `EMFILE` and `ENOMEM` are also `fs` errors and
 * are deliberately absent: they say the process is out of a resource, which is
 * exactly the case where exiting and being restarted is the right answer.
 */
const RECOVERABLE_FS_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP"]);

/**
 * True for an error that is a failed read of one named file.
 *
 * Both `syscall` and `path` are required. A bare `ENOENT` with neither is not a
 * file read — it is something rethrowing a code it liked the look of, and it
 * gets the default treatment.
 */
export function isRecoverableFileError(error) {
  if (typeof error !== "object" || error === null) return false;

  const candidate = /** @type {NodeJS.ErrnoException} */ (error);

  return (
    typeof candidate.code === "string" &&
    RECOVERABLE_FS_CODES.has(candidate.code) &&
    typeof candidate.syscall === "string" &&
    typeof candidate.path === "string"
  );
}

/**
 * One line an operator can act on, carrying no request detail.
 *
 * The path is the asset that is missing, which is the whole point of the line;
 * it is a build artefact path, not anything a pupil wrote.
 */
function describe(error) {
  const { code, syscall, path } = /** @type {NodeJS.ErrnoException} */ (error);
  return `${code} on ${syscall}: ${path}`;
}

/**
 * Install the listeners.
 *
 * Exported so a test can drive it against a stub process rather than the real
 * one — registering a real `uncaughtException` handler inside a test runner
 * would change how that runner reports every later failure.
 */
export function installServerGuard(target = process) {
  target.on("uncaughtException", (error) => {
    if (isRecoverableFileError(error)) {
      console.error(`server-guard: recovered from a failed file read — ${describe(error)}`);
      return;
    }

    console.error(error);
    target.exit(1);
  });

  target.on("unhandledRejection", (reason) => {
    if (isRecoverableFileError(reason)) {
      console.error(`server-guard: recovered from a failed file read — ${describe(reason)}`);
      return;
    }

    console.error(reason);
    target.exit(1);
  });
}

/**
 * Pre-compressed encodings adapter-bun serves, under the names its negotiation
 * uses, and the suffix each one is stored under. `*` selects them in this
 * order.
 */
const ENCODINGS = [
  ["br", ".br"],
  ["gzip", ".gz"],
];

/** An `Accept-Encoding` part's lower-cased name, or null when it says `q=0`. */
function acceptedName(part) {
  const [name = "", ...params] = part.toLowerCase().split(";");
  return params.some((param) => /^q=0(\.0*)?$/.test(param.trim())) ? null : name.trim();
}

/**
 * Ask for a pre-compressed variant only if it is actually on disk.
 *
 * adapter-bun records which `.br` and `.gz` files exist when the app is built,
 * and serves the variant the request's `Accept-Encoding` selects without
 * checking again. Disk can disagree with that record afterwards — a deployment
 * writing into `build/` under a running server, a copy that lands `.js` before
 * its `.br`, an interrupted build — and then every browser, all of which ask
 * for Brotli, gets a 500 for that asset and the page stays broken (reproduced
 * 2026-10-04 with adapter-bun 1.0.0; under adapter-node the same case stalled
 * the request).
 *
 * Returns the header to forward instead, or null to leave it alone. It mirrors
 * adapter-bun's negotiation exactly: names are compared lower-cased and whole,
 * a part with `q=0` is ignored, and `*` stands for every encoding. A missing
 * variant's name is dropped, and `*` is replaced by the names still on disk, so
 * the request is served compressed where possible and plain otherwise.
 *
 * Only `/_app/` is considered: those are the hashed, immutable build outputs,
 * where this happens. It costs one `existsSync` per encoding on requests that
 * both ask for one and address a build asset.
 *
 * `server.js` applies it in the front, before forwarding. The front runs only
 * when ORIGIN is set; without it the adapter listens directly and a missing
 * variant answers 500 until the build directory is whole again.
 *
 * @param {string | null | undefined} accept the request's `Accept-Encoding`
 * @param {string} pathname the request path, still percent-encoded
 * @param {string} clientDir the build's `client` directory
 * @returns {string | null}
 */
export function dropMissingEncodings(accept, pathname, clientDir) {
  if (typeof accept !== "string" || accept === "") return null;
  if (!pathname.startsWith("/_app/")) return null;

  let asset;
  try {
    // `normalize` collapses any `..` before the prefix check below, so a crafted
    // path cannot make this stat a file outside the build directory.
    //
    // Wrapped, because both steps throw on input a client is free to send:
    // `decodeURIComponent` on a malformed escape such as `/_app/%`, and `join`
    // on a path containing a null byte. A request we cannot make sense of is
    // simply left alone for the adapter to answer as it would.
    asset = normalize(join(clientDir, decodeURIComponent(pathname)));
  } catch {
    return null;
  }

  if (!asset.startsWith(clientDir + sep)) return null;

  const parts = accept
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const accepted = new Set(parts.map(acceptedName).filter((name) => name !== null));
  const wildcard = accepted.has("*");

  const missing = ENCODINGS.filter(
    ([token, suffix]) => (accepted.has(token) || wildcard) && !existsSync(asset + suffix),
  ).map(([token]) => token);

  if (missing.length === 0) return null;

  const kept = parts.filter((part) => {
    const name = acceptedName(part);
    return name === null || (!missing.includes(name) && name !== "*");
  });
  if (wildcard) {
    for (const [token] of ENCODINGS) {
      if (!missing.includes(token) && !accepted.has(token)) kept.push(token);
    }
  }

  // An empty header would mean "anything", so say plainly that only the
  // uncompressed file will do.
  return kept.length > 0 ? kept.join(", ") : "identity";
}
