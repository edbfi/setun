import * as m from "$lib/paraglide/messages";
import type { TurnNotice } from "$lib/server/db/schema";

/**
 * Why an answer stopped short, in words a pupil can act on (PRD §10, §21).
 *
 * Keyed by the server's own union, so a reason added there without a sentence
 * here fails `svelte-check` rather than reaching a classroom as a blank line —
 * the same discipline `$lib/state/refusals` follows.
 *
 * Shared between the turn as it streams and the same turn after a reload,
 * because those are two renderings of one event and a pupil who reloads must not
 * be told something different. The type import is erased at compile time.
 */
const NOTICES: Record<TurnNotice, () => string> = {
  aborted: m.chat_notice_aborted,
  interrupted: m.chat_notice_interrupted,
  error: m.chat_notice_error,
  budget: m.chat_notice_budget,
  truncated: m.chat_notice_truncated,
  "student-allowance-exhausted": m.chat_notice_student_allowance_exhausted,
  "classroom-cap-exhausted": m.chat_notice_classroom_cap_exhausted,
  unanswered: m.chat_notice_unanswered,
  "context-full": m.chat_notice_context_full,
};

export function turnNoticeText(notice: TurnNotice): string {
  return NOTICES[notice]();
}
