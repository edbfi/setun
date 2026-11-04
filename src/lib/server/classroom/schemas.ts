import * as v from "valibot";
import { ATTACHMENT_MEDIA_TYPES } from "$lib/attachments";
import * as m from "$lib/paraglide/messages";
import { BUDGET_PRESET_NAMES } from "../agent/budgets";
import {
  CLASSROOM_STATES,
  DONE_SOUNDS,
  GATEWAY_DIALECTS,
  INTERFACE_LANGUAGES,
  PERMISSION_MODES,
  SESSION_POLICIES,
  SKILL_AUTHORING_POLICIES,
  STUDENT_STATUSES,
  THINKING_VISIBILITIES,
} from "../db/schema";
import { OPEN_DURATIONS } from "./schedule";

/**
 * Validation for every educator panel form (PRD §5, §8, §9, §10).
 *
 * "Every form action and API endpoint validates through a Valibot schema, no
 * exceptions" (§5). They live together because they share one audience — the
 * `(educator)` routes — and one reason to change: the panel's form set. Splitting
 * one file per form would produce single-export modules with no second importer,
 * which is not what the splitting principle asks for (§6.1).
 *
 * Two shapes appear here, for a reason:
 *
 * - Schemas Superforms drives use plain `v.number()` / `v.boolean()`. Superforms
 *   coerces form data from the schema's own types, and a coercing pipe would
 *   erase the input type it needs to do that — and with it `bind:value`.
 * - Schemas a plain action parses by hand coerce explicitly, because there
 *   everything off a `FormData` is a string.
 *
 * Nothing here writes; the routes hand the parsed output to the query modules.
 * These schemas are the boundary an educator's input crosses, so every bound
 * that matters — a weekday in range, a positive cap, a real timezone — is
 * asserted here rather than trusted downstream.
 */

const MINUTES_PER_DAY = 24 * 60;

/** A trimmed, non-empty string of bounded length. */
/**
 * A required single-line name.
 *
 * The empty case carries an authored message: unlabelled, Valibot reports
 * "Invalid length: Expected >=1 but received 0", which is a developer's
 * diagnostic and was reaching teachers and operators verbatim.
 */
const label = (max: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(1, m.validation_name_required()), v.maxLength(max));

/**
 * Free text an educator may clear.
 *
 * Defaults to the empty string rather than null: that is what a browser posts
 * for an empty textarea, and the route turns it into null so an empty layer is
 * never sent to a model as an instruction with no content (§10).
 */
const optionalText = (max: number) =>
  v.optional(v.pipe(v.string(), v.trim(), v.maxLength(max)), "");

/** Blank text is absent text — applied by the routes to `optionalText` fields. */
export function blankToNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

const whole = (min: number, max: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max));

/**
 * A whole number, or nothing at all.
 *
 * An empty number input does not arrive as null — it arrives as NaN, which
 * `v.number()` accepts and every bound then rejects with valibot's own wording.
 * Folding it to null here is what makes "leave it empty" a real answer rather
 * than a validation error nobody can read (§21).
 */
const optionalWhole = (min: number, max: number) =>
  v.pipe(
    v.nullable(v.number(), null),
    v.transform((value) => (value !== null && Number.isFinite(value) ? value : null)),
    v.check(
      (value) => value === null || (Number.isInteger(value) && value >= min && value <= max),
      m.validation_retention_range(),
    ),
  );

const flag = v.optional(v.boolean(), false);

/**
 * An optional price in USD per million tokens.
 *
 * Nullable rather than zero: "optional per-million-token prices" (§9), and a
 * price of zero would be priced as free rather than unpriced.
 */
const optionalPrice = v.nullable(
  v.pipe(
    // Named, like `gatewayModelId` above and for the same reason: a blank or
    // mistyped price arrives as NaN, and "Invalid type: Expected number but
    // received NaN" is not a sentence anyone should be shown (§21).
    v.number(m.validation_price_not_a_number()),
    v.check((value) => Number.isFinite(value), m.validation_price_not_a_number()),
    v.minValue(0, m.validation_price_negative()),
    v.maxValue(10_000, m.validation_price_too_large()),
  ),
  null,
);

/**
 * A model's context window in tokens, or null for "ask the gateway" (§9, §10).
 *
 * Whole tokens, and at least a small model's worth: a typo of "128" for
 * "128000" would otherwise compact every conversation down to nothing.
 */
const optionalContextWindow = v.nullable(
  v.pipe(
    v.number(m.validation_context_window_invalid()),
    v.check((value) => Number.isInteger(value), m.validation_context_window_invalid()),
    v.minValue(1_024, m.validation_context_window_invalid()),
    v.maxValue(10_000_000, m.validation_context_window_invalid()),
  ),
  null,
);

/**
 * An IANA zone, checked against the platform's own database.
 *
 * A typo here would make every schedule in the classroom resolve against a zone
 * that does not exist, and `date-fns-tz` would throw on the next request.
 *
 * Exported because the first-run wizard creates a classroom too, and asks the
 * same question of the same field (§6.2, §8).
 */
export const ianaTimezone = v.pipe(
  label(64),
  v.check((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Enter a valid IANA timezone, for example Europe/Copenhagen"),
);

// --- Classroom identity (§8) ---

export const CreateClassroomSchema = v.object({
  name: label(120),
  timezone: v.optional(ianaTimezone, "Europe/Copenhagen"),
});

// --- Availability (§8) ---

/** Parsed by hand from a two-button form, so the picklists read raw strings. */
export const SetStateSchema = v.object({
  state: v.picklist(CLASSROOM_STATES),
  /** Only read for `open`; a lock stands until the educator lifts it (§8). */
  duration: v.optional(v.picklist(OPEN_DURATIONS), "indefinite"),
});

/**
 * The dashboard's one-click lock (§17).
 *
 * Names the classroom, because the dashboard shows several; the classroom pages
 * take it from the route instead.
 */
export const LockClassroomSchema = v.object({
  classroomId: v.pipe(v.string(), v.uuid()),
  state: v.picklist(CLASSROOM_STATES),
});

/**
 * A recurring lesson.
 *
 * Minutes from local midnight, matching the stored shape: a clock string parsed
 * on every comparison is where hand-rolled offset handling creeps in (§5).
 */
const weeklyWindow = v.pipe(
  v.object({
    weekday: whole(0, 6),
    startMinute: whole(0, MINUTES_PER_DAY - 1),
    endMinute: whole(1, MINUTES_PER_DAY),
  }),
  v.check((window) => window.endMinute > window.startMinute, "A lesson must end after it starts"),
);

export const ScheduleSchema = v.object({
  weeklySchedule: v.pipe(v.array(weeklyWindow), v.maxLength(60)),
});

const temporaryWindow = v.pipe(
  v.object({
    startsAt: whole(0, Number.MAX_SAFE_INTEGER),
    endsAt: whole(0, Number.MAX_SAFE_INTEGER),
    note: optionalText(120),
  }),
  v.check((window) => window.endsAt > window.startsAt, "A window must end after it starts"),
);

export const TemporaryWindowsSchema = v.object({
  temporaryWindows: v.pipe(v.array(temporaryWindow), v.maxLength(60)),
});

// --- Budgets (§10, Appendix A) ---

/**
 * Bounds, not policy: the panel's three presets fill these fields, and an
 * educator may set anything within reason afterwards (§10). The ceilings exist
 * so a slipped keystroke cannot write a cap no budget would ever reach.
 */
export const BudgetsSchema = v.object({
  perTurnStepCap: whole(1, 200),
  perTurnWallClockSeconds: whole(10, 3_600),
  perTurnTokenCap: whole(1_000, 2_000_000),
  perStudentDailyTokens: whole(1_000, 20_000_000),
  perClassroomDailyTokens: whole(1_000, 200_000_000),
  costExchangeRate: v.pipe(v.number(), v.minValue(0), v.maxValue(1_000)),
});

export const ApplyPresetSchema = v.object({
  preset: v.picklist(BUDGET_PRESET_NAMES),
});

// --- Instructions, language, session policy (§7, §8, §10) ---

export const ClassroomPolicySchema = v.object({
  classroomInstructions: optionalText(8_000),
  interfaceLanguage: v.picklist(INTERFACE_LANGUAGES),
  /**
   * Whether pupils may see the model's reasoning (§20).
   *
   * `student` leaves it to the pupil's own device setting; the other two decide
   * for the class. `hidden` is enforced server-side, so a pupil cannot reach the
   * reasoning by any route (§21).
   */
  thinkingVisibility: v.picklist(THINKING_VISIBILITIES),
  /** Whether an answer finishing chimes by default; each pupil may override it (§20). */
  doneSound: v.picklist(DONE_SOUNDS),
  /** Answers one pupil may have being written at once (§10). */
  maxConcurrentTurns: whole(1, 3),
  sessionPolicy: v.picklist(SESSION_POLICIES),
  sessionSlidingDays: whole(1, 365),
  conversationRetentionDays: whole(1, 3_650),
  /**
   * How long a pupil's creations are kept, or null to keep them until deleted.
   *
   * Nullable where conversation retention is not, because §16 makes creations a
   * portfolio: "creations outlive the conversations that produced them", and a
   * school that wants to hand a pupil their year's work needs the option of no
   * expiry at all. Null is the default and stays reachable from the form as an
   * empty field — a number is a policy, and a blank is the absence of one.
   */
  creationRetentionDays: optionalWhole(1, 3_650),
});

/**
 * Tools, skills, attachments and image generation (§10, §11, §12, §15).
 *
 * A schema of its own rather than more fields on the policy form: this is the
 * settings block an educator changes when they decide what a class may *do*,
 * and it is edited from a different part of the page than instructions and
 * session length. Appendix A supplies every default; each stays editable.
 */
export const ToolPolicySchema = v.object({
  permissionMode: v.picklist(PERMISSION_MODES),
  skillAuthoringPolicy: v.picklist(SKILL_AUTHORING_POLICIES),
  attachmentsEnabled: flag,
  /**
   * Which file types a class may attach (§10).
   *
   * The column was described as educator-controlled from the start and had no
   * control at all, so every classroom ran on the Appendix A default whatever it
   * needed — a class working with pictures could not turn GIFs on, and one that
   * wanted text only could not turn images off.
   *
   * A checkbox per type from a fixed list rather than free text: the allowlist is
   * matched against what the sniffer decides the bytes *are*, so a type it cannot
   * produce would never match, and free text would let an educator believe they
   * had allowed something the pipeline has no handling for.
   *
   * An empty list is a valid answer and means the same as attachments off; it is
   * not treated as "no restriction", which is the failure a permissive default
   * would make silent.
   */
  attachmentTypes: v.optional(v.array(v.picklist(ATTACHMENT_MEDIA_TYPES)), []),
  /** Appendix A: images <= 5 MB, text/code <= 256 KB, at most 5 per message. */
  attachmentImageMaxBytes: whole(1_024, 64 * 1024 * 1024),
  attachmentTextMaxBytes: whole(256, 8 * 1024 * 1024),
  attachmentMaxPerMessage: whole(1, 20),
  /** Appendix A: 10k tokens per generated image (§15). */
  imageTokenEquivalent: whole(1, 1_000_000),
});

/** Parsed by hand from one row of the tool allowlist (§11). */
export const AllowToolSchema = v.object({ mcpToolId: v.pipe(v.string(), v.uuid()) });

/** Parsed by hand from one row of the skill grants (§12). */
export const GrantSkillSchema = v.object({
  skillId: v.pipe(v.string(), v.uuid()),
  /** Empty offers the skill to the whole class; a value narrows it to one pupil. */
  studentId: v.pipe(
    v.optional(v.string(), ""),
    v.transform((value) => (value ? value : null)),
    v.union([v.null(), v.pipe(v.string(), v.uuid())]),
  ),
});

// --- Skills (§12) ---

/** One skill as an educator or a pupil writes it in a form. */
export const SkillSchema = v.object({
  name: v.pipe(
    label(60),
    v.regex(
      /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u,
      "a skill name may contain letters, digits, spaces, hyphens and underscores",
    ),
  ),
  /** The one line injected into the system prompt (§12). */
  description: label(200),
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64_000)),
});

export const SkillIdSchema = v.object({ skillId: v.pipe(v.string(), v.uuid()) });

/** Parsed by hand: a skill toggled, approved or rejected from a row's own form. */
export const SkillStateSchema = v.object({
  skillId: v.pipe(v.string(), v.uuid()),
  enabled: v.optional(v.picklist(["true", "false"])),
  approvalState: v.optional(v.picklist(["approved", "pending", "rejected"])),
});

// --- MCP servers and tools (§11) ---

export const McpServerStateSchema = v.object({
  serverId: v.pipe(v.string(), v.uuid()),
  enabled: v.picklist(["true", "false"]),
});

export const McpToolStateSchema = v.object({
  toolId: v.pipe(v.string(), v.uuid()),
  enabled: v.optional(v.picklist(["true", "false"])),
  sensitive: v.optional(v.picklist(["true", "false"])),
});

/** Parsed by hand from one row of the roster. */
export const StudentInstructionsSchema = v.object({
  studentId: v.pipe(v.string(), v.uuid()),
  instructions: v.pipe(
    v.optional(v.string(), ""),
    v.transform((value) => value.trim()),
    v.maxLength(4_000),
    v.transform(blankToNull),
  ),
});

// --- Provisioning and roster actions (§7, §16, §17) ---

/** Batch size, bounded by what a class is: a roster, not an import. */
export const ProvisionSchema = v.object({
  count: v.pipe(
    v.unknown(),
    v.transform(Number),
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(40),
  ),
});

/** Parsed by hand from one row of the roster; every action names one pupil. */
export const StudentIdSchema = v.object({ studentId: v.pipe(v.string(), v.uuid()) });

/**
 * The three distinctions §16 asks the panel to draw.
 *
 * `active` and `disabled` are the two ends of the enable/disable pair; `removed`
 * takes a pupil off the roster with their work kept. Permanent deletion is a
 * separate action with a separate schema, because it is not a status.
 */
export const StudentStatusSchema = v.object({
  studentId: v.pipe(v.string(), v.uuid()),
  status: v.picklist(STUDENT_STATUSES),
});

/** Per-student attachment override; `inherit` hands the decision back to the classroom (§10). */
export const StudentAttachmentsSchema = v.object({
  studentId: v.pipe(v.string(), v.uuid()),
  attachments: v.picklist(["on", "off", "inherit"]),
});

/**
 * Permanent deletion, typed rather than clicked.
 *
 * The educator retypes the pupil's label. §16 calls this out as a distinct
 * action from disabling and removal, and the distinction is worth a keystroke:
 * nothing here is recoverable.
 */
export const DeleteStudentSchema = v.object({
  studentId: v.pipe(v.string(), v.uuid()),
  confirmLabel: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

// --- Model aliases (§9, §16) ---

export const AliasSchema = v.object({
  /** The friendly name — the only part of an alias a pupil ever sees (§9). */
  name: label(60),
  /** The identifier CPA knows. Never sent to a student's browser (§9, §21). */
  // Named outright rather than through `label()`: these are the two fields an
  // educator actually leaves blank, and "Invalid length: Expected >=1" is not a
  // sentence anyone should be shown.
  gatewayModelId: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, m.validation_gateway_model_required()),
    v.maxLength(200),
  ),
  dialect: v.picklist(GATEWAY_DIALECTS),
  available: flag,
  dataProtection: flag,
  supportsImageInput: flag,
  supportsImageGeneration: flag,
  inputPricePerMillion: optionalPrice,
  outputPricePerMillion: optionalPrice,
  contextWindowTokens: optionalContextWindow,
  isUtility: flag,
});

/** Parsed by hand from one row of the allowlist. */
export const AllowAliasSchema = v.object({
  modelAliasId: v.pipe(v.string(), v.uuid()),
  /**
   * The educator's explicit acknowledgement for an alias with no data
   * processing agreement (§16).
   *
   * Required rather than implied: §16 asks that the decision be "made
   * deliberately, per classroom, by the person accountable for it", and the
   * server refuses the allowlisting without it — a dialog the client could skip
   * would not be that.
   */
  confirmNoDpa: v.pipe(
    v.optional(v.unknown()),
    v.transform((value) => value === "on" || value === "true" || value === true),
  ),
});

export const AliasIdSchema = v.object({ modelAliasId: v.pipe(v.string(), v.uuid()) });
