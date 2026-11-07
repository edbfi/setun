import { error, fail as kitFail, redirect } from "@sveltejs/kit";
import { fail, superValidate } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import * as v from "valibot";
import { BUDGET_PRESETS, budgetsOf, matchPreset } from "$lib/server/agent/budgets";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { getDb, getFileStore } from "$lib/server/boot";
import { resolveRoster } from "$lib/server/classroom/roster";
import {
  AliasIdSchema,
  AllowAliasSchema,
  AllowToolSchema,
  ApplyPresetSchema,
  BudgetsSchema,
  blankToNull,
  ClassroomPolicySchema,
  GrantSkillSchema,
  ScheduleSchema,
  SkillStateSchema,
  TemporaryWindowsSchema,
  ToolPolicySchema,
} from "$lib/server/classroom/schemas";
import { classroomStateChannel } from "$lib/server/classroom/state-channel";
import { classroomDeletionScope, purgeClassroom } from "$lib/server/classroom/students";
import {
  allowAlias,
  disallowAlias,
  listAllowedAliasIds,
} from "$lib/server/db/queries/classroom-aliases";
import { getClassroom, updateClassroomSettings } from "$lib/server/db/queries/classrooms";
import {
  allowTool,
  disallowTool,
  listAllowedToolIds,
  listMcpServers,
  listMcpTools,
} from "$lib/server/db/queries/mcp";
import { listAliases } from "$lib/server/db/queries/model-aliases";
import { invalidateClassroomSessions } from "$lib/server/db/queries/sessions";
import {
  grantSkill,
  listLibrarySkills,
  listSkillGrants,
  listStudentSkillsForClassroom,
  revokeSkill,
  updateSkill,
} from "$lib/server/db/queries/skills";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Everything an educator configures about one classroom (PRD §8, §9, §10, §11,
 * §12, §16, §17).
 *
 * §17's classroom configuration in one place: schedule, temporary windows, model
 * allowlist with the no-DPA confirmation, tool permission mode, skill authoring
 * policy, attachment policy, classroom instructions, session policy, interface
 * language, retention, and budgets.
 *
 * Thin by §6.1 throughout: every action authorises, validates through a Valibot
 * schema, and delegates. The one thing this file decides for itself is *when*
 * connected tabs are told — every write that changes what a pupil may do
 * publishes on the classroom-state channel (§8).
 */

const budgetsAdapter = valibot(BudgetsSchema);
const policyAdapter = valibot(ClassroomPolicySchema);
const toolPolicyAdapter = valibot(ToolPolicySchema);
const scheduleAdapter = valibot(ScheduleSchema);
const temporaryAdapter = valibot(TemporaryWindowsSchema);

/** Every write here is scoped to a classroom that exists; a stale link is a 404. */
function classroomFor(classroomId: string) {
  const classroom = getClassroom(getDb(), classroomId);
  if (!classroom) error(404, "Not found");
  return classroom;
}

export const load: PageServerLoad = async ({ params }) => {
  const db = getDb();
  const classroom = classroomFor(params.classroomId);
  const allowed = new Set(listAllowedAliasIds(db, classroom.id));
  const allowedTools = new Set(listAllowedToolIds(db, classroom.id));
  const grants = listSkillGrants(db, classroom.id);

  return {
    aliases: listAliases(db).map((alias) => ({
      id: alias.id,
      name: alias.name,
      available: alias.available,
      dataProtection: alias.dataProtection,
      allowed: allowed.has(alias.id),
    })),
    // Labels only, so a skill can be offered to one pupil by name (§12). Account
    // state and counters — never anything a pupil wrote (§16).
    students: resolveRoster(db, classroom),
    // Which of the configured servers' tools this class may use (§11). The
    // global enablement and the sensitive flag live on the tools page; what is
    // chosen here is the per-classroom subset.
    toolServers: listMcpServers(db)
      .map((server) => ({
        id: server.id,
        label: server.label,
        enabled: server.enabled,
        tools: listMcpTools(db, server.id).map((tool) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          enabled: tool.enabled,
          sensitive: tool.sensitive,
          allowed: allowedTools.has(tool.id),
        })),
      }))
      .filter((server) => server.tools.length > 0),
    // Library skills, with who they are offered to in this class (§12).
    skills: listLibrarySkills(db).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      origin: skill.origin,
      enabled: skill.enabled,
      classWide: grants.some((grant) => grant.skillId === skill.id && grant.studentId === null),
      studentIds: grants
        .filter((grant) => grant.skillId === skill.id && grant.studentId !== null)
        .map((grant) => grant.studentId as string),
    })),
    // Every pupil-written skill in the class — the oversight list of §12. The
    // body is included because "view" is one of the three actions §12 names.
    studentSkills: listStudentSkillsForClassroom(db, classroom.id).map((row) => ({
      id: row.skill.id,
      name: row.skill.name,
      description: row.skill.description,
      body: row.skill.body,
      enabled: row.skill.enabled,
      approvalState: row.skill.approvalState,
      studentLabel: row.studentLabel,
    })),
    // Seeded field by field rather than from the whole row: the form's shape is
    // the schema's, and a row that grows a column should not silently start
    // feeding it.
    budgetsForm: await superValidate(
      {
        perTurnStepCap: classroom.perTurnStepCap,
        perTurnWallClockSeconds: classroom.perTurnWallClockSeconds,
        perTurnTokenCap: classroom.perTurnTokenCap,
        perStudentDailyTokens: classroom.perStudentDailyTokens,
        perClassroomDailyTokens: classroom.perClassroomDailyTokens,
        costExchangeRate: classroom.costExchangeRate,
      },
      budgetsAdapter,
      { id: "budgets" },
    ),
    // Which preset (if any) the current budgets match, so the preset picker can
    // show it instead of always defaulting to the first option. A preset is
    // never stored (see BUDGET_PRESETS), so it is derived by comparison; a
    // hand-edit yields null, which the picker renders as "Custom".
    activePreset: matchPreset(budgetsOf(classroom)),
    // Counts only, so the deletion confirmation can say what it takes with it.
    // Nothing a pupil wrote reaches the panel (§16).
    deletionScope: classroomDeletionScope(db, classroom.id),
    policyForm: await superValidate(
      {
        classroomInstructions: classroom.classroomInstructions ?? "",
        interfaceLanguage: classroom.interfaceLanguage,
        thinkingVisibility: classroom.thinkingVisibility,
        doneSound: classroom.doneSound,
        maxConcurrentTurns: classroom.maxConcurrentTurns,
        sessionPolicy: classroom.sessionPolicy,
        sessionSlidingDays: classroom.sessionSlidingDays,
        conversationRetentionDays: classroom.conversationRetentionDays,
        creationRetentionDays: classroom.creationRetentionDays,
      },
      policyAdapter,
      { id: "policy" },
    ),
    toolPolicyForm: await superValidate(
      {
        permissionMode: classroom.permissionMode,
        skillAuthoringPolicy: classroom.skillAuthoringPolicy,
        attachmentsEnabled: classroom.attachmentsEnabled,
        attachmentTypes: classroom.attachmentTypes,
        attachmentImageMaxBytes: classroom.attachmentImageMaxBytes,
        attachmentTextMaxBytes: classroom.attachmentTextMaxBytes,
        attachmentMaxPerMessage: classroom.attachmentMaxPerMessage,
        imageTokenEquivalent: classroom.imageTokenEquivalent,
        documentsEnabled: classroom.documentsEnabled,
      },
      toolPolicyAdapter,
      { id: "tool-policy" },
    ),
    scheduleForm: await superValidate(
      { weeklySchedule: classroom.weeklySchedule },
      scheduleAdapter,
      { id: "schedule" },
    ),
    temporaryForm: await superValidate(
      { temporaryWindows: classroom.temporaryWindows },
      temporaryAdapter,
      { id: "temporary" },
    ),
  };
};

export const actions: Actions = {
  saveSchedule: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const form = await superValidate(request, scheduleAdapter, { id: "schedule" });
    if (!form.valid) return fail(400, { form });

    updateClassroomSettings(getDb(), {
      classroomId: classroom.id,
      settings: { weeklySchedule: form.data.weeklySchedule },
    });

    classroomStateChannel.publish(classroom.id);
    return { form };
  },

  saveTemporaryWindows: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const form = await superValidate(request, temporaryAdapter, { id: "temporary" });
    if (!form.valid) return fail(400, { form });

    updateClassroomSettings(getDb(), {
      classroomId: classroom.id,
      settings: {
        temporaryWindows: form.data.temporaryWindows.map((window) => ({
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          ...(window.note ? { note: window.note } : {}),
        })),
      },
    });

    classroomStateChannel.publish(classroom.id);
    return { form };
  },

  saveBudgets: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const form = await superValidate(request, budgetsAdapter, { id: "budgets" });
    if (!form.valid) return fail(400, { form });

    updateClassroomSettings(getDb(), { classroomId: classroom.id, settings: form.data });

    classroomStateChannel.publish(classroom.id);
    return { form };
  },

  /**
   * Fill the five budget fields from a preset (§10, Appendix A).
   *
   * "Selecting a preset fills all five fields; fields remain individually
   * editable afterwards" — so this writes the values and leaves, rather than
   * recording which preset was chosen. A classroom is never in a preset mode.
   */
  applyPreset: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(ApplyPresetSchema, { preset: body.get("preset") });
    if (!parsed.success) return kitFail(400, { invalid: true });

    updateClassroomSettings(getDb(), {
      classroomId: classroom.id,
      settings: BUDGET_PRESETS[parsed.output.preset],
    });

    classroomStateChannel.publish(classroom.id);
    return { saved: true };
  },

  savePolicy: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const form = await superValidate(request, policyAdapter, { id: "policy" });
    if (!form.valid) return fail(400, { form });

    updateClassroomSettings(getDb(), {
      classroomId: classroom.id,
      settings: {
        ...form.data,
        // An empty textarea is an absent layer, not an instruction with no
        // content — the prompt builder must not emit a heading for it (§10).
        classroomInstructions: blankToNull(form.data.classroomInstructions),
      },
    });
    return { form };
  },

  /** Tools, skills, attachments, image generation and documents, in one block (§11, §12, §15). */
  saveToolPolicy: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const form = await superValidate(request, toolPolicyAdapter, { id: "tool-policy" });
    if (!form.valid) return fail(400, { form });

    updateClassroomSettings(getDb(), { classroomId: classroom.id, settings: form.data });

    // Attachments and the permission mode change what a pupil may do right now.
    classroomStateChannel.publish(classroom.id);
    return { form };
  },

  /** Select one configured tool for this classroom (§11). */
  allowTool: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(AllowToolSchema, { mcpToolId: body.get("mcpToolId") });
    if (!parsed.success) return kitFail(400, { invalid: true });

    allowTool(getDb(), { classroomId: classroom.id, mcpToolId: parsed.output.mcpToolId });
    return { saved: true };
  },

  disallowTool: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(AllowToolSchema, { mcpToolId: body.get("mcpToolId") });
    if (!parsed.success) return kitFail(400, { invalid: true });

    disallowTool(getDb(), { classroomId: classroom.id, mcpToolId: parsed.output.mcpToolId });
    return { saved: true };
  },

  /**
   * Offer a library skill to the class, or to one pupil (§12).
   *
   * "Enablement is per classroom and per student — a skill can be offered to a
   * whole class or to individual students", which is one row either way.
   */
  grantSkill: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(GrantSkillSchema, {
      skillId: body.get("skillId"),
      studentId: body.get("studentId") ?? "",
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    grantSkill(getDb(), {
      classroomId: classroom.id,
      skillId: parsed.output.skillId,
      studentId: parsed.output.studentId,
    });
    return { saved: true };
  },

  revokeSkill: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(GrantSkillSchema, {
      skillId: body.get("skillId"),
      studentId: body.get("studentId") ?? "",
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    revokeSkill(getDb(), {
      classroomId: classroom.id,
      skillId: parsed.output.skillId,
      studentId: parsed.output.studentId,
    });
    return { saved: true };
  },

  /**
   * Oversight of a pupil's own skill: disable it, or approve a pending one (§12).
   *
   * The immediate-with-oversight default gives the panel "view, disable and
   * delete"; the pre-approval policy adds the approval this action performs.
   */
  setStudentSkillState: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(SkillStateSchema, {
      skillId: body.get("skillId"),
      enabled: body.get("enabled") ?? undefined,
      approvalState: body.get("approvalState") ?? undefined,
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    // Scoped to this classroom's own pupils: an educator page must not be a way
    // to reach a skill belonging to another class (§21).
    const owned = listStudentSkillsForClassroom(getDb(), classroom.id).some(
      (row) => row.skill.id === parsed.output.skillId,
    );
    if (!owned) return kitFail(404, { invalid: true });

    updateSkill(getDb(), {
      skillId: parsed.output.skillId,
      ...(parsed.output.enabled === undefined ? {} : { enabled: parsed.output.enabled === "true" }),
      ...(parsed.output.approvalState === undefined
        ? {}
        : { approvalState: parsed.output.approvalState }),
    });
    return { saved: true };
  },

  /**
   * Allowlist an alias for this classroom (§8, §9, §16).
   *
   * An alias without a data processing agreement requires the educator's
   * explicit confirmation, and the server refuses without it: §16 asks that the
   * decision be made deliberately by the person accountable, which a dialog the
   * client could skip would not achieve. The confirmation is recorded, not just
   * demanded.
   */
  allowAlias: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(AllowAliasSchema, {
      modelAliasId: body.get("modelAliasId"),
      confirmNoDpa: body.get("confirmNoDpa") ?? undefined,
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    const alias = listAliases(getDb()).find((row) => row.id === parsed.output.modelAliasId);
    if (!alias) return kitFail(404, { invalid: true });

    if (!alias.dataProtection && !parsed.output.confirmNoDpa) {
      return kitFail(400, { needsNoDpaConfirmation: true, modelAliasId: alias.id });
    }

    allowAlias(getDb(), {
      classroomId: classroom.id,
      modelAliasId: alias.id,
      noDpaConfirmedAt: alias.dataProtection ? null : new Date(),
    });

    classroomStateChannel.publish(classroom.id);
    return { saved: true };
  },

  /** Bulk session invalidation, immediate (§7, §21). */
  forceLogout: async ({ params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    return { forceLoggedOut: invalidateClassroomSessions(getDb(), classroom.id) };
  },

  /**
   * Permanent deletion of the whole classroom (§16).
   *
   * The container of everything the roster's per-pupil deletion removes, and
   * until now the one thing the panel could not remove at all: a room set up by
   * mistake, or one whose year has ended, stayed on the dashboard for good.
   *
   * The same friction the pupil deletion uses — the educator retypes the name —
   * because the same thing is true of it and more so: nothing here is
   * recoverable, and this is every pupil in the room at once. The confirmation
   * is told the counts first, so "delete the class" is a decision made knowing
   * what it takes with it.
   *
   * Redirects to the dashboard: the page this action was submitted from no
   * longer describes anything.
   */
  deleteClassroom: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const confirmName = body.get("confirmName");
    if (typeof confirmName !== "string" || confirmName.trim() !== classroom.name) {
      return kitFail(400, { confirmMismatch: true });
    }

    await purgeClassroom(getDb(), getFileStore(), classroom.id);

    // Every tab watching this room is told it is gone; the status resolver
    // reports an absent classroom as closed, so a pupil mid-lesson is refused
    // rather than left waiting on a room that no longer exists (§6, §8).
    classroomStateChannel.publish(classroom.id);
    redirect(303, "/educator");
  },

  disallowAlias: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(AliasIdSchema, { modelAliasId: body.get("modelAliasId") });
    if (!parsed.success) return kitFail(400, { invalid: true });

    disallowAlias(getDb(), { classroomId: classroom.id, modelAliasId: parsed.output.modelAliasId });

    classroomStateChannel.publish(classroom.id);
    return { saved: true };
  },
};
