/**
 * The origin check on every write (PRD §21).
 *
 * SvelteKit refuses a cross-site write only when it has no `Content-Type` or a form one
 * (`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`). A JSON write
 * (`POST /api/conversations`, `/api/messages`, the artifact and attachment endpoints) reached its
 * route from any origin that held a pupil's cookie, leaving the browser's CORS preflight and
 * `SameSite=Lax` as the only defence. This closes that gap the way zondarr's frontend does: a
 * `POST`, `PUT`, `PATCH` or `DELETE` of any content type must carry an `Origin` header equal to
 * the app's own origin. A missing `Origin` and `Origin: null` count as foreign, as in Kit's own
 * check.
 *
 * Browsers send the page's origin with every write from a Setun page: `fetch` (`keepalive` ones
 * included), `navigator.sendBeacon` and a form submitted without JavaScript (checked 2026-10-04
 * in Chromium 153 and WebKit 26.6 under Setun's `Referrer-Policy: same-origin`; under
 * `no-referrer` both sent `Origin: null` for the form and WebKit for the beacon). Clients outside
 * a browser, such as Playwright's request API, must send `Origin` themselves.
 *
 * `url` is `event.url`: SvelteKit builds it from the origin the front in `server.js` states
 * (ORIGIN), or the adapter's default of `https` plus `Host`. Nothing here reads `Host` itself.
 */

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The `error` code of the refusal, distinct from SvelteKit's and the routes' own 403s. */
export const CROSS_ORIGIN_WRITE = "cross-origin-write";

/** True for a write whose `Origin` header is not exactly the app's own origin. */
export function isForeignWrite(request: Request, url: URL): boolean {
  if (!WRITE_METHODS.has(request.method)) return false;
  return request.headers.get("origin") !== url.origin;
}

/** The answer to a foreign write, before any route or session work runs. */
export function foreignWriteResponse(): Response {
  return Response.json({ error: CROSS_ORIGIN_WRITE }, { status: 403 });
}
