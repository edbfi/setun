import { classroomStateChannel } from "../classroom/state-channel";
import type { AppDatabase } from "../db/client";
import { getClassroom } from "../db/queries/classrooms";
import { saveContextSummary, summaryForPath } from "../db/queries/context-summaries";
import { setActiveLeaf } from "../db/queries/conversations";
import { attachImageToMessage } from "../db/queries/images";
import { appendMessage, recordMessageUsage } from "../db/queries/messages";
import { finishTurn } from "../db/queries/turns";
import { recordUsageEvent } from "../db/queries/usage";
import type {
  MessagePart,
  ModelAlias,
  PermissionMode,
  ThinkingVisibility,
  TurnNotice,
} from "../db/schema";
import type { GatewayAdapter } from "../gateway/adapter";
import type { GatewayEvent } from "../gateway/events";
import { describeCause, log } from "../logging";
import type { AttachmentPayload } from "../storage/attachments";
import { type ArtifactContext, buildArtifactContext, CARRIED_MAX_CHARS } from "./artifact-context";
import { recordTurnArtifacts } from "./artifacts";
import {
  BUDGET_PRESETS,
  type BudgetSettings,
  budgetDayRange,
  type DailyBudgetLease,
  type DailyConsumption,
} from "./budgets";
import { createSummariser } from "./compaction";
import { type PathMessage, planContext } from "./context-plan";
import {
  CHARS_PER_ESTIMATED_TOKEN,
  type ContextWindow,
  inputBudget,
  learnContextCeiling,
  requestTokens,
  resolveContextWindow,
  sentOutputCeiling,
} from "./context-window";
import { claimDailyBudget } from "./daily-budget";
import { turnInteractions } from "./interactions";
import { liveTurns } from "./live-turns";
import { assembleContext, runTurn } from "./loop";
import type { SystemPromptLayers } from "./system-prompt";
import type { ToolContext, ToolSet } from "./tools";
import { TurnBuffer } from "./turn-buffer";

/**
 * Turn execution: the loop wired to persistence and the live registry (PRD §10).
 *
 * Runs detached from the request that started it. A student who closes the tab
 * mid-turn must be able to resume it, which cannot work if the turn's lifetime
 * is the HTTP request's — so the endpoint starts this and then merely tails it,
 * exactly as a resume does.
 *
 * What the turn produced is derived from the event stream rather than tracked
 * alongside it, so a resumed turn replaying the buffer reconstructs exactly what
 * a live one persisted (§10, §11).
 */

export interface ExecuteTurnInput {
  readonly db: AppDatabase;
  readonly adapter: GatewayAdapter;
  readonly turnId: string;
  readonly conversationId: string;
  readonly studentId: string;
  readonly classroomId: string;
  readonly alias: ModelAlias;
  readonly parentMessageId: string | null;
  /** The active path; stored messages carry their ids, which summaries are keyed by (§10). */
  readonly path: readonly PathMessage[];
  readonly attachmentPayloads?: ReadonlyMap<string, AttachmentPayload>;
  readonly promptLayers?: SystemPromptLayers;
  /** What this conversation has built, for the state note and the elision (§13). */
  readonly artifacts?: ArtifactContext;
  /** The classroom's per-turn caps; the loop stops the turn at a clean boundary (§10). */
  readonly budgets?: BudgetSettings;
  /** What the day has already cost, so the hard ceilings bind mid-turn (§10). */
  readonly consumed?: DailyConsumption;
  /** The turn's tools and the mode that governs them; absent for plain chat (§11). */
  readonly tools?: ToolSet;
  readonly toolContext?: ToolContext;
  readonly permissionMode?: PermissionMode;
  /**
   * Whether the model's reasoning may reach this pupil (§20, §21).
   *
   * `hidden` drops the events here, before the turn is buffered — so nothing is
   * persisted, nothing is published to a tailing tab, and nothing is there for a
   * resume or a devtools panel to find. Hiding a block in the interface would
   * not be enforcement.
   */
  readonly thinkingVisibility?: ThinkingVisibility;
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  toolCalls: number;
}

/**
 * Execute a turn to completion, buffering every event.
 *
 * Resolves when the turn reaches a terminal state; the caller may ignore the
 * promise, and the endpoint does.
 */
export async function executeTurn(input: ExecuteTurnInput): Promise<void> {
  const { db, turnId } = input;
  const signal = liveTurns.register(turnId);
  const buffer = new TurnBuffer(db, turnId);
  const startedAt = performance.now();
  let dailyBudget: DailyBudgetLease | undefined;

  const parts: MessagePart[] = [];
  const imageIds: string[] = [];
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, estimated: false, toolCalls: 0 };
  let status: "completed" | "aborted" | "failed" = "completed";
  /** Calls the student was asked about, so the result can record what they said (§19). */
  const asked = new Map<string, number>();

  try {
    const classroom = getClassroom(db, input.classroomId);
    dailyBudget = claimDailyBudget({
      db,
      classroomId: input.classroomId,
      studentId: input.studentId,
      range: budgetDayRange(classroom?.timezone ?? "UTC"),
      budgets: input.budgets ?? BUDGET_PRESETS.standard,
    });

    /** An event of the turn's own making — the stage, the summary's cost — recorded like any other. */
    const emit = (event: GatewayEvent) => {
      collect({ event, parts, imageIds, usage, asked });
      const buffered = buffer.append(event);
      liveTurns.publish({ turnId, buffered });
    };

    // Fit the conversation to the model before the first request, and once more,
    // harder, if the provider refuses it for length anyway (§10). One count of
    // summary calls for the whole turn, however many passes that takes.
    const summaryCalls = { count: 0 };
    let plan = await planTurnContext({
      input,
      window: await resolveContextWindow(input.adapter, input.alias),
      dailyBudget,
      signal,
      emit,
      summaryCalls,
      hard: false,
    });
    // Known not to fit: compact harder now rather than send it to be refused.
    if (!plan.fits) {
      plan = await planTurnContext({
        input,
        window: await resolveContextWindow(input.adapter, input.alias),
        dailyBudget,
        signal,
        emit,
        summaryCalls,
        hard: true,
      });
    }

    for (let attempt = 0; ; attempt++) {
      let retry = false;

      for await (const event of runTurn({
        adapter: input.adapter,
        dialect: input.alias.dialect,
        model: input.alias.gatewayModelId,
        path: plan.path,
        attachmentPayloads: input.attachmentPayloads,
        promptLayers: input.promptLayers,
        artifacts: plan.artifacts,
        contextBudget: {
          inputTokens: plan.budget,
          aliasId: input.alias.id,
          maxOutputTokens: plan.maxOutputTokens,
        },
        budgets: input.budgets,
        consumed: input.consumed,
        dailyBudget,
        signal,
        ...(input.tools && input.toolContext
          ? {
              tooling: {
                tools: input.tools,
                context: input.toolContext,
                mode: input.permissionMode ?? "standard",
                turnId,
                interactions: turnInteractions,
              },
            }
          : {}),
      })) {
        // Dropped before anything else sees it: the classroom said never (§21).
        if (event.type === "thinking-delta" && input.thinkingVisibility === "hidden") continue;

        // Refused for length before a word of the answer: held back, not shown,
        // and asked again once with a harder compaction. Past that, or once the
        // answer has begun, the pupil is told instead.
        //
        // Only when the plan said it fit: then the refusal is news about the
        // window, worth learning and worth one more try. A request the estimate
        // already put over budget — a pasted book, say — was sent on the chance
        // the estimate was generous, and its refusal teaches nothing.
        if (
          event.type === "done" &&
          event.reason === "context-full" &&
          attempt === 0 &&
          plan.fits &&
          parts.every((part) => part.type === "context-compacted")
        ) {
          retry = true;
          break;
        }

        collect({ event, parts, imageIds, usage, asked });

        if (event.type === "done") {
          status = terminalStatusFor(event);
          // The reason travels with the message, not only down the wire. The
          // client's live copy is cleared the instant the persisted message
          // replaces the streaming one, so a pupil whose turn was stopped or
          // capped had nothing left to read — then, or on the next visit (§10).
          const notice = noticeFor(event);
          if (notice) parts.push({ type: "turn-notice", notice });
        }

        // Persist first, then publish: a tailing subscriber must never see an
        // event that a resuming reader could miss (§10).
        const buffered = buffer.append(event);
        liveTurns.publish({ turnId, buffered });
      }

      if (!retry) break;

      // The provider knows the window better than the estimate did — when the
      // request was big enough for its refusal to be about the window at all.
      learnContextCeiling(input.alias.id, plan.tokens, plan.budget);
      plan = await planTurnContext({
        input,
        window: await resolveContextWindow(input.adapter, input.alias),
        dailyBudget,
        signal,
        emit,
        summaryCalls,
        hard: true,
      });
    }

    persistOutcome({ ...input, parts, imageIds, usage, status });
    logTurn(input, { status, usage, startedAt });
  } catch (cause) {
    // The loop converts failures into events, so reaching here means the
    // persistence path itself failed. Terminate the turn rather than leaving a
    // row that resume would wait on forever.
    buffer.append({ type: "error", message: "unavailable" });
    buffer.append({ type: "done", reason: "error" });
    finishTurn(db, { turnId, status: "failed" });
    log.error("turn execution failed", { turnId, cause: describeCause(cause) });
    logTurn(input, { status: "failed", usage, startedAt });
  } finally {
    dailyBudget?.release();
    liveTurns.end(turnId);
    // Whatever the turn declared answerable — a checkpoint, the warning banner's
    // button — dies with it, so a late click cannot be held against the next one.
    turnInteractions.release(turnId);
  }
}

/**
 * Fold one event into what the turn produced.
 *
 * Text accumulates into a single trailing part rather than one part per delta:
 * a message of ten thousand one-character parts is the same message and a much
 * worse row.
 */
function collect(args: {
  event: GatewayEvent;
  parts: MessagePart[];
  imageIds: string[];
  usage: TurnUsage;
  /** Index in `parts` of each call the student was asked about. */
  asked: Map<string, number>;
}): void {
  const { event, parts } = args;

  switch (event.type) {
    case "text-delta": {
      const last = parts.at(-1);
      if (last?.type === "text") {
        parts[parts.length - 1] = { type: "text", text: last.text + event.text };
      } else {
        parts.push({ type: "text", text: event.text });
      }
      break;
    }
    case "thinking-delta": {
      // Grown into one trailing part, exactly as text is, and for the same
      // reason: a summary arriving in eighty fragments is one summary.
      const last = parts.at(-1);
      if (last?.type === "thinking") {
        parts[parts.length - 1] = { type: "thinking", text: last.text + event.text };
      } else {
        parts.push({ type: "thinking", text: event.text });
      }
      break;
    }
    case "permission-request": {
      // The call is recorded the moment it is asked about, so a declined one is
      // in the transcript at all — no `tool-call-started` ever follows it (§19).
      args.asked.set(event.toolCallId, parts.length);
      parts.push({
        type: "tool-call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        serverLabel: event.serverLabel ?? null,
        arguments: event.arguments,
        decision: "approved",
      });
      break;
    }
    case "tool-call-started": {
      args.usage.toolCalls++;
      // A call that was asked about is already in the list, with the arguments
      // the student saw; one the mode ran without asking is added here.
      if (args.asked.has(event.toolCallId)) break;

      parts.push({
        type: "tool-call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        serverLabel: event.serverLabel ?? null,
        arguments: event.arguments,
        decision: "auto",
      });
      break;
    }
    case "tool-result": {
      // The parts are read-only by type, so a decision that turned out to be a
      // refusal replaces the entry rather than mutating it.
      const index = args.asked.get(event.toolCallId);
      const call = index === undefined ? undefined : parts[index];
      if (index !== undefined && call?.type === "tool-call" && event.decision) {
        parts[index] = { ...call, decision: event.decision };
      }

      parts.push({
        type: "tool-result",
        toolCallId: event.toolCallId,
        result: event.result,
        isError: event.isError,
      });
      break;
    }
    case "context-compacted": {
      // One marker per message, at its head, however many passes it took: a
      // summary outranks an omission, because it is what the model was given.
      const at = parts.findIndex((part) => part.type === "context-compacted");
      if (at === -1) parts.unshift({ type: "context-compacted", mode: event.mode });
      else if (event.mode === "summarised")
        parts[at] = { type: "context-compacted", mode: "summarised" };
      break;
    }
    case "image-generated":
      args.imageIds.push(event.imageId);
      parts.push({ type: "generated-image", imageId: event.imageId, prompt: event.prompt });
      break;
    case "usage":
      // Summed across steps: a turn that called three tools made four model
      // round trips, and all four were paid for (§10).
      args.usage.inputTokens += event.inputTokens;
      args.usage.outputTokens += event.outputTokens;
      args.usage.estimated ||= event.estimated;
      break;
    default:
      break;
  }
}

/**
 * One line per turn, at `info` (PRD §16, §21).
 *
 * A pilot classroom at the default level logged nothing about the thirty-nine
 * completions it served: an operator could see errors and the boot banner, and
 * had no way to tell a working stack from an idle one, or a slow model from a
 * slow network.
 *
 * §16 names exactly what may be here — "internal identifiers, request
 * identifiers, model aliases, latency, status, and token counts" — and this is
 * that list and nothing else. No prompt, no answer, no tool argument, no tool
 * result, no filename: a turn's content never reaches a log at any level, and
 * the way to keep that true is for the line to be built from named fields rather
 * than from anything the turn produced.
 */
function logTurn(
  input: ExecuteTurnInput,
  outcome: { status: string; usage: TurnUsage; startedAt: number },
): void {
  log.info({
    event: "turn",
    turnId: input.turnId,
    conversationId: input.conversationId,
    studentId: input.studentId,
    classroomId: input.classroomId,
    // The alias, which is what §16 permits — never the gateway model identifier
    // behind it, which is deployment configuration rather than a turn's fact.
    modelAlias: input.alias.name,
    modelAliasId: input.alias.id,
    status: outcome.status,
    durationMs: Math.round(performance.now() - outcome.startedAt),
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
    toolCalls: outcome.usage.toolCalls,
    // True when Setun estimated the figures because the gateway never reported.
    usageEstimated: outcome.usage.estimated,
  });
}

/**
 * The sign a pupil should be left with, or null when the turn simply finished.
 *
 * `stop` is the model reaching its own end and has nothing to announce. Every
 * other reason cut the answer short of where it was going, and the pupil is
 * owed an explanation they can act on — press send again, wait for tomorrow's
 * allowance, answer the question next time (§10, §11, §21).
 */
function noticeFor(event: Extract<GatewayEvent, { type: "done" }>): TurnNotice | null {
  return event.reason === "stop" ? null : event.reason;
}

function terminalStatusFor(event: Extract<GatewayEvent, { type: "done" }>) {
  if (event.reason === "aborted") return "aborted" as const;
  if (event.reason === "error" || event.reason === "context-full") return "failed" as const;
  return "completed" as const;
}

/**
 * Write what the turn produced.
 *
 * An aborted turn still persists its partial text: the student saw those words
 * stream, and a reload must not silently delete them (§10, §13).
 */
function persistOutcome(
  input: ExecuteTurnInput & {
    parts: MessagePart[];
    imageIds: string[];
    usage: TurnUsage;
    status: "completed" | "aborted" | "failed";
  },
): void {
  const { db } = input;
  const spent = input.usage.inputTokens + input.usage.outputTokens;

  const assistantMessage =
    input.parts.length > 0
      ? appendMessage(db, {
          conversationId: input.conversationId,
          parentId: input.parentMessageId,
          role: "assistant",
          parts: input.parts,
        })
      : null;

  // Recorded before usage and the active leaf: a creation outlives the
  // conversation that produced it, so it becomes a row of its own the moment the
  // model writes it rather than only when something later reads the message (§13, §16).
  if (assistantMessage) {
    recordTurnArtifacts(db, {
      studentId: input.studentId,
      conversationId: input.conversationId,
      messageId: assistantMessage.id,
      parts: input.parts,
    });
  }

  if (assistantMessage && spent > 0) {
    recordMessageUsage(db, {
      messageId: assistantMessage.id,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      estimated: input.usage.estimated,
    });

    // Images generated during the turn outlive the conversation, but while it
    // exists they belong to the message that produced them (§16).
    for (const imageId of input.imageIds) {
      attachImageToMessage(db, { imageId, messageId: assistantMessage.id });
    }
  }

  // Usage is recorded even for an aborted turn: the tokens were spent (§10).
  if (spent > 0) {
    recordUsageEvent(db, {
      classroomId: input.classroomId,
      studentId: input.studentId,
      modelAliasId: input.alias.id,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      toolCalls: input.usage.toolCalls,
      estimated: input.usage.estimated,
    });

    // The allowance just moved, so every tab watching this classroom is told —
    // without which a pupil's own meter would lag by up to a poll interval (§8).
    classroomStateChannel.publish(input.classroomId);
  }

  if (assistantMessage) {
    setActiveLeaf(db, {
      conversationId: input.conversationId,
      studentId: input.studentId,
      messageId: assistantMessage.id,
    });
  }

  finishTurn(db, {
    turnId: input.turnId,
    status: input.status,
    assistantMessageId: assistantMessage?.id ?? null,
  });
}

/** The context a turn sends, and the numbers it was planned against. */
interface PlannedContext {
  readonly path: PathMessage[];
  readonly artifacts?: ArtifactContext;
  /** The input budget, in tokens, the plan was made for. */
  readonly budget: number;
  /** The planned request's measured size. */
  readonly tokens: number;
  /** False when even the hardest plan is over budget by the estimate. */
  readonly fits: boolean;
  /** The output ceiling to send, so the provider sees the reserve the plan assumed. */
  readonly maxOutputTokens?: number;
}

/**
 * Fit the conversation into the alias's context window (§10).
 *
 * Measures the request exactly as the loop will build it — system prompt,
 * history, artifact note and carried sources, tool definitions — so what is
 * planned is what is sent. A summary written here is stored against the last
 * message it covers, and the pupil sees a marker on the answer.
 */
async function planTurnContext(args: {
  input: ExecuteTurnInput;
  window: ContextWindow;
  dailyBudget?: DailyBudgetLease;
  signal: AbortSignal;
  emit: (event: GatewayEvent) => void;
  summaryCalls: { count: number };
  hard: boolean;
}): Promise<PlannedContext> {
  const { input, window } = args;
  const budget = inputBudget(window, input.alias.dialect, input.alias.gatewayModelId);
  const maxOutputTokens = sentOutputCeiling(
    window,
    input.alias.dialect,
    input.alias.gatewayModelId,
  );
  const definitions = input.tools && input.toolContext ? input.tools.definitions() : [];
  // Carried sources share the budget with everything else: a project the path
  // no longer holds must not, on its own, be what overflows a small window.
  const carriedMaxChars = Math.min(
    CARRIED_MAX_CHARS,
    Math.floor(budget * 0.35 * CHARS_PER_ESTIMATED_TOKEN),
  );

  const artifactsFor = (path: readonly PathMessage[]): ArtifactContext | undefined => {
    if (input.artifacts === undefined) return undefined;
    // The path as given: the artifacts the caller already built for it.
    const unchanged =
      path.length === input.path.length && path.every((m, at) => m === input.path[at]);
    const built = unchanged
      ? input.artifacts
      : buildArtifactContext(input.db, {
          conversationId: input.conversationId,
          studentId: input.studentId,
          // A cut path no longer holds what it summarised away, so those
          // current sources come back as carried ones, in full.
          path,
        });
    return { ...built, carriedMaxChars };
  };

  const measure = (path: readonly PathMessage[]) =>
    requestTokens(
      input.alias.id,
      assembleContext(path, input.promptLayers, input.attachmentPayloads, artifactsFor(path)),
      definitions,
    );

  const pathIds = input.path.flatMap((message) => (message.id ? [message.id] : []));
  const stored = summaryForPath(input.db, { conversationId: input.conversationId, pathIds });

  const plan = await planContext({
    path: input.path,
    stored: stored ? { throughMessageId: stored.throughMessageId, text: stored.text } : null,
    budget,
    measure,
    summarise: createSummariser({
      adapter: input.adapter,
      alias: input.alias,
      budget,
      maxOutputTokens,
      signal: args.signal,
      dailyBudget: args.dailyBudget,
      calls: args.summaryCalls,
      emit: args.emit,
    }),
    hard: args.hard,
  });

  if (plan.summary) {
    saveContextSummary(input.db, { conversationId: input.conversationId, ...plan.summary });
  }
  if (plan.mode === "summarised" || plan.mode === "omitted") {
    args.emit({ type: "context-compacted", mode: plan.mode });
  }

  return {
    path: plan.path,
    artifacts: artifactsFor(plan.path),
    budget,
    tokens: plan.tokens,
    fits: plan.fits,
    maxOutputTokens,
  };
}
