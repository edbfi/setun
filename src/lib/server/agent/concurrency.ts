import type { AppDatabase } from "../db/client";
import { listActiveTurns } from "../db/queries/turns";
import type { Turn } from "../db/schema";

/**
 * How many answers a pupil may have being written at once (PRD §10).
 *
 * One per conversation: a second message there would answer a path the first
 * answer is still extending, and both would move the same active leaf. And at
 * most the classroom's `maxConcurrentTurns` across all of them, so a pupil can
 * ask something else while a long build runs without a class multiplying its
 * load on the provider without bound.
 *
 * Checked on the server for every send, against the database rather than the
 * in-process registry: after a restart the registry is empty while the database
 * still holds the rows, and the guard must not be fooled by that. The send path
 * checks and creates the turn without awaiting in between, so two sends from
 * two tabs cannot both pass.
 */

/** This conversation already has an answer being written. */
export class TurnInFlightError extends Error {
  readonly activeTurnId: string;

  constructor(activeTurnId: string) {
    super("a turn is already in flight in this conversation");
    this.name = "TurnInFlightError";
    this.activeTurnId = activeTurnId;
  }
}

/** The pupil already has as many answers being written as the classroom allows. */
export class TurnLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super("the student has as many turns in flight as the classroom allows");
    this.name = "TurnLimitError";
    this.limit = limit;
  }
}

/** The student's in-flight turns across every conversation, oldest first. */
export function getActiveTurns(db: AppDatabase, studentId: string): Turn[] {
  return listActiveTurns(db, studentId);
}

/**
 * Refuse a new turn in a conversation that has one, or past the classroom's limit.
 *
 * The conversation's own turn travels with the error so the client can say
 * which answer to wait for or stop.
 */
export function assertTurnCapacity(
  db: AppDatabase,
  input: { studentId: string; conversationId: string; limit: number },
): void {
  const active = getActiveTurns(db, input.studentId);
  const here = active.find((turn) => turn.conversationId === input.conversationId);
  if (here) throw new TurnInFlightError(here.id);
  if (active.length >= Math.max(1, input.limit)) throw new TurnLimitError(input.limit);
}

/** Refuse while this conversation has an answer being written. */
export function assertNoTurnInConversation(
  db: AppDatabase,
  input: { studentId: string; conversationId: string },
): void {
  const here = getActiveTurns(db, input.studentId).find(
    (turn) => turn.conversationId === input.conversationId,
  );
  if (here) throw new TurnInFlightError(here.id);
}
