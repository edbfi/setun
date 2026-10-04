import { fail, redirect } from "@sveltejs/kit";
import * as v from "valibot";
import { attemptEducatorSignIn } from "$lib/server/auth/educator";
import { EDUCATOR_SESSION_COOKIE_NAME, EDUCATOR_SESSION_TTL_DAYS } from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";
import { secureCookie } from "$lib/server/cookies";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Educator sign-in (PRD §7).
 *
 * A trivial form, so a plain progressively-enhanced action rather than
 * Superforms (§5) — but still Valibot-validated, because every action validates
 * through a schema without exception (§5).
 *
 * There is exactly one failure branch, and it is reached identically by an
 * unknown username, a wrong password and a malformed submission: the decision
 * and its timing floor both live in `$lib/server/auth/educator`, so nothing here
 * can leak which of the three happened (§7, §21).
 */

const LoginSchema = v.object({
  username: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

export const load: PageServerLoad = ({ locals }) => {
  if (locals.educator) redirect(303, "/educator");
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    const form = await request.formData();
    const parsed = v.safeParse(LoginSchema, {
      username: form.get("username"),
      password: form.get("password"),
    });

    if (!parsed.success) return fail(400, { failed: true });

    // Throttling and the timing floor live in the sign-in decision; the route
    // stays thin. It is keyed on the username alone (§7), so no client address
    // is needed here.
    const result = await attemptEducatorSignIn(getDb(), parsed.output);
    if (!result.ok) return fail(401, { failed: true });

    cookies.set(EDUCATOR_SESSION_COOKIE_NAME, result.session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Host-only: the sandbox origin is a different host and can never read it
      // (§7, §14, §21).
      secure: secureCookie(url),
      maxAge: EDUCATOR_SESSION_TTL_DAYS * 24 * 60 * 60,
    });

    redirect(303, "/educator");
  },
};
