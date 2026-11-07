import { fail } from "@sveltejs/kit";
import * as v from "valibot";
import { requireStudentPage } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { resolveClassroomStatus } from "$lib/server/classroom/status";
import { listStudentArtifacts } from "$lib/server/db/queries/artifacts";
import { getClassroom } from "$lib/server/db/queries/classrooms";
import { listConversations } from "$lib/server/db/queries/conversations";
import { listStudentDocuments } from "$lib/server/db/queries/documents";
import { listStudentImages } from "$lib/server/db/queries/images";
import { listStudentSkills } from "$lib/server/db/queries/skills";
import {
  setStudentDisplayName,
  setStudentInterfaceLanguage,
} from "$lib/server/db/queries/students";
import { INTERFACE_LANGUAGES } from "$lib/server/db/schema";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The student's dashboard (PRD §16, §18).
 *
 * "Deliberately thin: account status, classroom open or closed with the next
 * window, daily allowance used (with the approximate cost where prices are
 * configured), an interface-language override, the optional display name (set,
 * changed, or cleared here), conversation list with search, creations gallery,
 * and the student's own skills."
 *
 * "Its purpose is partly transparency — everything the system knows about a
 * student is visible to that student, and none of it is their real name." So the
 * shape below is the whole record as the pupil may see it: a pseudonymous label,
 * a nickname they chose, counters, and their own work. There is no field here
 * they did not create or that was not generated for them.
 *
 * Thin by §6.1: authorise, delegate to owner-scoped queries, shape the response.
 */

const LanguageSchema = v.object({
  /** Empty hands the choice back to the classroom, which is what an override is (§8). */
  language: v.union([v.literal(""), v.picklist(INTERFACE_LANGUAGES)]),
});

const DisplayNameSchema = v.object({
  displayName: v.pipe(v.string(), v.trim(), v.maxLength(40)),
});

// TODO(phase-7): the dashboard is the second anchor for the student first-login
// introduction — a pupil who skipped it, or who arrived here directly, needs a
// way back to it. Whether it re-runs after a credential rotation, and whether it
// is skippable at all, are open questions recorded in
// `docs/setun-student-onboarding.md`; the typed shape is in
// `$lib/server/student/onboarding`.
export const load: PageServerLoad = ({ locals }) => {
  const student = requireStudentPage(locals);
  const db = getDb();
  const classroom = getClassroom(db, student.classroomId);

  return {
    student: {
      label: student.label,
      displayName: student.displayName,
      status: student.status,
      interfaceLanguage: student.interfaceLanguage,
      createdAt: student.createdAt.toISOString(),
      /** The non-secret tail of the code, so a pupil can match their own card (§7). */
      credentialHint: student.credentialHint,
    },
    classroomName: classroom?.name ?? null,
    status: resolveClassroomStatus(db, student),
    conversations: listConversations(db, student.id).map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt.toISOString(),
    })),
    // Counts rather than the gallery itself: the gallery is its own route, and
    // §18 asks this page to be thin.
    creations: {
      artifacts: listStudentArtifacts(db, student.id).length,
      images: listStudentImages(db, student.id).length,
      documents: listStudentDocuments(db, student.id).length,
    },
    skills: listStudentSkills(db, student.id).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      approvalState: skill.approvalState,
    })),
  };
};

export const actions: Actions = {
  /** Override the classroom's interface language for this pupil alone (§8, §18). */
  language: async ({ request, locals }) => {
    const student = requireStudentPage(locals);

    const parsed = v.safeParse(LanguageSchema, {
      language: (await request.formData()).get("language") ?? "",
    });
    if (!parsed.success) return fail(400, { invalid: true });

    setStudentInterfaceLanguage(getDb(), {
      studentId: student.id,
      interfaceLanguage: parsed.output.language === "" ? null : parsed.output.language,
    });

    return { saved: true };
  },

  /**
   * The optional display name, set, changed or cleared here (§16, §18).
   *
   * Blank clears it. "Optional display names are exactly that" — no identity
   * follows from one, and nothing asks for a real name.
   */
  displayName: async ({ request, locals }) => {
    const student = requireStudentPage(locals);

    const parsed = v.safeParse(DisplayNameSchema, {
      displayName: (await request.formData()).get("displayName") ?? "",
    });
    if (!parsed.success) return fail(400, { invalid: true });

    setStudentDisplayName(getDb(), {
      studentId: student.id,
      displayName: parsed.output.displayName === "" ? null : parsed.output.displayName,
    });

    return { saved: true };
  },
};
