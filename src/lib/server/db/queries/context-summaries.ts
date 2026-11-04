import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type ContextSummary, contextSummary } from "../schema";

/**
 * Summaries of the start of long conversations (PRD §10).
 *
 * A summary covers everything up to and including `throughMessageId`, and is
 * valid on any path that passes through that message. The conversation is a
 * tree, so "the latest summary" is not a property of the conversation: it is
 * the deepest one on the path being sent.
 */

/** The summary covering the most of this path, or undefined when none applies. */
export function summaryForPath(
  db: AppDatabase,
  input: { conversationId: string; pathIds: readonly string[] },
): ContextSummary | undefined {
  if (input.pathIds.length === 0) return undefined;

  const rows = db
    .select()
    .from(contextSummary)
    .where(
      and(
        eq(contextSummary.conversationId, input.conversationId),
        inArray(contextSummary.throughMessageId, [...input.pathIds]),
      ),
    )
    .all();

  const depth = new Map(input.pathIds.map((id, at) => [id, at]));
  let best: ContextSummary | undefined;
  for (const row of rows) {
    const at = depth.get(row.throughMessageId) ?? -1;
    if (!best || at > (depth.get(best.throughMessageId) ?? -1)) best = row;
  }
  return best;
}

export function saveContextSummary(
  db: AppDatabase,
  input: { conversationId: string; throughMessageId: string; text: string },
): ContextSummary {
  const [row] = db.insert(contextSummary).values(input).returning().all();
  return row;
}
