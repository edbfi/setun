import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Turn, type TurnStatus, turn, turnEvent } from "../schema";

/**
 * Turn rows and their buffered event streams (PRD §10).
 *
 * `streaming` is the only non-terminal status, so it is what "in flight" means
 * for the one-turn-per-student rule and for the boot-time interrupted sweep.
 */

const TERMINAL_STATUSES = ["completed", "aborted", "interrupted", "failed"] as const;

export function createTurn(
  db: AppDatabase,
  input: { conversationId: string; studentId: string; parentMessageId: string | null },
): Turn {
  const [row] = db.insert(turn).values(input).returning().all();
  return row;
}

export function getTurn(db: AppDatabase, turnId: string): Turn | undefined {
  return db.select().from(turn).where(eq(turn.id, turnId)).get();
}

/** Scoped by owner: a turn id from another student resolves to undefined (§21). */
export function getOwnedTurn(
  db: AppDatabase,
  input: { turnId: string; studentId: string },
): Turn | undefined {
  return db
    .select()
    .from(turn)
    .where(and(eq(turn.id, input.turnId), eq(turn.studentId, input.studentId)))
    .get();
}

/**
 * The student's in-flight turns, oldest first, across all of their conversations.
 *
 * At most one per conversation and the classroom's limit in all, enforced by
 * the server — not the composer (§10).
 */
export function listActiveTurns(db: AppDatabase, studentId: string): Turn[] {
  return db
    .select()
    .from(turn)
    .where(and(eq(turn.studentId, studentId), eq(turn.status, "streaming")))
    .orderBy(turn.createdAt)
    .all();
}

export function finishTurn(
  db: AppDatabase,
  input: { turnId: string; status: TurnStatus; assistantMessageId?: string | null },
): void {
  db.update(turn)
    .set({
      status: input.status,
      endedAt: new Date(),
      ...(input.assistantMessageId === undefined
        ? {}
        : { assistantMessageId: input.assistantMessageId }),
    })
    .where(eq(turn.id, input.turnId))
    .run();
}

/**
 * Mark every still-streaming turn interrupted.
 *
 * Run at boot: a restart leaves rows that no process is producing any more, and
 * resume must show a friendly cut-short notice rather than hang (§10).
 * Returns the number of turns swept.
 */
export function markStreamingTurnsInterrupted(db: AppDatabase): number {
  const rows = db
    .update(turn)
    .set({ status: "interrupted", endedAt: new Date() })
    .where(eq(turn.status, "streaming"))
    .returning({ id: turn.id })
    .all();
  return rows.length;
}

export function isTerminal(status: TurnStatus): boolean {
  return (TERMINAL_STATUSES as readonly TurnStatus[]).includes(status);
}

/** Buffered events after `afterSeq`, in order — the replay half of resume (§10). */
export function listTurnEvents(
  db: AppDatabase,
  input: { turnId: string; afterSeq: number },
): { seq: number; payload: unknown }[] {
  return db
    .select({ seq: turnEvent.seq, payload: turnEvent.payload })
    .from(turnEvent)
    .where(and(eq(turnEvent.turnId, input.turnId), gt(turnEvent.seq, input.afterSeq)))
    .orderBy(asc(turnEvent.seq))
    .all();
}

export function appendTurnEvent(
  db: AppDatabase,
  input: { turnId: string; seq: number; payload: unknown },
): void {
  db.insert(turnEvent)
    .values({ turnId: input.turnId, seq: input.seq, payload: input.payload })
    .run();
}

/** Turns still streaming among the given ids — used to reconcile client state. */
export function filterStreamingTurns(db: AppDatabase, turnIds: string[]): string[] {
  if (turnIds.length === 0) return [];
  return db
    .select({ id: turn.id })
    .from(turn)
    .where(and(inArray(turn.id, turnIds), eq(turn.status, "streaming")))
    .all()
    .map((row) => row.id);
}
