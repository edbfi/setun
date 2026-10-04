import { fail, redirect } from "@sveltejs/kit";
import * as v from "valibot";
import { attemptStudentLogin } from "$lib/server/auth/login";
import { SESSION_COOKIE_NAME, STUDENT_SESSION_TTL_DAYS } from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";
import { getConfig } from "$lib/server/config";
import { secureCookie } from "$lib/server/cookies";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Student login (PRD §7).
 *
 * A trivial form, so a plain progressively-enhanced action rather than Superforms
 * (§5) — but still Valibot-validated, because every action validates through a
 * schema without exception (§5).
 *
 * The route is thin by design: it parses, delegates the decision to
 * `$lib/server/auth`, and shapes the response. Every *credential* failure is one
 * branch, so there is nothing for the response to disclose about whether a code
 * exists (§7, §21); a refused address is reported separately, because it says
 * nothing about a code and a pupil can act on it.
 */

/** Length is unbounded on purpose: normalisation strips separators before the check. */
const LoginSchema = v.object({
  code: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

export const load: PageServerLoad = ({ locals, url }) => {
  // Already signed in: nothing to do here.
  if (locals.student) redirect(303, "/chat");
  return { noScriptFragmentCleanup: url.searchParams.get("manual") !== "1" };
};

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress, url }) => {
    const form = await request.formData();
    const parsed = v.safeParse(LoginSchema, { code: form.get("code") });

    if (!parsed.success) {
      // Same shape as a rejected code: a malformed submission must not be
      // distinguishable from a wrong one (§7).
      return fail(400, { failed: true, rateLimited: false });
    }

    const result = await attemptStudentLogin(getDb(), {
      code: parsed.output.code,
      ip: getClientAddress(),
      pepper: getConfig().studentCodePepper,
    });

    if (!result.ok) {
      // Two branches, and only two: every credential outcome is one message, and
      // an exhausted per-IP budget is the other. The second says nothing about
      // any code — it is a property of the network the class shares — and saying
      // "that code did not work" instead sent a pupil looking for a typo in a
      // code that was correct (§7, §21).
      const rateLimited = result.failure === "rate-limited";
      return fail(rateLimited ? 429 : 401, { failed: true, rateLimited });
    }

    // TODO(phase-7): the student first-login introduction begins here — this is
    // the one path that knows a sign-in *just succeeded*, which is what
    // distinguishes "has never seen it" from "is signed in and browsing". The
    // decision (and the redirect target) belongs in
    // `$lib/server/student/onboarding`; `docs/setun-student-onboarding.md` has
    // the intended flow and the open questions. Nothing is wired up yet, and
    // students land on /chat exactly as before.
    cookies.set(SESSION_COOKIE_NAME, result.session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Host-only and scoped to this path: the sandbox origin is a different
      // host and can never read it (§7, §14, §21).
      secure: secureCookie(url),
      maxAge: STUDENT_SESSION_TTL_DAYS * 24 * 60 * 60,
    });

    redirect(303, "/chat");
  },
};
