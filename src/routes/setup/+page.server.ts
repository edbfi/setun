import type { Cookies } from "@sveltejs/kit";
import { error, fail as kitFail, redirect } from "@sveltejs/kit";
import { fail, setError, superValidate } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import * as v from "valibot";
import type { CredentialCard } from "$lib/credentials";
import * as m from "$lib/paraglide/messages";
import {
  EDUCATOR_SESSION_COOKIE_NAME,
  EDUCATOR_SESSION_TTL_DAYS,
  SESSION_COOKIE_NAME,
} from "$lib/server/auth/sessions";
import {
  clearBootstrapToken,
  getBootstrapTokens,
  getDb,
  getGatewayAdapter,
} from "$lib/server/boot";
import { AliasSchema, ProvisionSchema } from "$lib/server/classroom/schemas";
import { getConfig } from "$lib/server/config";
import { cookieDeletion, secureCookie } from "$lib/server/cookies";
import type { AppDatabase } from "$lib/server/db/client";
import { getClassroom } from "$lib/server/db/queries/classrooms";
import { getAliasById } from "$lib/server/db/queries/model-aliases";
import { baseModelId, checkGatewayHealth, listGatewayModelIds } from "$lib/server/gateway/health";
import { log } from "$lib/server/logging";
import {
  claimSetup,
  describeForeignClaim,
  recoverClaim,
  SETUP_CLAIM_COOKIE_NAME,
  SETUP_CLAIM_TTL_MS,
  verifyAndSlideClaim,
} from "$lib/server/setup/claim";
import {
  ClaimSchema,
  EDUCATOR_PASSWORD_MIN_LENGTH,
  GatewayContinueSchema,
  RecoverSchema,
  SetupClassroomSchema,
  SetupEducatorSchema,
} from "$lib/server/setup/schemas";
import {
  canFinishSetup,
  isSetupComplete,
  resolveSetupProgress,
  resolveStep,
  type SetupProgress,
  visibleSteps,
} from "$lib/server/setup/state";
import {
  finishSetup,
  provisionFirstStudents,
  saveAlias,
  saveClassroom,
  saveEducator,
} from "$lib/server/setup/steps";
import type { Actions, PageServerLoad } from "./$types";

/**
 * First-run setup (PRD §6.2, §7, §8, §9, §17).
 *
 * The one surface in Setun that an unauthenticated request may reach and change
 * something with, so the rules around it are unusually strict and are all
 * enforced here rather than assumed from the screen:
 *
 * - **Every action re-guards itself.** A page `load`'s guard does not run before
 *   a form action, which is the same reason the educator panel's actions each
 *   re-check the role. Setup completion is re-read per action, and every step
 *   past the claim re-verifies the claim and slides it.
 * - **`404`, not `403`, once setup is complete.** A `403` would confirm the
 *   surface exists (§21).
 * - **Progress is derived, never carried.** The step comes from the URL, clamped
 *   against what the persisted rows justify; nothing trusts a hidden field.
 *
 * Thin by §6.1: parse, authorise, delegate to `$lib/server/setup`, shape the
 * response. The decisions live in `claim.ts`, `state.ts` and `steps.ts`.
 */

/**
 * Stable form identifiers.
 *
 * Superforms matches an action's returned `SuperValidated` back to the client
 * instance by id, and the wizard renders a different form per step — so the ids
 * are named constants shared by the `load` and the action rather than spelled
 * twice.
 */
const EDUCATOR_FORM_ID = "setup-educator";
const ALIAS_FORM_ID = "setup-alias";
const CLASSROOM_FORM_ID = "setup-classroom";

const educatorAdapter = valibot(SetupEducatorSchema);
const aliasAdapter = valibot(AliasSchema);
const classroomAdapter = valibot(SetupClassroomSchema);

/**
 * Re-read completion, and refuse a finished installation.
 *
 * Called by the `load` and by every action, independently.
 */
function activeInstallation(): AppDatabase {
  const db = getDb();
  if (isSetupComplete(db)) error(404, "Not found");
  return db;
}

function readClaimProof(cookies: Cookies): string | null {
  return cookies.get(SETUP_CLAIM_COOKIE_NAME) ?? null;
}

/**
 * Write the claim cookie.
 *
 * Scoped to `/setup` so nothing else on the origin ever receives it, `Strict`
 * because no legitimate navigation to setup comes from another site, and
 * `Secure` on https exactly as the educator session cookie is (§7, §21).
 */
function setClaimCookie(cookies: Cookies, url: URL, proof: string): void {
  cookies.set(SETUP_CLAIM_COOKIE_NAME, proof, {
    path: "/setup",
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookie(url),
    maxAge: Math.floor(SETUP_CLAIM_TTL_MS / 1_000),
  });
}

interface ClaimedSetup {
  readonly db: AppDatabase;
  /** Kept so the claim can be re-asserted after the action has awaited. */
  readonly proof: string;
  readonly progress: SetupProgress;
}

/** Every step past the claim: re-verify, slide, and re-issue the cookie. */
function claimedInstallation(cookies: Cookies, url: URL): ClaimedSetup | null {
  const db = activeInstallation();

  const proof = readClaimProof(cookies);
  if (!verifyAndSlideClaim(db, proof) || !proof) return null;

  setClaimCookie(cookies, url, proof);
  return { db, proof, progress: currentProgress(db) };
}

/**
 * Re-assert the claim after an action has awaited, and re-read progress.
 *
 * `claimedInstallation` runs before the body is parsed, before the gateway is
 * probed, before a password is hashed. `recoverClaim` can `seizeClaim` during
 * any of that, and `finish` can complete setup — so an action that mutated on
 * the strength of the earlier check would be writing under an authority that had
 * already moved to another browser. This is the check that decides, and it is
 * the last thing before the write (§7, §21).
 *
 * The progress comes back with it rather than beside it: a step that re-checked
 * the claim and then acted on a stale `aliasId` would have swapped one
 * time-of-check bug for another.
 *
 * Returning null does not mean the request failed — it means it lost. The three
 * Superforms steps still owe their form a response, which is why each caller
 * refuses in its own shape rather than through a shared helper here.
 */
function stillClaimed(claim: ClaimedSetup): SetupProgress | null {
  if (!verifyAndSlideClaim(claim.db, claim.proof)) return null;
  return currentProgress(claim.db);
}

function currentProgress(db: AppDatabase): SetupProgress {
  return resolveSetupProgress(db, { educatorSeeded: getConfig().educatorUsername !== undefined });
}

/** A lost or stolen claim, in the shape the wizard renders. */
const CLAIM_LOST = { error: "claim_lost" } as const;

/**
 * Refuse a Superforms-driven step without leaving its form stranded.
 *
 * Superforms' `enhance` resolves a submission against the `SuperValidated` the
 * action returns; hand it a plain `fail` instead and the client never learns the
 * request finished — the button stays disabled and the message never appears. So
 * a guard failure on one of these three steps comes back as an empty form
 * carrying a form-level code, which the step renders through the same lookup the
 * claim screen uses.
 *
 * Three functions rather than one parameterised by an adapter: the three forms
 * have three unrelated shapes, and a shared helper would have to erase the types
 * that make the rest of this file safe.
 */
async function refuseEducatorStep(status: number, code: string) {
  const form = await superValidate(educatorAdapter, { id: EDUCATOR_FORM_ID });
  setError(form, code);
  return fail(status, { educatorForm: form });
}

async function refuseAliasStep(status: number, code: string) {
  const form = await superValidate(aliasAdapter, { id: ALIAS_FORM_ID });
  setError(form, code);
  return fail(status, { aliasForm: form });
}

async function refuseClassroomStep(status: number, code: string) {
  const form = await superValidate(classroomAdapter, { id: CLASSROOM_FORM_ID });
  setError(form, code);
  return fail(status, { classroomForm: form });
}

export const load: PageServerLoad = async ({ cookies, url }) => {
  const db = activeInstallation();

  const proof = readClaimProof(cookies);
  const claimed = verifyAndSlideClaim(db, proof);
  if (claimed && proof) setClaimCookie(cookies, url, proof);

  const foreign = describeForeignClaim(db, proof);
  const progress = currentProgress(db);
  const step = resolveStep(progress, url.searchParams.get("step"));

  const alias = progress.aliasId ? getAliasById(db, progress.aliasId) : undefined;
  const classroom = progress.classroomId ? getClassroom(db, progress.classroomId) : undefined;

  /**
   * The gateway is probed only on its own step.
   *
   * A live probe on every load would put a three-second timeout in front of
   * every page of the wizard, on a screen that is not asking about it (§9).
   */
  const gateway =
    claimed && step === "gateway" ? await checkGatewayHealth(getGatewayAdapter()) : null;
  if (gateway && !gateway.reachable) {
    log.warn("setup: gateway probe found the gateway unreachable");
  }

  return {
    step,
    steps: visibleSteps(progress),
    claimed,
    claimHeldElsewhere: foreign.heldElsewhere,
    claimRetryAt: foreign.retryAt?.toISOString() ?? null,
    /** Recovery is only offered once there is a credential to recover with (§7). */
    canRecover: progress.educatorExists,
    canFinish: canFinishSetup(progress),
    progress: {
      educatorExists: progress.educatorExists,
      educatorSeeded: progress.educatorSeeded,
      hasAlias: progress.aliasId !== null,
      hasClassroom: progress.classroomId !== null,
      studentCount: progress.studentCount,
    },
    gateway,
    /** The password floor, so the form states the server's rule rather than its own. */
    passwordMinLength: EDUCATOR_PASSWORD_MIN_LENGTH,
    /** Enough of the alias for the classroom step to ask the §16 question. */
    alias: alias ? { name: alias.name, dataProtection: alias.dataProtection } : null,
    classroomName: classroom?.name ?? null,
    appOrigin: getConfig().appOrigin,
    /** The card handed to a pupil is addressed to them, in the room's language (§17). */
    classroomLanguage: classroom?.interfaceLanguage ?? ("da" as const),
    educatorForm: await superValidate(
      { username: "", password: "", confirmPassword: "" },
      educatorAdapter,
      { id: EDUCATOR_FORM_ID, errors: false },
    ),
    aliasForm: await superValidate(
      alias
        ? {
            name: alias.name,
            gatewayModelId: alias.gatewayModelId,
            dialect: alias.dialect,
            available: alias.available,
            dataProtection: alias.dataProtection,
            supportsImageInput: alias.supportsImageInput,
            supportsImageGeneration: alias.supportsImageGeneration,
            inputPricePerMillion: alias.inputPricePerMillion,
            outputPricePerMillion: alias.outputPricePerMillion,
            isUtility: true,
          }
        : {
            name: "",
            gatewayModelId: "",
            dialect: "openai" as const,
            // In service by default: an alias the wizard created and left
            // unavailable would be a classroom that refuses everything.
            available: true,
            dataProtection: false,
            supportsImageInput: false,
            supportsImageGeneration: false,
            inputPricePerMillion: null,
            outputPricePerMillion: null,
            isUtility: true,
          },
      aliasAdapter,
      { id: ALIAS_FORM_ID, errors: false },
    ),
    classroomForm: await superValidate(
      {
        name: classroom?.name ?? "",
        timezone: classroom?.timezone ?? "Europe/Copenhagen",
        interfaceLanguage: classroom?.interfaceLanguage ?? ("da" as const),
        sessionPolicy: classroom?.sessionPolicy ?? ("sliding" as const),
        sessionSlidingDays: classroom?.sessionSlidingDays ?? 14,
        confirmNoDpa: false,
      },
      classroomAdapter,
      { id: CLASSROOM_FORM_ID, errors: false },
    ),
  };
};

export const actions: Actions = {
  /**
   * Step 0 — take the claim with the bootstrap token.
   *
   * The evaluation order is the contract, and it lives in `claimSetup`. A
   * malformed submission produces the same opaque `invalid_token` as a wrong or
   * expired one: four causes, one answer (§21).
   */
  claim: async ({ request, cookies, url, getClientAddress }) => {
    const db = activeInstallation();

    const body = await request.formData();
    const parsed = v.safeParse(ClaimSchema, { token: body.get("token") });
    if (!parsed.success) return kitFail(400, { error: "invalid_token" });

    const result = await claimSetup(db, {
      token: parsed.output.token,
      presentedProof: readClaimProof(cookies),
      ip: getClientAddress(),
      bootstrap: getBootstrapTokens(),
    });

    if (!result.ok) {
      const status =
        result.reason === "setup_claimed" ? 409 : result.reason === "rate_limited" ? 429 : 400;
      return kitFail(status, {
        error: result.reason,
        retryAt: result.retryAt?.toISOString() ?? null,
      });
    }

    setClaimCookie(cookies, url, result.proof);
    log.info("setup: bootstrap token accepted, first-run setup claimed");

    redirect(303, "/setup");
  },

  /**
   * Step 0, the other way in — re-take a lost claim with the operator credential.
   *
   * Only once an account exists; before that the bootstrap token is the only
   * proof there can be, and restarting the process to mint a fresh one is the
   * documented — and safe — recovery, because there is no account yet to have
   * been compromised.
   */
  recover: async ({ request, cookies, url, getClientAddress }) => {
    const db = activeInstallation();

    const body = await request.formData();
    const parsed = v.safeParse(RecoverSchema, {
      username: body.get("username"),
      password: body.get("password"),
    });
    if (!parsed.success) return kitFail(401, { error: "invalid_credentials" });

    const result = await recoverClaim(db, {
      username: parsed.output.username,
      password: parsed.output.password,
      ip: getClientAddress(),
    });

    if (!result.ok) {
      const status =
        result.reason === "no_educator" ? 409 : result.reason === "rate_limited" ? 429 : 401;
      return kitFail(status, { error: result.reason, retryAt: null });
    }

    setClaimCookie(cookies, url, result.proof);
    log.info("setup: claim recovered with the operator credential");

    redirect(303, "/setup");
  },

  /** Step 1 — the operator account. Refused outright when one is env-seeded. */
  educator: async ({ request, cookies, url }) => {
    const claim = claimedInstallation(cookies, url);
    if (!claim) return refuseEducatorStep(403, "claim_lost");

    // Deployment configuration owns the account when it supplies one; the wizard
    // must not quietly become a second way to change it (§7).
    if (claim.progress.educatorSeeded) return refuseEducatorStep(409, "educator_seeded");

    const form = await superValidate(request, educatorAdapter, { id: EDUCATOR_FORM_ID });
    if (!form.valid) return fail(400, { educatorForm: form });

    if (!stillClaimed(claim)) return refuseEducatorStep(403, "claim_lost");

    // Checked once more inside, after the hash: this is the one step whose write
    // *replaces* the operator credential, so the window the hash opens is worth
    // closing rather than narrowing.
    const educator = await saveEducator(claim.db, {
      username: form.data.username,
      password: form.data.password,
      stillAuthorised: () => stillClaimed(claim) !== null,
    });
    if (!educator) return refuseEducatorStep(403, "claim_lost");

    redirect(303, "/setup?step=gateway");
  },

  /**
   * Step 2 — carry on past a gateway that is not answering.
   *
   * The probe is repeated here rather than trusting what the browser was shown:
   * a decision recorded from a client-supplied fact would record the wrong thing
   * whenever the fact had changed (§9, §21).
   */
  gateway: async ({ request, cookies, url }) => {
    const claim = claimedInstallation(cookies, url);
    if (!claim) return kitFail(403, CLAIM_LOST);

    const body = await request.formData();
    const parsed = v.safeParse(GatewayContinueSchema, { acknowledged: body.get("acknowledged") });
    if (!parsed.success) return kitFail(400, { error: "invalid" });

    const health = await checkGatewayHealth(getGatewayAdapter());
    if (!health.reachable) {
      log.warn("setup: continuing past an unreachable gateway, at the operator's explicit request");
    }

    redirect(303, "/setup?step=alias");
  },

  /** Step 3 — the first model alias, which is also the utility alias (§9, §10). */
  alias: async ({ request, cookies, url }) => {
    const claim = claimedInstallation(cookies, url);
    if (!claim) return refuseAliasStep(403, "claim_lost");

    const form = await superValidate(request, aliasAdapter, { id: ALIAS_FORM_ID });
    if (!form.valid) return fail(400, { aliasForm: form });

    /**
     * Check the identifier against the gateway before saving it (§9).
     *
     * Step 2 has just listed the models this gateway serves, and a typo here
     * produces an installation whose only alias — and therefore its utility
     * alias too — points at nothing, with no sign of it until the first pupil
     * sends the first message. The wizard's own summary would still report the
     * model "ready".
     *
     * A gateway that does not answer does not block setup: it may simply be
     * starting, and refusing to let an operator finish would be worse than the
     * typo this guards against.
     */
    const served = await listGatewayModelIds(getGatewayAdapter());
    if (served !== null && !served.includes(baseModelId(form.data.gatewayModelId))) {
      setError(
        form,
        "gatewayModelId",
        m.validation_gateway_model_unknown({
          models: served.join(", "),
        }),
      );
      return fail(400, { aliasForm: form });
    }

    const progress = stillClaimed(claim);
    if (!progress) return refuseAliasStep(403, "claim_lost");

    saveAlias(claim.db, { progress, values: form.data });
    redirect(303, "/setup?step=classroom");
  },

  /** Step 4 — the first classroom, with the step-3 alias allowlisted for it (§8, §16). */
  classroom: async ({ request, cookies, url }) => {
    const claim = claimedInstallation(cookies, url);
    if (!claim) return refuseClassroomStep(403, "claim_lost");

    const form = await superValidate(request, classroomAdapter, { id: CLASSROOM_FORM_ID });
    if (!form.valid) return fail(400, { classroomForm: form });

    const progress = stillClaimed(claim);
    if (!progress) return refuseClassroomStep(403, "claim_lost");

    const alias = progress.aliasId ? getAliasById(claim.db, progress.aliasId) : undefined;

    const result = saveClassroom(claim.db, {
      progress,
      alias,
      values: form.data,
    });

    if (!result.ok) {
      // The §16 acknowledgement is a field on this form, so its refusal lands on
      // that field rather than as a banner somewhere above it.
      if (result.reason === "no_dpa_unconfirmed") setError(form, "confirmNoDpa", result.reason);
      else setError(form, result.reason);

      return fail(400, { classroomForm: form });
    }

    redirect(303, "/setup?step=students");
  },

  /**
   * Step 5 — a first batch of pseudonymous accounts (§7, §17).
   *
   * The codes travel in this response and nowhere else. Provisioning twice is
   * two batches, not an edit: the step is the one part of the wizard that is not
   * idempotent, and the screen says so.
   */
  students: async ({ request, cookies, url }) => {
    const claim = claimedInstallation(cookies, url);
    if (!claim) return kitFail(403, CLAIM_LOST);

    const parsed = v.safeParse(ProvisionSchema, { count: (await request.formData()).get("count") });
    if (!parsed.success) return kitFail(400, { error: "invalid" });

    const progress = stillClaimed(claim);
    if (!progress) return kitFail(403, CLAIM_LOST);

    const classroom = progress.classroomId
      ? getClassroom(claim.db, progress.classroomId)
      : undefined;
    if (!classroom) return kitFail(409, { error: "classroom_missing" });

    // Checked once more inside, after the codes are hashed: the batch is written
    // in one synchronous turn, so that check is the last thing that can stop it.
    const provisioned = await provisionFirstStudents(claim.db, {
      classroom,
      pepper: getConfig().studentCodePepper,
      count: parsed.output.count,
      stillAuthorised: () => stillClaimed(claim) !== null,
    });
    if (provisioned.length === 0) return kitFail(403, CLAIM_LOST);

    return {
      cards: provisioned.map(
        ({ student, code }): CredentialCard => ({
          label: student.label,
          code: code.display,
          hint: code.hint,
        }),
      ),
    };
  },

  /**
   * Finish (§6.2, §7, §21).
   *
   * In this order: prerequisites, then completion, then the claim and the
   * bootstrap token are destroyed, then any session cookie the browser arrived
   * with is *deleted* before a fresh educator session is issued. That last pair
   * is the session-fixation defence, and it mirrors what the educator login
   * route does.
   */
  finish: async ({ cookies, url }) => {
    const claim = claimedInstallation(cookies, url);
    if (!claim) return kitFail(403, CLAIM_LOST);

    const result = finishSetup(claim.db, { educatorSeeded: claim.progress.educatorSeeded });
    if (!result.ok) return kitFail(409, { error: result.reason });

    cookies.delete(SETUP_CLAIM_COOKIE_NAME, cookieDeletion(url, "/setup"));
    clearBootstrapToken();

    cookies.delete(SESSION_COOKIE_NAME, cookieDeletion(url, "/"));
    cookies.delete(EDUCATOR_SESSION_COOKIE_NAME, cookieDeletion(url, "/"));
    cookies.set(EDUCATOR_SESSION_COOKIE_NAME, result.session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie(url),
      maxAge: EDUCATOR_SESSION_TTL_DAYS * 24 * 60 * 60,
    });

    redirect(303, "/educator");
  },
};
