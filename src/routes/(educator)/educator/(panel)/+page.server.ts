import { redirect } from "@sveltejs/kit";
import { fail, superValidate } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import * as v from "valibot";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { destroySession, EDUCATOR_SESSION_COOKIE_NAME } from "$lib/server/auth/sessions";
import { getDb, getGatewayAdapter } from "$lib/server/boot";
import { resolveDashboard } from "$lib/server/classroom/overview";
import { resolveOpenUntil } from "$lib/server/classroom/schedule";
import { CreateClassroomSchema, LockClassroomSchema } from "$lib/server/classroom/schemas";
import { classroomStateChannel } from "$lib/server/classroom/state-channel";
import { cookieDeletion } from "$lib/server/cookies";
import {
  createClassroom,
  getClassroom,
  setClassroomState,
} from "$lib/server/db/queries/classrooms";
import { checkGatewayHealth } from "$lib/server/gateway/health";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The panel's dashboard (PRD §9, §17).
 *
 * "Dashboard: classroom state, active students, gateway health, current window,
 * usage against budgets and caps, and a one-click lock." Every classroom on one
 * screen, because an educator with two lessons in a day has two rooms and needs
 * to see both without choosing one first.
 *
 * The gateway line says exactly two things — answering or not, and how many
 * models — because that is all an educator can act on, and everything else would
 * be infrastructure detail (§9, §21).
 *
 * Thin by §6.1: authorise, validate, delegate, redirect. Every action re-checks
 * the educator role; the layout's load does not run before an action (§21).
 */

const adapter = valibot(CreateClassroomSchema);

export const load: PageServerLoad = async () => ({
  form: await superValidate(adapter),
  dashboard: resolveDashboard(getDb()),
  gateway: await checkGatewayHealth(getGatewayAdapter()),
});

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const form = await superValidate(request, adapter);
    if (!form.valid) return fail(400, { form });

    const classroom = createClassroom(getDb(), form.data);
    redirect(303, `/educator/classrooms/${classroom.id}`);
  },

  /**
   * The dashboard's one-click lock, and its counterpart (§8, §17).
   *
   * The same write the classroom page performs, reachable without leaving the
   * overview: a lesson ends where the educator is standing, not where the URL
   * happens to be.
   */
  setState: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const body = await request.formData();
    const parsed = v.safeParse(LockClassroomSchema, {
      classroomId: body.get("classroomId"),
      state: body.get("state"),
    });
    if (!parsed.success) return fail(400, { invalid: true });

    const classroom = getClassroom(getDb(), parsed.output.classroomId);
    if (!classroom) return fail(404, { invalid: true });

    const now = new Date();
    setClassroomState(getDb(), {
      classroomId: classroom.id,
      state: parsed.output.state,
      // From here an Open now runs to the end of the current window, which is
      // what "one click" can mean without a duration control (§8).
      until: parsed.output.state === "open" ? resolveOpenUntil(classroom, "window", now) : null,
      now,
    });

    classroomStateChannel.publish(classroom.id);
    return { saved: true };
  },

  logout: async ({ cookies, url }) => {
    const token = cookies.get(EDUCATOR_SESSION_COOKIE_NAME);
    if (token) destroySession(getDb(), token);
    cookies.delete(EDUCATOR_SESSION_COOKIE_NAME, cookieDeletion(url, "/"));

    redirect(303, "/educator/login");
  },
};
