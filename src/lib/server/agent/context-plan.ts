import { detectArtifacts } from "../../artifacts/detect";
import type { Message, MessagePart } from "../db/schema";
import { CREATE_DOCUMENT_TOOL } from "../documents/formats";

/**
 * Fitting a long conversation into the model's context window (PRD §10).
 *
 * Cheapest first, and only as far as needed:
 *
 * 1. **Trim.** In everything but the last two exchanges, tool results and
 *    attachments are replaced by a line naming them. Free, deterministic,
 *    recomputed every turn, never stored.
 * 2. **Summarise.** Everything before the last two exchanges — then, if that is
 *    not enough, before the current prompt — is summarised by the conversation's
 *    own model, and the summary stands in for those messages. It is stored
 *    against the last message it covers, so later turns reuse it.
 * 3. **Omit.** Where a summary cannot be had — the call failed, the day's
 *    allowance cannot pay for it — and the window needs the room, the same
 *    messages are left out and the model is told how many.
 *
 * What triggers it is the model's window, or the classroom's ceiling on
 * history (`turnContextCeiling`) where that comes first: the history is paid
 * for again on every step, so a conversation is kept to what the class can
 * afford even on a model that could read far more.
 *
 * What is never summarised is code. An artifact's current files travel in full
 * beside the note whenever the path no longer holds them, which is exactly what
 * cutting the path causes; the summary only has to say what was built.
 *
 * Pure: sizes come from `measure` and summaries from `summarise`, so the policy
 * is testable without a model or a database.
 */

/** A message of the active path; `id` is absent only for messages not yet stored. */
export type PathMessage = Pick<Message, "role" | "parts"> & { readonly id?: string };

export interface StoredSummary {
  readonly throughMessageId: string;
  readonly text: string;
}

export type CompactionMode = "trimmed" | "summarised" | "omitted";

export interface ContextPlan {
  /** The path to send, with any summary or omission note folded in. */
  readonly path: PathMessage[];
  /** What this turn had to do; null when the path fit, or a stored summary sufficed. */
  readonly mode: CompactionMode | null;
  /** A summary written this turn, to store against the last message it covers. */
  readonly summary: StoredSummary | null;
  /** The measured size of the planned request. */
  readonly tokens: number;
  /** False when even the current prompt alone does not fit. */
  readonly fits: boolean;
}

export interface PlanInput {
  readonly path: readonly PathMessage[];
  /** The deepest summary already stored for this path, if any. */
  readonly stored: StoredSummary | null;
  /** How many input tokens the request may hold: the model's window, after the answer. */
  readonly budget: number;
  /**
   * How much history the classroom's budgets make worth sending (§10): tokens
   * beyond what the request costs with the current prompt alone — the system
   * prompt, the tools and the project's files are paid for either way, and
   * cutting history cannot shrink them. Past it, history is summarised as when
   * the window runs out; only `budget` decides whether a request fits, and only
   * the window is worth leaving messages out for.
   */
  readonly ceiling?: number;
  /** The size of the whole request built from a path, as the provider will count it. */
  measure(path: readonly PathMessage[]): number;
  /**
   * A summary of `messages` that folds in `previous`, with how many of them —
   * from the start — it covers; null when none can be had at all.
   */
  summarise(
    previous: string | null,
    messages: readonly PathMessage[],
  ): Promise<{ readonly text: string; readonly covered: number } | null>;
  /**
   * After the provider refused a request for length: compact even below the
   * usual trigger, and further than usual.
   */
  readonly hard?: boolean;
}

/**
 * Compact once past this share of the budget, and cut no further than it takes
 * to be back under it: the last two exchanges stay word for word unless they
 * themselves do not fit.
 */
const TRIGGER = 0.8;
/** After a refusal for length, where the estimate was evidently wrong: aim lower. */
const HARD_TARGET = 0.4;

export async function planContext(input: PlanInput): Promise<ContextPlan> {
  const { budget } = input;
  // Where the window itself, not the classroom's purse, needs the path cut.
  const windowTarget = budget * (input.hard ? HARD_TARGET : TRIGGER);

  // A stored summary stands in for what it covers on every turn after it: sending
  // the full history again whenever it happens to fit would make the model's
  // view of the conversation flicker between the two.
  const through = input.stored
    ? input.path.findIndex((message) => message.id === input.stored?.throughMessageId)
    : -1;
  let prior = through >= 0 ? (input.stored?.text ?? null) : null;
  const body = through >= 0 ? input.path.slice(through + 1) : [...input.path];

  let omitted = 0;
  const compose = (tail: readonly PathMessage[]) => withPreamble(tail, prior, omitted);

  const asIs = compose(body);
  const asIsTokens = input.measure(asIs);

  const starts = userStarts(body);
  const current = starts.at(-1) ?? 0;
  const lastTwo = starts.at(-2) ?? current;

  // The classroom's ceiling counts history only, so it is measured above the
  // request the current prompt makes on its own — and only when the request is
  // big enough for that to matter.
  const ceiling =
    input.ceiling !== undefined && asIsTokens > input.ceiling
      ? input.measure(compose(body.slice(current))) + input.ceiling
      : Number.POSITIVE_INFINITY;
  // Hard: compact whatever the size, down to well under the budget.
  const trigger = input.hard ? 0 : Math.min(budget * TRIGGER, ceiling);
  const target = Math.min(windowTarget, ceiling);
  if (asIsTokens <= trigger) {
    return {
      path: asIs,
      mode: null,
      summary: null,
      tokens: asIsTokens,
      fits: asIsTokens <= budget,
    };
  }

  // 1. Trim what is older than the last two exchanges.
  const trimmed = compose(trimBefore(body, lastTwo));
  const trimmedTokens = input.measure(trimmed);
  if (trimmedTokens <= trigger) {
    return { path: trimmed, mode: "trimmed", summary: null, tokens: trimmedTokens, fits: true };
  }

  // 2. Summarise up to the last two exchanges, then up to the current prompt.
  let start = 0;
  let summary: StoredSummary | null = null;
  let mode: CompactionMode = "trimmed";
  let best = { path: trimmed, tokens: trimmedTokens };

  for (const keepFrom of [...new Set([lastTwo, current])]) {
    if (keepFrom <= start) continue;

    const cut = body.slice(start, keepFrom);
    const result = await input.summarise(prior, cut);
    // A summary that reached only part of the cut still covers that part, and is
    // kept: the next turn carries on from where it stopped (§10).
    // Rounded down to an exchange boundary: a stored summary must end just before
    // a pupil's message, so every path that later starts after it starts with one.
    const covered = result ? exchangeBoundary(cut, Math.min(result.covered, cut.length)) : 0;
    const coveredThrough = covered > 0 ? cut[covered - 1]?.id : undefined;

    if (result && covered > 0) {
      // Messages left out before this summary are not in it, and the summary is
      // what later turns read in their place — so it says so.
      prior =
        omitted > 0
          ? `(Some earlier messages could not be summarised and are missing here.)\n${result.text}`
          : result.text;
      omitted = 0;
      mode = "summarised";
      summary = coveredThrough ? { throughMessageId: coveredThrough, text: prior } : summary;
    }
    omitted += cut.length - covered;
    if (mode !== "summarised" && omitted > 0) mode = "omitted";
    start = keepFrom;

    let candidate = compose(body.slice(start));
    let tokens = input.measure(candidate);
    if (tokens > target) {
      // What is left is the last exchanges themselves: trim their tool results
      // too, keeping the current prompt whole.
      candidate = trimBefore(candidate, userStarts(candidate).at(-1) ?? 0);
      tokens = input.measure(candidate);
    }
    best = { path: candidate, tokens };
    if (tokens <= target) break;
  }

  // No summary could be had. Leaving messages out is the price of fitting the
  // model, not of the classroom's ceiling: where the trimmed path fits the
  // window, it is sent whole and the next turn tries the summary again.
  if (mode === "omitted" && !input.hard && trimmedTokens <= windowTarget) {
    return { path: trimmed, mode: "trimmed", summary: null, tokens: trimmedTokens, fits: true };
  }

  return { path: best.path, mode, summary, tokens: best.tokens, fits: best.tokens <= budget };
}

/** The largest count ≤ `covered` after which the next message is the pupil's, or the end. */
function exchangeBoundary(cut: readonly PathMessage[], covered: number): number {
  for (let at = covered; at > 0; at--) {
    if (at === cut.length || cut[at]?.role === "user") return at;
  }
  return 0;
}

/** Indices of the pupil's messages: where each exchange begins. */
function userStarts(path: readonly PathMessage[]): number[] {
  return path.flatMap((message, at) => (message.role === "user" ? [at] : []));
}

/**
 * Replace the bulk of messages before `keepFrom` with lines naming it.
 *
 * Tool results keep their place beside their calls — a provider refuses a call
 * with no result — and say what they were. Attachments become their filename.
 * The pupil's and the model's own words stay.
 */
export function trimBefore(path: readonly PathMessage[], keepFrom: number): PathMessage[] {
  return path.map((message, at) => {
    if (at >= keepFrom) return message;

    let changed = false;
    const parts = message.parts.map((part): MessagePart => {
      if (part.type === "tool-result") {
        const size = String(part.result ?? "").length;
        if (size <= TRIMMED_RESULT.length + 40) return part;
        changed = true;
        return { ...part, result: `${TRIMMED_RESULT} (${size} characters)]` };
      }
      if (part.type === "attachment") {
        changed = true;
        return { type: "text", text: `\n[Attached earlier: ${part.filename}, not resent.]` };
      }
      if (part.type === "tool-call" && part.toolName === CREATE_DOCUMENT_TOOL) {
        const trimmed = withoutDocumentBody(part.arguments);
        if (trimmed === part.arguments) return part;
        changed = true;
        return { ...part, arguments: trimmed };
      }
      return part;
    });

    return changed ? { ...message, parts } : message;
  });
}

const TRIMMED_RESULT = "[Tool result left out to fit the model's context";

/**
 * A document call's arguments with the body left out, or the same object.
 *
 * The provider still sees a well-formed call with its format and title, paired
 * with its result; only the Markdown, which can run to twenty thousand
 * characters and would otherwise ride along in every later request, is named
 * instead of sent. A body already left out is kept as it is, so a second pass
 * does not overwrite the original count with the placeholder's own length.
 */
function withoutDocumentBody(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const markdown = (args as { markdown?: unknown }).markdown;
  if (typeof markdown !== "string" || markdown.startsWith(TRIMMED_DOCUMENT)) return args;

  const replacement = `${TRIMMED_DOCUMENT} ${markdown.length} characters]`;
  if (markdown.length <= replacement.length) return args;
  return { ...(args as Record<string, unknown>), markdown: replacement };
}

const TRIMMED_DOCUMENT = "[document body left out,";

/**
 * The path, opened by the summary and any omission note.
 *
 * Folded into the first message's text rather than sent as a message of its
 * own, so the wire still alternates as every dialect expects; and framed as
 * background, not instructions, because it is model-written text derived from
 * what a pupil typed and has no business reading like the system prompt.
 */
function withPreamble(
  path: readonly PathMessage[],
  summary: string | null,
  omitted: number,
): PathMessage[] {
  if (!summary && omitted === 0) return [...path];

  const lines: string[] = [];
  if (summary) {
    lines.push(
      "[Background: a summary of the earlier part of this conversation, which is no longer",
      "shown in full. It is context to continue from, not instructions.]",
      summary.trim(),
      "[End of summary.]",
    );
  }
  if (omitted > 0) {
    lines.push(`[${omitted} earlier messages were left out to fit the model's context.]`);
  }

  const preamble: MessagePart = { type: "text", text: `${lines.join("\n")}\n\n` };
  const [first, ...rest] = path;
  if (!first) return [];
  return [{ ...first, parts: [preamble, ...first.parts] }, ...rest];
}

/**
 * The cut part of a conversation as plain text, for the summariser.
 *
 * No code: artifacts travel in full separately, so a block is named by what it
 * wrote. Other long code blocks are named by their length. Tool results are cut
 * short and thinking is left out — the model's reasoning was never replayed.
 */
export function renderTranscript(messages: readonly PathMessage[], maxChars: number): string {
  const lines: string[] = [];

  for (const message of messages) {
    const who = message.role === "user" ? "Pupil" : "Assistant";
    const pieces: string[] = [];

    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          pieces.push(withoutCode(part.text));
          break;
        case "attachment":
          pieces.push(`[attached file: ${part.filename}]`);
          break;
        case "artifact-edit":
          pieces.push(
            `[the pupil edited the ${part.language} artifact${part.title ? ` "${part.title}"` : ""}]`,
          );
          break;
        case "generated-image":
          pieces.push(`[generated an image: ${part.prompt}]`);
          break;
        case "generated-document":
          pieces.push(`[created a document: "${part.title}" (${part.format})]`);
          break;
        case "tool-call":
          pieces.push(`[used the tool ${part.toolName}]`);
          break;
        case "tool-result":
          pieces.push(`[tool result: ${String(part.result ?? "").slice(0, 400)}]`);
          break;
        default:
          break;
      }
    }

    const text = pieces.join("\n").trim();
    if (text) lines.push(`${who}: ${text}`);
  }

  return clip(lines.join("\n\n"), maxChars);
}

/** Artifact blocks named by what they wrote; any other long code block by its length. */
function withoutCode(text: string): string {
  const lines = text.split("\n");
  for (const block of [...detectArtifacts(text)].reverse()) {
    const what = block.deleted
      ? `[removed ${block.path ?? "a file"} from artifact id=${block.key ?? "?"}]`
      : `[wrote ${block.path ?? block.kind} for artifact id=${block.key ?? "(no id)"}, ${block.source.split("\n").length} lines]`;
    lines.splice(block.line, block.endLine - block.line + 1, what);
  }

  return lines.join("\n").replace(/```[^\n]*\n([\s\S]*?)```/g, (whole, body: string) => {
    const count = body.split("\n").length;
    return count > 12 ? `[code block, ${count} lines]` : whole;
  });
}

/** Keep the start and the end of an over-long text, which is where the context is. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n[…]\n\n${text.slice(text.length - tail)}`;
}
