import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { Classroom } from "../db/schema";

/**
 * The three budget layers (PRD §10).
 *
 * "Budgets are three layers, all denominated in tokens — the unit the gateway
 * actually reports — and all panel-configurable per classroom."
 *
 *  1. Per-turn caps — steps, wall-clock, tokens. These are *checkpoints*: the
 *     turn pauses at its next clean boundary and asks the pupil whether to
 *     continue, and continuing grants the same allotment again.
 *  2. Per-student daily allowance — so one pupil cannot drain the class.
 *  3. Per-classroom daily cap — the ceiling for the whole class.
 *
 * Layers 2 and 3 are the hard ceilings, and they bind both when a turn starts
 * and while one runs, so a single turn cannot overshoot the day by a whole
 * allotment. Layer 1 no longer cuts a response mid-sentence — it stops a runaway
 * loop by asking, which is a question a pupil watching an answer can answer.
 */

const SECONDS_PER_MINUTE = 60;

/** The five fields a preset fills (Appendix A). */
export interface BudgetSettings {
  readonly perTurnStepCap: number;
  readonly perTurnWallClockSeconds: number;
  readonly perTurnTokenCap: number;
  readonly perStudentDailyTokens: number;
  readonly perClassroomDailyTokens: number;
}

export const BUDGET_PRESET_NAMES = ["cautious", "standard", "generous"] as const;
export type BudgetPresetName = (typeof BUDGET_PRESET_NAMES)[number];

/**
 * Appendix A verbatim.
 *
 * "Selecting a preset fills all five fields; fields remain individually editable
 * afterwards" — so a preset is a starting point the panel writes into the
 * classroom, never a mode the classroom is left in.
 */
export const BUDGET_PRESETS: Readonly<Record<BudgetPresetName, BudgetSettings>> = {
  cautious: {
    perTurnStepCap: 10,
    perTurnWallClockSeconds: 3 * SECONDS_PER_MINUTE,
    perTurnTokenCap: 50_000,
    perStudentDailyTokens: 100_000,
    perClassroomDailyTokens: 1_000_000,
  },
  standard: {
    perTurnStepCap: 20,
    perTurnWallClockSeconds: 5 * SECONDS_PER_MINUTE,
    perTurnTokenCap: 100_000,
    perStudentDailyTokens: 250_000,
    perClassroomDailyTokens: 2_500_000,
  },
  generous: {
    perTurnStepCap: 30,
    perTurnWallClockSeconds: 10 * SECONDS_PER_MINUTE,
    perTurnTokenCap: 200_000,
    perStudentDailyTokens: 500_000,
    perClassroomDailyTokens: 5_000_000,
  },
};

/**
 * Which preset a classroom's budgets currently match, or null for a custom mix.
 *
 * A preset is never a stored mode (see `BUDGET_PRESETS`), so the panel derives
 * the selected preset by comparing the five fields. A hand-edit of any field
 * yields null — "Custom" — rather than a preset name the values no longer match.
 */
export function matchPreset(budgets: BudgetSettings): BudgetPresetName | null {
  for (const name of BUDGET_PRESET_NAMES) {
    const preset = BUDGET_PRESETS[name];
    if (
      preset.perTurnStepCap === budgets.perTurnStepCap &&
      preset.perTurnWallClockSeconds === budgets.perTurnWallClockSeconds &&
      preset.perTurnTokenCap === budgets.perTurnTokenCap &&
      preset.perStudentDailyTokens === budgets.perStudentDailyTokens &&
      preset.perClassroomDailyTokens === budgets.perClassroomDailyTokens
    ) {
      return name;
    }
  }
  return null;
}

/** The classroom's budget settings, as the loop and the start-of-turn check read them. */
export function budgetsOf(classroom: Pick<Classroom, keyof BudgetSettings>): BudgetSettings {
  return {
    perTurnStepCap: classroom.perTurnStepCap,
    perTurnWallClockSeconds: classroom.perTurnWallClockSeconds,
    perTurnTokenCap: classroom.perTurnTokenCap,
    perStudentDailyTokens: classroom.perStudentDailyTokens,
    perClassroomDailyTokens: classroom.perClassroomDailyTokens,
  };
}

/**
 * The half-open instant range of the budget day containing `at` (§10).
 *
 * "A day, for budget purposes, is the calendar day in the classroom's timezone —
 * allowances and caps reset at local midnight."
 *
 * Local midnight is converted through `date-fns-tz`, so a day is 23 or 25 hours
 * on the two transition days without this function knowing that (§5).
 */
const pad = (value: number) => String(value).padStart(2, "0");

export function budgetDayRange(
  timezone: string,
  at: Date = new Date(),
): { readonly start: Date; readonly end: Date } {
  const today = formatInTimeZone(at, timezone, "yyyy-MM-dd");
  const start = fromZonedTime(`${today}T00:00:00`, timezone);

  // The next local midnight, found from the calendar date rather than by adding
  // 24 hours — which would land an hour out on a transition day.
  const [year, month, day] = today.split("-").map(Number);
  const nextUtc = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
  const tomorrow = `${nextUtc.getUTCFullYear()}-${pad(nextUtc.getUTCMonth() + 1)}-${pad(nextUtc.getUTCDate())}`;

  return { start, end: fromZonedTime(`${tomorrow}T00:00:00`, timezone) };
}

/** Why a turn may not start. Each maps to a friendly, non-technical message (§10). */
export type BudgetRefusal = "student-allowance-exhausted" | "classroom-cap-exhausted";

/**
 * A discriminated union rather than an optional field: the refusal is present
 * exactly when the turn is refused, and the caller reads it without asserting.
 */
export type BudgetDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: BudgetRefusal };

export interface DailyConsumption {
  readonly studentTokens: number;
  readonly classroomTokens: number;
}

/** A turn's claims on the shared day, reconciled after each provider request. */
export interface DailyBudgetLease {
  consumed(): DailyConsumption;
  /**
   * Hold the day's tokens for one provider request: its prompt, then up to
   * `outputTokens` of answer — called again, with what the request has used so
   * far as the prompt, to hold more. `limit` is what reaching the reservation
   * means: the end of the day, or null when more may be asked for.
   */
  reserve(
    promptTokens: number,
    outputTokens?: number,
  ): { outputTokens: number; limit: DailyStop | null } | { stop: DailyStop };
  settle(tokens: number): void;
  release(): void;
}

/**
 * Decide whether a turn may start (§10).
 *
 * The classroom cap is checked first: when the class ceiling is reached, an
 * individual pupil's remaining allowance is irrelevant, and the message they
 * see should say so.
 */
export function checkTurnBudget(
  budgets: BudgetSettings,
  consumed: DailyConsumption,
): BudgetDecision {
  if (consumed.classroomTokens >= budgets.perClassroomDailyTokens) {
    return { allowed: false, refusal: "classroom-cap-exhausted" };
  }
  if (consumed.studentTokens >= budgets.perStudentDailyTokens) {
    return { allowed: false, refusal: "student-allowance-exhausted" };
  }
  return { allowed: true };
}

/**
 * Whether internal utility work may run (§10).
 *
 * "Internal utility-alias calls count toward the per-classroom daily cap but
 * never toward a student's personal allowance; when the classroom cap is
 * exhausted, utility work is skipped and its fallback used."
 */
export function mayRunUtilityWork(
  budgets: BudgetSettings,
  consumed: Pick<DailyConsumption, "classroomTokens">,
): boolean {
  return consumed.classroomTokens < budgets.perClassroomDailyTokens;
}

/** Which per-turn cap a checkpoint was reached on (§10). */
export type PerTurnCap = "steps" | "wall-clock" | "tokens";

/** Which daily ceiling ran out. The same vocabulary `checkTurnBudget` refuses with. */
export type DailyStop = "student-allowance-exhausted" | "classroom-cap-exhausted";

/** How much of a daily allowance may be spent before the pupil is told (§10). */
export const DAILY_WARNING_FRACTION = 0.7;

/**
 * The request identifier the 70 % warning is answered against.
 *
 * A fixed string rather than a counter: the warning is emitted at most once per
 * turn, and the "Keep going" button answers exactly it.
 */
export const DAILY_WARNING_REQUEST_ID = "daily-warning";

/**
 * What a turn has spent, and how close it is to the ceilings.
 *
 * Per-turn caps are **checkpoints**, not ceilings: reaching one pauses the turn
 * at the next clean boundary and asks the pupil whether to continue, and
 * continuing grants the same allotment again. A five-minute cap used to cut a
 * long answer mid-sentence; now it asks.
 *
 * The daily allowances are the hard ceilings, and they bind *during* a turn as
 * well as before one starts — so a turn cannot overshoot the class's day by a
 * whole allotment. Prior consumption is passed in, because the figure that
 * matters is the day's, not this turn's.
 *
 * Nothing here throws, and nothing here decides where the clean boundary is:
 * this reports, the loop decides (§10).
 */
export class TurnBudget {
  readonly #budgets: BudgetSettings;
  readonly #startedAt: number;
  readonly #consumed: DailyConsumption | (() => DailyConsumption);
  #steps = 0;
  #tokens = 0;
  /**
   * The running estimate for the step in flight.
   *
   * A gateway reports usage only once the response completes, so without a
   * provisional figure the token cap could not bind until after the tokens it
   * was meant to prevent had already been generated (§10).
   */
  #provisional = 0;

  /**
   * The current allotments. Each grows by one cap every time the pupil says to
   * continue, so "reached a checkpoint" stays a single comparison.
   */
  #stepLimit: number;
  #tokenLimit: number;
  #deadline: number;

  /**
   * Time spent waiting on the pupil, excluded from the elapsed figure.
   *
   * A question that took the pupil a minute to read is not a minute of the
   * model's wall clock, and counting it would make the very act of asking bring
   * the next checkpoint forward.
   */
  #waited = 0;

  #warned = false;
  #warningAcknowledged = false;

  constructor(
    budgets: BudgetSettings,
    startedAt: number = Date.now(),
    consumed: DailyConsumption | (() => DailyConsumption) = {
      studentTokens: 0,
      classroomTokens: 0,
    },
  ) {
    this.#budgets = budgets;
    this.#startedAt = startedAt;
    this.#consumed = consumed;
    this.#stepLimit = budgets.perTurnStepCap;
    this.#tokenLimit = budgets.perTurnTokenCap;
    this.#deadline = startedAt + budgets.perTurnWallClockSeconds * 1000;
  }

  /** Count a completed model round trip. A tool call and its follow-up is one step (§10, §11). */
  recordStep(): void {
    this.#steps++;
  }

  /** Count usage as the gateway reports it, or as Setun estimated it (§10). */
  recordTokens(tokens: number): void {
    this.#tokens += tokens;
  }

  /** Add to the estimate for the step in flight. Superseded by `settleStepTokens`. */
  recordProvisionalTokens(tokens: number): void {
    this.#provisional += tokens;
  }

  /** Replace the in-flight estimate with the figure the gateway reported (§10). */
  settleStepTokens(reportedTokens: number): void {
    this.#provisional = 0;
    this.#tokens += reportedTokens;
  }

  get steps(): number {
    return this.#steps;
  }

  /** Settled tokens plus whatever the step in flight is estimated to have cost. */
  get tokens(): number {
    return this.#tokens + this.#provisional;
  }

  /** How long one question may wait, and how much one "continue" grants (§10, §11). */
  get allotmentMs(): number {
    return this.#budgets.perTurnWallClockSeconds * 1000;
  }

  /** Time the model has had, with the pupil's own thinking time taken back out. */
  elapsedMs(now: number = Date.now()): number {
    return Math.max(0, now - this.#startedAt - this.#waited);
  }

  /**
   * Exclude a wait from the turn's clock.
   *
   * The deadline moves with it: a turn that spent forty seconds waiting for an
   * answer has forty seconds more before its next wall-clock checkpoint, which
   * is what "the pupil's time is not the model's time" has to mean in practice.
   */
  recordWait(ms: number): void {
    if (ms <= 0) return;
    this.#waited += ms;
    this.#deadline += ms;
  }

  /**
   * Which checkpoints have been reached, at `now`.
   *
   * All of them, not the first: continuing past a step checkpoint that also blew
   * the token allotment would otherwise stop again on the very next boundary.
   * Empty while the turn may run on.
   */
  reachedCaps(now: number = Date.now()): readonly PerTurnCap[] {
    const caps: PerTurnCap[] = [];
    if (this.#steps >= this.#stepLimit) caps.push("steps");
    if (this.tokens >= this.#tokenLimit) caps.push("tokens");
    if (now >= this.#deadline) caps.push("wall-clock");
    return caps;
  }

  /** Grant one more allotment for every checkpoint currently reached (§10). */
  extend(now: number = Date.now()): void {
    for (const cap of this.reachedCaps(now)) {
      if (cap === "steps") this.#stepLimit += this.#budgets.perTurnStepCap;
      if (cap === "tokens") this.#tokenLimit += this.#budgets.perTurnTokenCap;
      if (cap === "wall-clock") this.#deadline = now + this.allotmentMs;
    }
  }

  /** What the day has cost so far, this turn included, per layer (§10). */
  dailyUsed(): DailyConsumption {
    const consumed = typeof this.#consumed === "function" ? this.#consumed() : this.#consumed;
    return {
      studentTokens: consumed.studentTokens + this.tokens,
      classroomTokens: consumed.classroomTokens + this.tokens,
    };
  }

  /**
   * How full the *binding* daily layer is, from 0 upward.
   *
   * The higher of the two fractions: a pupil whose class is nearly out should be
   * warned about the class, and the sentence they read names the figure this
   * returns alongside.
   */
  dailyFraction(): number {
    return Math.max(
      fractionOf(this.dailyUsed().classroomTokens, this.#budgets.perClassroomDailyTokens),
      fractionOf(this.dailyUsed().studentTokens, this.#budgets.perStudentDailyTokens),
    );
  }

  /** The used/limit pair the warning quotes: whichever layer is fuller (§10). */
  dailyBinding(): { readonly usedTokens: number; readonly limitTokens: number } {
    const used = this.dailyUsed();
    const classroom = fractionOf(used.classroomTokens, this.#budgets.perClassroomDailyTokens);
    const student = fractionOf(used.studentTokens, this.#budgets.perStudentDailyTokens);

    return classroom >= student
      ? { usedTokens: used.classroomTokens, limitTokens: this.#budgets.perClassroomDailyTokens }
      : { usedTokens: used.studentTokens, limitTokens: this.#budgets.perStudentDailyTokens };
  }

  /**
   * Whether a daily ceiling has run out, mid-turn.
   *
   * Classroom first, mirroring `checkTurnBudget`: when the class ceiling is
   * reached, an individual pupil's remaining allowance is irrelevant and the
   * message they see should say so.
   */
  dailyExhausted(): DailyStop | null {
    const used = this.dailyUsed();
    if (used.classroomTokens >= this.#budgets.perClassroomDailyTokens) {
      return "classroom-cap-exhausted";
    }
    if (used.studentTokens >= this.#budgets.perStudentDailyTokens) {
      return "student-allowance-exhausted";
    }
    return null;
  }

  /**
   * Claim the one warning this turn may emit, once the day is 70 % spent.
   *
   * True exactly once: the pupil is told while the answer is still streaming,
   * and told once — a banner that reappears with every delta is noise.
   */
  takeWarning(): boolean {
    if (this.#warned) return false;
    if (this.dailyFraction() < DAILY_WARNING_FRACTION) return false;
    this.#warned = true;
    return true;
  }

  /**
   * Whether the warning was shown and nobody has said to carry on.
   *
   * "A response in flight is never cut at 70 %": the warning appears at once, and
   * the confirmation is collected at the next clean boundary instead.
   */
  get warningPending(): boolean {
    return this.#warned && !this.#warningAcknowledged;
  }

  acknowledgeWarning(): void {
    this.#warningAcknowledged = true;
  }
}

function fractionOf(used: number, limit: number): number {
  return limit > 0 ? used / limit : 0;
}
