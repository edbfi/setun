import { redirect } from "@sveltejs/kit";
import { type Handle, sequence } from "@sveltejs/kit/hooks";
import { cookieName, getTextDirection } from "$lib/paraglide/runtime";
import { paraglideMiddleware } from "$lib/paraglide/server";
import { resolveEducatorSession } from "$lib/server/auth/educator";
import {
  EDUCATOR_SESSION_COOKIE_NAME,
  resolveStudentSession,
  SESSION_COOKIE_NAME,
} from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";
import { studentInterfaceLanguage } from "$lib/server/classroom/settings";
import { cookieDeletion, localeCookieOptions } from "$lib/server/cookies";
import { createHandleError } from "$lib/server/errors";
import { log } from "$lib/server/logging";
import { foreignWriteResponse, isForeignWrite } from "$lib/server/request-origin";
import { isSetupComplete, isSetupGateExempt, SETUP_PATH } from "$lib/server/setup/state";

/**
 * Headers the application origin owes every response (PRD §21).
 *
 * The sandbox origin is hardened in the Caddyfile — a full `default-src 'none'`
 * policy, `nosniff`, `no-referrer` — because that is where untrusted generated
 * code runs. The *application* origin, which holds the session cookies, the
 * pupils' conversations and the teacher panel, was sending none of it.
 *
 * `frame-ancestors 'none'` is the one that earns its place immediately: nothing
 * ever frames Setun (the artifact iframe points the other way, app → sandbox),
 * and without it the panel can be framed by any site, which puts *Lås klassen*,
 * *Sign everyone out* and *Delete for good* one invisible click away.
 * `X-Frame-Options` says the same thing to agents that predate CSP.
 *
 * Deliberately not a full content policy yet. `script-src` and `style-src` on
 * this origin have to account for SvelteKit's inline bootstrap, the on-demand
 * CodeMirror and highlighter chunks, and blob workers; getting that wrong fails
 * closed in a classroom. It is worth doing and it is worth doing with its own
 * verification, so it is left as follow-up rather than guessed at here.
 *
 * Set rather than overwritten: routes that serve pupil files already choose
 * their own `x-content-type-options`, and a blanket assignment here would start
 * quietly deciding for them.
 */
const RESPONSE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["content-security-policy", "frame-ancestors 'none'"],
  ["x-frame-options", "DENY"],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
];

const handleSecurityHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  for (const [name, value] of RESPONSE_HEADERS) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }

  return response;
};

/**
 * Refuse a write from any other origin, whatever its content type (PRD §21).
 *
 * SvelteKit checks only form posts and bodyless writes, so a JSON write carrying a pupil's cookie
 * reached its endpoint from anywhere; see `$lib/server/request-origin`. Placed before the session
 * and setup hooks so a refused write touches neither the database nor a cookie, and after the
 * security headers and the request log so the refusal carries the one and appears in the other.
 */
const handleRequestOrigin: Handle = ({ event, resolve }) => {
  if (isForeignWrite(event.request, event.url)) return foreignWriteResponse();
  return resolve(event);
};

/**
 * Resolve the session cookie into request-scoped state (PRD §7).
 *
 * Request state lives on `event.locals`, typed in `app.d.ts` — never at module
 * scope in a server module, where it would leak between users.
 *
 * A cookie that no longer resolves (expired, invalidated by rotation or
 * force-logout, or belonging to a disabled student) is cleared here, so a stale
 * browser stops presenting it rather than retrying every request.
 */
const handleSession: Handle = async ({ event, resolve }) => {
  const db = getDb();

  event.locals.student = null;
  event.locals.educator = null;
  event.locals.sessionToken = null;

  const token = event.cookies.get(SESSION_COOKIE_NAME);
  if (token) {
    const resolved = resolveStudentSession(db, token);
    if (resolved) {
      event.locals.student = resolved.student;
      event.locals.sessionToken = token;
    } else {
      event.cookies.delete(SESSION_COOKIE_NAME, cookieDeletion(event.url, "/"));
    }
  }

  // Resolved independently of the student session: the two namespaces are
  // separate, and an educator signing in must not disturb a pupil's session on
  // the same machine (§7, §21).
  const educatorToken = event.cookies.get(EDUCATOR_SESSION_COOKIE_NAME);
  if (educatorToken) {
    const educator = resolveEducatorSession(db, educatorToken);
    if (educator) {
      event.locals.educator = educator;
    } else {
      event.cookies.delete(EDUCATOR_SESSION_COOKIE_NAME, cookieDeletion(event.url, "/"));
    }
  }

  return resolve(event);
};

/**
 * The first-run gate (PRD §6.2, §7, §21).
 *
 * Until setup completes, an installation has no operator account, no model alias
 * and no classroom: every other route is a form that cannot succeed or a panel
 * with nothing in it. So everything goes to the wizard, and the wizard is the
 * only thing that answers.
 *
 * The flag is completion, and only completion. Not "does an educator exist" —
 * the wizard creates one at its first step and has three steps left afterwards,
 * so the two conditions are not the same question and collapsing them would open
 * the gate halfway through.
 *
 * Placed after `handleSession` so `locals` is populated, and before
 * `handleLocale` so the wizard is localised like everything else. The flag is
 * put on `locals` for anything downstream that needs it, rather than re-queried
 * per component.
 *
 * Once setup is complete this hook is transparent, and `/setup`'s own `load`
 * answers `404` — not `403`, which would confirm the surface is there.
 */
const handleSetupGate: Handle = async ({ event, resolve }) => {
  const complete = isSetupComplete(getDb());
  event.locals.setupComplete = complete;

  if (!complete && !isSetupGateExempt(event.url.pathname)) redirect(303, SETUP_PATH);

  const response = await resolve(event);

  // Never cached and never indexed: the surface carries a one-time credential
  // field, and a proxy or a crawler has no business holding either (§21).
  if (event.url.pathname === SETUP_PATH || event.url.pathname.startsWith(`${SETUP_PATH}/`)) {
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-robots-tag", "noindex");
  }

  return response;
};

/**
 * Interface language (PRD §8, §18).
 *
 * "Interface language is a classroom setting… and each student may override it
 * for themselves… The educator panel follows the educator's own preference."
 *
 * So a signed-in pupil's locale comes from their record and their classroom, and
 * everyone else keeps whatever Paraglide would have resolved on its own. The
 * preference is delivered by rewriting the request's own locale cookie rather
 * than by a global override: `paraglideMiddleware` then resolves it through its
 * configured cookie strategy, per request, with nothing shared between
 * concurrent server renders.
 *
 * This runs after `handleSession` because it needs the resolved student.
 */
const handleLocale: Handle = ({ event, resolve }) => {
  const student = event.locals.student;
  const preferred = student ? studentInterfaceLanguage(getDb(), student) : null;

  const request = preferred ? withLocaleCookie(event.request, preferred) : event.request;

  /**
   * Tell the browser which locale won, whenever the pupil's preference differs
   * from the cookie it sent (PRD §8, §18).
   *
   * Rewriting the request cookie above settles the *server* render, and only
   * that. Paraglide's client reads the real `document.cookie`, so a browser
   * still carrying an older value re-resolves to it on hydration and swaps the
   * page back — the pupil sees `lang="da"` on a page rendered entirely in
   * English, and the classroom's language setting and their own override both
   * look inert while in fact both were applied. The default is `en`, so a
   * Danish classroom is the case that breaks.
   *
   * Not `HttpOnly`: Paraglide's client has to read it, which is the whole point.
   * It carries a locale and nothing else.
   */
  if (preferred && event.cookies.get(cookieName) !== preferred) {
    event.cookies.set(cookieName, preferred, localeCookieOptions(event.url));
  }

  /**
   * The rest of the request sees the localised request, never the original: the rebuilt
   * request above carries the body, so an action reading the original would find it consumed.
   * `RequestEvent` is read-only in SvelteKit 3, so the request travels in a copy of the event,
   * which is also what SvelteKit's own `sequence` hands from one handle to the next.
   */
  return paraglideMiddleware(request, ({ request: localised, locale }) =>
    resolve(
      { ...event, request: localised },
      {
        transformPageChunk: ({ html }) =>
          html
            .replace("%paraglide.lang%", locale)
            .replace("%paraglide.dir%", getTextDirection(locale)),
      },
    ),
  );
};

/**
 * A copy of the request whose locale cookie says `locale`.
 *
 * Headers on a `Request` are immutable, so the header is rebuilt rather than
 * mutated. Only the locale cookie is replaced; every other cookie — the session
 * cookies above among them — travels untouched.
 */
function withLocaleCookie(request: Request, locale: string): Request {
  const existing = request.headers.get("cookie") ?? "";
  const others = existing
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith(`${cookieName}=`));

  const headers = new Headers(request.headers);
  headers.set("cookie", [...others, `${cookieName}=${locale}`].join("; "));

  return new Request(request, { headers });
}

/**
 * One line per request, at `info` (PRD §16, §21).
 *
 * A pilot classroom running at the default level produced 1.4 KB of log across
 * thirty-nine completions, five concurrent pupils and three exhausted budgets:
 * five error blocks and the boot banner. Nothing said a request had been served,
 * refused, or how long it took, so an operator asking "is it working" had only
 * the absence of errors to go on, and an operator asking "why is it slow" had
 * nothing at all.
 *
 * §16 names what may be here — "internal identifiers, request identifiers, model
 * aliases, latency, status, and token counts" — and this carries only those.
 *
 * The *route id* rather than the URL, deliberately. A path is an internal
 * identifier and safe, but a query string is not: `/api/search?q=` carries what
 * a pupil typed, and a log line built from `url.pathname + url.search` would
 * write a pupil's search into the operator's terminal. Taking the matched route
 * makes that impossible rather than merely avoided.
 */
const handleRequestLog: Handle = async ({ event, resolve }) => {
  const startedAt = performance.now();
  const response = await resolve(event);

  log.info({
    event: "request",
    method: event.request.method,
    // Null for a request that matched no route — a 404, which is worth seeing.
    route: event.route.id,
    status: response.status,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return response;
};

// Outermost, so it sees the response every later hook produced.
export const handle: Handle = sequence(
  handleSecurityHeaders,
  handleRequestLog,
  handleRequestOrigin,
  handleSession,
  handleSetupGate,
  handleLocale,
);

/** What an unexpected failure tells the browser and the log; see `$lib/server/errors`. */
export const handleError = createHandleError();
