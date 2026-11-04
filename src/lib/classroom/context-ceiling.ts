/**
 * How much history a turn should carry, by what the classroom can afford (PRD §10).
 *
 * The whole conversation is sent again on every step of every turn, so its size
 * is a cost paid over and over: on a model with a large window, a long chat
 * could spend a pupil's day in one question. A quarter of the smaller of the
 * per-turn cap and the pupil's daily allowance leaves room for several steps
 * before the turn's checkpoint, and for several turns in a day.
 *
 * History only: what the request costs with the current prompt alone — the
 * system prompt, the tools, the project's files — is paid for either way, and
 * summarising cannot shrink it. Past the ceiling, the start of the conversation
 * is summarised, exactly as when the model's window is what runs out; the
 * window still binds when it comes first. No setting of its own: it follows the
 * budgets the educator already sets.
 *
 * Shared, so the budget panel can say what the figures it shows imply.
 */

/** The share of the binding allowance a turn's history may fill. */
const SHARE = 0.25;

/** Never below this: a few exchanges of memory, whatever the budgets. */
export const MIN_CONTEXT_CEILING = 8_000;

export function turnContextCeiling(budgets: {
  readonly perTurnTokenCap: number;
  readonly perStudentDailyTokens: number;
}): number {
  const binding = Math.min(budgets.perTurnTokenCap, budgets.perStudentDailyTokens);
  return Math.max(MIN_CONTEXT_CEILING, Math.floor(binding * SHARE));
}
