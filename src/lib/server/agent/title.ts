import type { AppDatabase } from "../db/client";
import { setConversationTitle } from "../db/queries/conversations";
import { getUtilityAlias } from "../db/queries/model-aliases";
import { classroomDailyConsumption, recordUsageEvent } from "../db/queries/usage";
import type { Classroom, ModelAlias } from "../db/schema";
import type { GatewayAdapter } from "../gateway/adapter";
import { budgetDayRange, budgetsOf, mayRunUtilityWork } from "./budgets";

/**
 * Conversation titles (PRD §10).
 *
 * "Conversation titles are generated asynchronously by the utility alias after
 * the first exchange, falling back to a truncation of the first user message."
 *
 * Utility work counts toward the per-classroom daily cap but never a student's
 * personal allowance, so its usage event records a null student — and when that
 * cap is exhausted the work is skipped and the fallback used (§10).
 *
 * The first message is the pupil's words, so it may only go where the
 * conversation already sends them under the same terms: a conversation on a
 * model with a data processing agreement is titled by the utility alias only
 * when that alias has one too, and otherwise by the conversation's own model
 * (§9, §16).
 */

const MAX_TITLE_LENGTH = 60;

const TITLE_INSTRUCTION = [
  "Write a short title for a conversation that begins with the message below.",
  "Five words at most. No quotation marks, no trailing punctuation, no preamble.",
  "Reply with the title only, in the same language as the message.",
].join(" ");

/**
 * Truncate a first message into a title.
 *
 * Always available and never fails, which is what makes it the fallback for
 * every path below: no utility alias configured, a gateway failure, or an empty
 * answer.
 */
export function fallbackTitle(firstMessage: string): string {
  const collapsed = firstMessage.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;

  const truncated = collapsed.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  // Cut at a word boundary when there is a reasonable one.
  return `${lastSpace > MAX_TITLE_LENGTH / 2 ? truncated.slice(0, lastSpace) : truncated}…`;
}

function tidy(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'«»„“]+|["'«»„“.]+$/g, "")
    .trim();
  return cleaned.length > MAX_TITLE_LENGTH ? fallbackTitle(cleaned) : cleaned;
}

type TitleAlias = Pick<
  ModelAlias,
  "id" | "dialect" | "gatewayModelId" | "available" | "dataProtection"
>;

/**
 * The model that may title a conversation, or null for the fallback.
 *
 * The utility alias, unless it would take a protected conversation's words
 * somewhere without an agreement; then the conversation's own model, which
 * already reads them.
 */
export function titlingAlias(
  utility: TitleAlias | undefined,
  conversation: TitleAlias,
): TitleAlias | null {
  if (!utility?.available) return null;
  if (utility.dataProtection || !conversation.dataProtection) return utility;
  return conversation.available ? conversation : null;
}

/**
 * Generate and store a title, falling back on any failure.
 *
 * Runs detached from the student's turn: a title is a convenience, and nothing
 * about it may delay or break the conversation it names.
 */
export async function generateConversationTitle(input: {
  db: AppDatabase;
  adapter: GatewayAdapter;
  conversationId: string;
  studentId: string;
  classroom: Classroom;
  /** The conversation's own model: its terms bound where the first message may go. */
  conversationAlias: TitleAlias;
  firstMessage: string;
  now?: Date;
}): Promise<string> {
  const { db, classroom } = input;
  const now = input.now ?? new Date();
  const fallback = fallbackTitle(input.firstMessage);
  const titler = titlingAlias(getUtilityAlias(db), input.conversationAlias);

  // "When the classroom cap is exhausted, utility work is skipped and its
  // fallback used" (§10) — a title is never worth the last of a class's day.
  const range = budgetDayRange(classroom.timezone, now);
  const classroomTokens = classroomDailyConsumption(db, {
    classroomId: classroom.id,
    from: range.start,
    until: range.end,
  });
  const affordable = mayRunUtilityWork(budgetsOf(classroom), { classroomTokens });

  if (!titler || !affordable) {
    setConversationTitle(db, {
      conversationId: input.conversationId,
      studentId: input.studentId,
      title: fallback,
    });
    return fallback;
  }

  let generated = "";
  try {
    for await (const event of input.adapter.streamChat(titler.dialect, {
      model: titler.gatewayModelId,
      messages: [
        { role: "system", content: TITLE_INSTRUCTION },
        { role: "user", content: input.firstMessage.slice(0, 2_000) },
      ],
    })) {
      if (event.type === "text-delta") generated += event.text;
      if (event.type === "usage") {
        // Null student: the classroom cap only, never a personal allowance (§10).
        recordUsageEvent(db, {
          classroomId: classroom.id,
          studentId: null,
          modelAliasId: titler.id,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimated: event.estimated,
        });
      }
    }
  } catch {
    // Any gateway failure falls back silently; the student never learns that a
    // title call happened at all (§9, §21).
    generated = "";
  }

  const title = tidy(generated) || fallback;
  setConversationTitle(db, {
    conversationId: input.conversationId,
    studentId: input.studentId,
    title,
  });
  return title;
}
