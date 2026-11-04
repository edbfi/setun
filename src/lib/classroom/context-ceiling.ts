/**
 * How much history a turn should carry, by what the classroom can afford (PRD §10).
 *
 * The whole conversation is sent again on every step of every turn, so its size
 * is a cost paid over and over: on a model with a large window, a long chat
 * could spend a pupil's day in one question. A quarter of the smaller of the
 * per-turn cap and the pupil's daily allowance leaves room for several steps
 * before the turn's checkpoint, and for several turns in a day.
 *
 * Past it, the start of the conversation is summarised, exactly as when the
 * model's window is what runs out — the model's window still binds when it is
 * the smaller of the two. No setting of its own: it follows the budgets the
 * educator already sets.
 *
 * Shared, so the budget panel can say what the figures it shows imply.
 */

/** The share of the binding allowance a turn's history may fill. */
const SHARE = 0.25;

/**
 * Never below this: the system prompt and tool definitions alone can come near
 * it, and a ceiling under them would summarise on every turn to no purpose.
 */
export const MIN_CONTEXT_CEILING = 8_000;

export function turnContextCeiling(budgets: {
  readonly perTurnTokenCap: number;
  readonly perStudentDailyTokens: number;
}): number {
  const binding = Math.min(budgets.perTurnTokenCap, budgets.perStudentDailyTokens);
  return Math.max(MIN_CONTEXT_CEILING, Math.floor(binding * SHARE));
}
