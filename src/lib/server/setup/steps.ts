import type * as v from "valibot";
import { forgetAlias } from "../agent/context-window";
import { establishEducator } from "../auth/educator";
import { type ProvisionedStudent, provisionStudents } from "../auth/provisioning";
import { createSession, type IssuedSession } from "../auth/sessions";
import type { AliasSchema } from "../classroom/schemas";
import type { AppDatabase } from "../db/client";
import { allowAlias } from "../db/queries/classroom-aliases";
import { createClassroom, updateClassroomSettings } from "../db/queries/classrooms";
import { getFirstEducator } from "../db/queries/educators";
import { completeSetup, ensureInstance } from "../db/queries/instance";
import { createAlias, designateUtilityAlias, updateAlias } from "../db/queries/model-aliases";
import type { Classroom, Educator, ModelAlias } from "../db/schema";
import { log } from "../logging";
import type { SetupClassroomSchema } from "./schemas";
import { canFinishSetup, resolveSetupProgress, type SetupProgress } from "./state";

/**
 * What each wizard step actually writes (PRD §6.2, §7, §8, §9).
 *
 * The route above this parses, authorises and shapes a response; the decisions
 * live here, so a step's behaviour can be tested without a request.
 *
 * Every function is idempotent against its own step's derivation predicate. That
 * is the property that makes back-navigation safe: the alias step updates the
 * alias the derivation found rather than inserting a second one, and the same
 * for the classroom. Provisioning is the exception by nature — a second batch is
 * a second batch, and the UI says so rather than pretending otherwise.
 *
 * Nothing here writes `setupCompletedAt` except `finishSetup`. Opening the gate
 * from a step that has three steps after it would hand the educator a panel that
 * cannot serve a lesson.
 */

export interface SetupEducatorInput {
  readonly username: string;
  readonly password: string;
  /**
   * Re-asserts the caller's claim after the password hash, immediately before
   * the row is written. Null comes back when it no longer holds.
   */
  readonly stillAuthorised?: () => boolean;
}

/**
 * Step 1. Skipped entirely when the account comes from deployment configuration.
 *
 * Null when `stillAuthorised` refused: the claim moved to another browser while
 * this request was hashing, and a revoked browser must not rewrite the operator
 * credential (§7, §21).
 */
export async function saveEducator(
  db: AppDatabase,
  input: SetupEducatorInput,
): Promise<Educator | null> {
  const existed = getFirstEducator(db) !== undefined;
  const educator = await establishEducator(db, input);
  if (!educator) return null;

  // The operator's record that onboarding happened, and when. Identifiers and
  // outcome only: no password, no hash (§16, §21).
  log.info(
    existed
      ? `setup: operator account '${educator.username}' updated`
      : `setup: operator account '${educator.username}' created`,
  );

  return educator;
}

export type SetupAliasInput = v.InferOutput<typeof AliasSchema>;

/**
 * Step 3. The first model alias, always designated the utility alias (§9, §10).
 *
 * "One alias is designated the utility alias, used for internal work such as
 * title generation." On a fresh installation there is exactly one alias, so it
 * is that one — and leaving the designation to a later visit to the panel would
 * mean the first conversation a pupil starts has no model to name itself with.
 */
export function saveAlias(
  db: AppDatabase,
  input: { progress: SetupProgress; values: SetupAliasInput },
): ModelAlias {
  const values = { ...input.values, isUtility: false };

  // A re-saved alias may name another model: nothing learned about the old one holds.
  if (input.progress.aliasId) forgetAlias(input.progress.aliasId);
  const alias = input.progress.aliasId
    ? updateAlias(db, { aliasId: input.progress.aliasId, values })
    : createAlias(db, values);

  if (!alias) throw new Error("the setup alias could not be written");

  designateUtilityAlias(db, alias.id);
  return alias;
}

export type SetupClassroomInput = v.InferOutput<typeof SetupClassroomSchema>;

export type SaveClassroomResult =
  | { readonly ok: true; readonly classroom: Classroom }
  /**
   * §16: "enabling a no-DPA alias for a classroom requires an explicit
   * confirmation". The server refuses without it — a dialog the client could
   * skip would not be the deliberate decision §16 asks for.
   */
  | { readonly ok: false; readonly reason: "no_dpa_unconfirmed" }
  | { readonly ok: false; readonly reason: "alias_missing" };

/**
 * Step 4. The first classroom, with the step-3 alias allowlisted for it (§8, §9).
 *
 * The allowlist grant is part of the step rather than a later chore: a classroom
 * with no allowlisted alias refuses every request, which is correct behaviour
 * and a baffling first lesson.
 */
export function saveClassroom(
  db: AppDatabase,
  input: {
    progress: SetupProgress;
    alias: ModelAlias | undefined;
    values: SetupClassroomInput;
  },
): SaveClassroomResult {
  if (!input.alias) return { ok: false, reason: "alias_missing" };
  if (!input.alias.dataProtection && !input.values.confirmNoDpa) {
    return { ok: false, reason: "no_dpa_unconfirmed" };
  }

  const settings = {
    name: input.values.name,
    timezone: input.values.timezone,
    interfaceLanguage: input.values.interfaceLanguage,
    sessionPolicy: input.values.sessionPolicy,
    sessionSlidingDays: input.values.sessionSlidingDays,
  };

  const classroomId =
    input.progress.classroomId ??
    createClassroom(db, { name: settings.name, timezone: settings.timezone }).id;

  const classroom = updateClassroomSettings(db, { classroomId, settings });
  if (!classroom) return { ok: false, reason: "alias_missing" };

  allowAlias(db, {
    classroomId: classroom.id,
    modelAliasId: input.alias.id,
    noDpaConfirmedAt: input.alias.dataProtection ? null : new Date(),
  });

  return { ok: true, classroom };
}

/**
 * Step 5. A first batch of pseudonymous accounts, through the panel's own path.
 *
 * The codes come back once, for the cards, and are never stored (§7).
 */
export function provisionFirstStudents(
  db: AppDatabase,
  input: {
    classroom: Classroom;
    pepper: string;
    count: number;
    /** Re-asserts the caller's claim after the codes are hashed and before the
     * batch is written; an empty array comes back when it no longer holds. */
    stillAuthorised?: () => boolean;
  },
): Promise<ProvisionedStudent[]> {
  return provisionStudents(db, {
    classroomId: input.classroom.id,
    pepper: input.pepper,
    count: input.count,
    stillAuthorised: input.stillAuthorised,
    // "Speakable in class" depends on the language spoken there (§17).
    locale: input.classroom.interfaceLanguage,
  });
}

export type FinishSetupResult =
  | { readonly ok: true; readonly educator: Educator; readonly session: IssuedSession }
  | { readonly ok: false; readonly reason: "incomplete" };

/**
 * Finish: mark setup complete and hand the operator a session (§6.2, §7, §21).
 *
 * The prerequisites are re-checked here rather than trusted from the screen that
 * offered the button — the button is a suggestion, the check is the rule.
 *
 * The session is minted here but the *cookie* work belongs to the route, which
 * deletes any session cookie the browser arrived with before setting this one.
 * That ordering is the session-fixation defence, and it mirrors what the educator
 * login route does for the same reason.
 */
export function finishSetup(
  db: AppDatabase,
  input: { educatorSeeded: boolean; now?: Date },
): FinishSetupResult {
  const progress = resolveSetupProgress(db, { educatorSeeded: input.educatorSeeded });
  if (!canFinishSetup(progress)) return { ok: false, reason: "incomplete" };

  const educator = getFirstEducator(db);
  if (!educator) return { ok: false, reason: "incomplete" };

  const now = input.now ?? new Date();

  // The claim will already have created the row, but this function's
  // correctness should not depend on the order two other functions ran in.
  ensureInstance(db);
  completeSetup(db, now);
  log.info(`setup: completed for operator '${educator.username}'`);

  return {
    ok: true,
    educator,
    session: createSession(db, { ownerKind: "educator", ownerId: educator.id, now }),
  };
}
