import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { assertNoTurnInConversation, TurnInFlightError } from "$lib/server/agent/concurrency";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import {
  deleteConversation,
  getOwnedConversation,
  setActiveLeaf,
} from "$lib/server/db/queries/conversations";
import { deepestLeaf, getMessage } from "$lib/server/db/queries/messages";
import type { RequestHandler } from "./$types";

/**
 * A single conversation (PRD §10, §16).
 *
 * Deletion is owner-scoped in SQL and cascades to messages, turns and buffered
 * events through the schema — a student deleting their conversation deletes
 * everything it carried (§16).
 */

const SwitchBranchSchema = v.object({
  /** A message at a branch point; the active leaf moves to the tip below it. */
  activeLeafOf: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

/**
 * Switch which branch of the message tree the conversation reads (PRD §10).
 *
 * Editing a prompt or regenerating a reply appends a sibling and leaves the
 * older branch addressable but off-screen; this is how the pupil walks back to
 * it. Given a message at a branch point, the active leaf moves to the tip of
 * that branch, so the whole variant reappears. Owner-scoped, and the target must
 * live in this conversation — otherwise absent and not-yours are one answer.
 *
 * Refused while a turn streams: the turn moves the active leaf itself when it
 * finishes, so a switch accepted now is either silently reverted by that write
 * or silently discards the answer it was racing. The composer already hides the
 * picker mid-turn, but a second tab has not heard about the lock — so, as with
 * sending, the server is what enforces it (§10).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const parsed = v.safeParse(SwitchBranchSchema, await request.json().catch(() => null));
  if (!parsed.success) error(400, "Invalid request");

  const owned = getOwnedConversation(db, {
    conversationId: params.conversationId,
    studentId: student.id,
  });
  if (!owned) error(404, "Not found");

  try {
    assertNoTurnInConversation(db, { studentId: student.id, conversationId: owned.id });
  } catch (cause) {
    if (cause instanceof TurnInFlightError) {
      return json({ error: "turn-in-flight", activeTurnId: cause.activeTurnId }, { status: 409 });
    }
    throw cause;
  }

  const target = getMessage(db, parsed.output.activeLeafOf);
  if (!target || target.conversationId !== params.conversationId) error(404, "Not found");

  const leafId = deepestLeaf(db, target.id);
  setActiveLeaf(db, {
    conversationId: params.conversationId,
    studentId: student.id,
    messageId: leafId,
  });

  return json({ activeLeafId: leafId });
};
export const DELETE: RequestHandler = ({ params, locals }) => {
  const student = requireStudentApi(locals);

  const deleted = deleteConversation(getDb(), {
    conversationId: params.conversationId,
    studentId: student.id,
  });

  // Absent and not-yours are the same answer, so neither can be probed (§21).
  if (!deleted) error(404, "Not found");

  return json({ deleted: true });
};
