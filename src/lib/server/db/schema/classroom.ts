import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AttachmentMediaType } from "../../../attachments";
import { createdAt, primaryId, updatedAt } from "./helpers";

/**
 * Availability state (PRD §8).
 *
 * "Every classroom has an explicit open or locked state that overrides all
 * scheduling. On top of that sits a recurring weekly schedule…"
 *
 * Three values rather than two, because an override that cannot be released
 * would make the schedule write-only: `scheduled` is the absence of an override,
 * and the two overrides are what the educator's prominent controls set (§8).
 */
export const CLASSROOM_STATES = ["scheduled", "open", "locked"] as const;
export type ClassroomState = (typeof CLASSROOM_STATES)[number];

/** Session lifetime policy (§7). */
export const SESSION_POLICIES = ["sliding", "per-lesson"] as const;
export type SessionPolicy = (typeof SESSION_POLICIES)[number];

/** Tool permission modes, applied before any tool executes (§11). Enforced in Phase 3.4. */
export const PERMISSION_MODES = ["strict", "standard", "open"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Whether a pupil may see the model's reasoning (§20).
 *
 * Three values because the educator's question is genuinely three-way: leave it
 * to the pupil, always show it, or never send it at all. `hidden` is enforced
 * server-side — the events are dropped before the turn is buffered, so nothing
 * reaches the browser for a devtools panel to find (§21).
 */
export const THINKING_VISIBILITIES = ["student", "shown", "hidden"] as const;
export type ThinkingVisibility = (typeof THINKING_VISIBILITIES)[number];

/**
 * Whether a pupil's browser plays a soft sound when an answer finishes (§20).
 *
 * The classroom's *default*: each pupil can still turn it on or off for their
 * own device. Two values, because the educator's question is "should this room
 * chime?" — twenty-five laptops chiming at once is a real risk in a classroom,
 * and a quiet room needs a way to say so for everybody at once.
 */
export const DONE_SOUNDS = ["on", "off"] as const;
export type DoneSound = (typeof DONE_SOUNDS)[number];

/** Student skill-authoring policy (§12). Enforced in Phase 3.9. */
export const SKILL_AUTHORING_POLICIES = ["immediate", "pre-approval", "disabled"] as const;
export type SkillAuthoringPolicy = (typeof SKILL_AUTHORING_POLICIES)[number];

/** Interface language (§8). Danish for the pilot, English available. */
export const INTERFACE_LANGUAGES = ["da", "en"] as const;
export type InterfaceLanguage = (typeof INTERFACE_LANGUAGES)[number];

/**
 * One recurring lesson window, in the classroom's timezone (§8).
 *
 * Minutes from local midnight rather than a clock string: schedule resolution is
 * arithmetic, and a "09:00" that has to be parsed on every comparison invites the
 * hand-rolled offset handling §5 forbids. `weekday` follows `date-fns` — 0 is
 * Sunday — so no translation sits between this and `getDay`.
 */
export interface WeeklyWindow {
  readonly weekday: number;
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * A one-off window for homework or a substituted lesson (§8).
 *
 * Absolute instants, because a one-off is pinned to a date rather than to a
 * recurring local time — no DST re-interpretation applies to it.
 */
export interface TemporaryWindow {
  readonly startsAt: number;
  readonly endsAt: number;
  readonly note?: string;
}

/**
 * Reserved for the feature toggles of §17.
 *
 * Named in the §19 data model, so the column exists; nothing reads it yet, and
 * no toggle is invented ahead of the phase that needs one.
 */
export type FeatureFlags = Record<string, boolean>;

/**
 * The unit of configuration (PRD §8, §19).
 *
 * Everything an educator steers a class with lives here: availability, budgets,
 * policies and instructions. Per-student overrides live on `student` and are
 * merged by `$lib/server/classroom/settings` — the granularity principle (§2).
 *
 * Defaults are Appendix A verbatim, and are the schema's job rather than the
 * form's: a classroom created by any path — panel, seed, test — starts from the
 * Standard preset without the creating code restating it.
 */
export const classroom = sqliteTable("classroom", {
  id: primaryId(),
  name: text().notNull(),
  /** IANA zone; `Europe/Copenhagen` is the PRD §8 default. */
  timezone: text().notNull().default("Europe/Copenhagen"),

  /** Overrides the schedule when not `scheduled` (§8). */
  state: text({ enum: CLASSROOM_STATES }).notNull().default("scheduled"),
  /**
   * When an "Open now" override lapses back to the schedule (§8).
   *
   * Null means the override stands until the educator changes it — which is what
   * Lock always does, since a lock that expired on its own would be a surprise.
   */
  stateUntil: integer({ mode: "timestamp_ms" }),
  /**
   * When the explicit state was last set; null while none ever was.
   *
   * Distinct from `updatedAt` on purpose: the per-lesson session policy asks
   * when the classroom last closed, and editing an unrelated setting must not
   * answer that question differently (§7). Null is meaningful rather than
   * missing — a classroom that has only ever followed its schedule has no
   * override instant, and the schedule alone answers the question.
   */
  stateChangedAt: integer({ mode: "timestamp_ms" }),

  weeklySchedule: text({ mode: "json" }).$type<WeeklyWindow[]>().notNull().default([]),
  temporaryWindows: text({ mode: "json" }).$type<TemporaryWindow[]>().notNull().default([]),

  sessionPolicy: text({ enum: SESSION_POLICIES }).notNull().default("sliding"),
  /** Sliding-expiry length; Appendix A default is 14 days (§7). */
  sessionSlidingDays: integer().notNull().default(14),

  /** Conversation retention in days; Appendix A default 30 (§16). Enforced in Phase 5.4. */
  conversationRetentionDays: integer().notNull().default(30),
  /** Null keeps creations until deleted — the student's portfolio (§16). */
  creationRetentionDays: integer(),

  // Budgets, all in tokens — the unit the gateway reports (§10). Standard preset.
  perTurnStepCap: integer().notNull().default(20),
  perTurnWallClockSeconds: integer().notNull().default(300),
  perTurnTokenCap: integer().notNull().default(100_000),
  perStudentDailyTokens: integer().notNull().default(250_000),
  perClassroomDailyTokens: integer().notNull().default(2_500_000),

  permissionMode: text({ enum: PERMISSION_MODES }).notNull().default("standard"),
  /**
   * Whether the model's reasoning reaches the pupil (§20).
   *
   * Defaults to `student`: the pupil's own device setting decides, which is
   * where a preference about how somebody likes to read belongs (§16).
   */
  thinkingVisibility: text({ enum: THINKING_VISIBILITIES }).notNull().default("student"),
  /**
   * Whether an answer finishing chimes by default (§20). A pupil's own device
   * setting overrides it; nothing about that choice reaches the server (§16).
   */
  doneSound: text({ enum: DONE_SOUNDS }).notNull().default("on"),
  skillAuthoringPolicy: text({ enum: SKILL_AUTHORING_POLICIES }).notNull().default("immediate"),

  /** Classroom-wide attachment toggle; per-student overrides sit on `student` (§10). */
  attachmentsEnabled: integer({ mode: "boolean" }).notNull().default(true),
  /** Educator-controlled allowed types; Appendix A defaults (§10). Enforced in Phase 3.11. */
  attachmentTypes: text({ mode: "json" })
    .$type<AttachmentMediaType[]>()
    .notNull()
    .default(["image/png", "image/jpeg", "image/webp", "text/plain"]),
  /** Appendix A: images <= 5 MB, text/code <= 256 KB, at most 5 per message (§10). */
  attachmentImageMaxBytes: integer()
    .notNull()
    .default(5 * 1024 * 1024),
  attachmentTextMaxBytes: integer()
    .notNull()
    .default(256 * 1024),
  attachmentMaxPerMessage: integer().notNull().default(5),

  /**
   * The token-equivalent one generated image costs (§15, Appendix A: 10k).
   *
   * "Image endpoints do not reliably report usage and generation must never be
   * free", so the figure is a policy the panel sets rather than something the
   * gateway reports.
   */
  imageTokenEquivalent: integer().notNull().default(10_000),

  /** The educator's steering instrument, layered into the system prompt (§10). */
  classroomInstructions: text(),
  interfaceLanguage: text({ enum: INTERFACE_LANGUAGES }).notNull().default("da"),

  /** DKK per USD for the display-only cost estimate; Appendix A default 7.00 (§10). */
  costExchangeRate: real().notNull().default(7.0),

  featureFlags: text({ mode: "json" }).$type<FeatureFlags>().notNull().default({}),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Classroom = typeof classroom.$inferSelect;
