import type { HandleServerError } from "@sveltejs/kit/hooks";
import { describeCause, log } from "./logging";

/**
 * What an unexpected failure tells the browser, and what it tells the log
 * (PRD §16, §21). `hooks.server.ts` exports the result as `handleError`.
 *
 * "Production errors expose no stack traces or infrastructure detail" (§21), and
 * `App.Error` is `{ message: string }` (plus the `status` SvelteKit 3 always adds)
 * for exactly that reason: the shape has no field a detail could travel in even by
 * accident.
 *
 * SvelteKit 3 sends every error here, tagged by `kind`. Expected outcomes are not
 * faults and do not deserve an operator line each, so their safe bodies pass through
 * unchanged: `app` (an `error()` a route threw: a 404, a guard's refusal),
 * `framework` (SvelteKit's own 404, 405, 413 and the like) and `validation`.
 *
 * Only `unknown` is a fault. The operator side gets the route, the method and one
 * redacted line describing the failure — never a stack, and never a body, which on
 * this application would be somebody's prompt (§16).
 *
 * The reporter is a parameter so a test can watch what is logged.
 */
export function createHandleError(
  report: (...parts: unknown[]) => void = log.error,
): HandleServerError {
  return ({ kind, error, event }) => {
    if (kind !== "unknown") return error;

    report("request failed", {
      route: event.route.id,
      method: event.request.method,
      cause: describeCause(error),
    });

    // Deliberately not the caught error's message, and spelled out rather than left
    // to SvelteKit's default, so a future change upstream cannot start leaking
    // through this hook.
    return { message: "Internal Error" };
  };
}
