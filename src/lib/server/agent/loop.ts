import type { Message, MessagePart, PermissionMode } from "../db/schema";
import type { DialectName, GatewayAdapter } from "../gateway/adapter";
import type { GatewayContentPart, GatewayMessage, GatewayToolCall } from "../gateway/dialect";
import { GatewayError } from "../gateway/errors";
import type { FinishReason, GatewayEvent, TurnEndReason } from "../gateway/events";
import { promptTextOf } from "../gateway/messages";
import { estimateTokens, resolveUsage } from "../gateway/usage";
import type { AttachmentPayload } from "../storage/attachments";
import {
  type ArtifactContext,
  elideSupersededArtifacts,
  formatArtifactState,
  formatCarriedSources,
} from "./artifact-context";
import { encodeArtifactEdit } from "./artifact-edit";
import {
  BUDGET_PRESETS,
  type BudgetSettings,
  DAILY_WARNING_REQUEST_ID,
  type DailyBudgetLease,
  type DailyConsumption,
  type PerTurnCap,
  TurnBudget,
} from "./budgets";
import {
  CHARS_PER_ESTIMATED_TOKEN,
  rawRequestTokens,
  recordCalibration,
  requestTokens,
} from "./context-window";
import type { InteractionAnswer, TurnInteractionRegistry } from "./interactions";
import {
  DECLINED_RESULT,
  type PermissionDecision,
  requiresPermission,
  UNANSWERED_RESULT,
} from "./permissions";
import { buildSystemPrompt, type SystemPromptLayers } from "./system-prompt";
import { executeTool, type ToolContext, type ToolSet } from "./tools";

/**
 * The agent loop (PRD §10, §11).
 *
 * "Assemble context, call the model, stream deltas to the client, execute any
 * requested tools, append results, repeat until the model stops or a budget is
 * exhausted. Plain chat is the zero-tool case."
 *
 * Everything the loop does to a tool call happens here and nowhere else: the
 * permission mode is applied before execution, a declined call returns a refusal
 * and the loop continues, an interim result asking for input is surfaced and the
 * call retried, and the per-turn budget bounds the whole thing (§10, §11).
 */

/** Everything the loop needs to run tools. Absent for the zero-tool case (§10). */
export interface TurnTooling {
  readonly tools: ToolSet;
  readonly context: ToolContext;
  readonly mode: PermissionMode;
  /** Questions to the student are answered against this turn's identifier (§11). */
  readonly turnId: string;
  readonly interactions: TurnInteractionRegistry;
}

export interface RunTurnInput {
  readonly adapter: GatewayAdapter;
  readonly dialect: DialectName;
  readonly model: string;
  /** The active path of the message tree, oldest first (§10). */
  readonly path: readonly Pick<Message, "role" | "parts">[];
  /**
   * Attachments, already read from storage: images base64-encoded,
   * text/code files decoded to the fenced text the message sends.
   *
   * Resolved by the caller rather than here: the loop stays pure over stored
   * parts, and reading a file is not something a termination-condition test
   * should need a filesystem for (§10).
   */
  readonly attachmentPayloads?: ReadonlyMap<string, AttachmentPayload>;
  readonly promptLayers?: SystemPromptLayers;
  /**
   * What this conversation has built, for the state note and the elision (§13).
   *
   * Resolved by the caller rather than here, exactly as attachments are: the
   * loop stays pure over stored parts, and a termination-condition test should
   * not need a database to run.
   */
  readonly artifacts?: ArtifactContext;
  /**
   * The classroom's per-turn caps (§10).
   *
   * Defaulted to the Standard preset rather than to "unlimited": Standard is
   * what Appendix A gives a classroom, and a caller that forgets to pass
   * budgets should get the shipped policy, not none.
   */
  readonly budgets?: BudgetSettings;
  /**
   * What the classroom and this pupil have already spent today (§10).
   *
   * The daily layers are the hard ceilings and they bind *during* a turn, so the
   * loop has to know where the day already stood. Defaulted to nothing spent:
   * a caller that omits it gets a turn bounded only by its own consumption,
   * never one that mistakenly believes an allowance is full.
   */
  readonly consumed?: DailyConsumption;
  readonly dailyBudget?: DailyBudgetLease;
  readonly tooling?: TurnTooling;
  /**
   * How much the model can read, once the runner has planned the context (§10).
   *
   * Bounds what a long multi-step turn adds as it goes — tool results pile up
   * between steps — and names the alias whose size estimates each step's
   * reported usage calibrates. Absent, the loop sends what it has, as before.
   */
  readonly contextBudget?: {
    readonly inputTokens: number;
    readonly aliasId: string;
    /** The output ceiling the plan reserved, sent so the provider sees the same. */
    readonly maxOutputTokens?: number;
  };
  /** Aborting the turn cancels the upstream request and any running tool (§10). */
  readonly signal?: AbortSignal;
  /** Injectable clock, so the wall-clock cap is testable without waiting. */
  readonly now?: () => number;
}

/** How many times one call may ask the student for input before the loop gives up. */
const MAX_ELICITATION_ROUNDS = 3;

/**
 * Flatten a stored message's parts into the text the dialect sends.
 *
 * An artifact the student edited travels as a marked fenced block rather than as
 * bare prose: the model has to be able to tell the pupil's current source from
 * the version it wrote itself, which is the whole point of carrying it (§13).
 * The marker is addressed to the model, so it is not a Paraglide message.
 */
function textOf(message: Pick<Message, "parts">): string {
  return message.parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" | "artifact-edit" }> =>
        part.type === "text" || part.type === "artifact-edit",
    )
    .map((part) => (part.type === "text" ? part.text : encodeArtifactEdit(part)))
    .join("");
}

/**
 * Turn one stored message into the messages the dialect sends.
 *
 * A single stored assistant message can carry text, the tools it called and
 * their results, which is three messages upstream — the tree stores a turn as
 * one node, and the wire wants the exchange (§10, §11, §19).
 */
function encodeStoredMessage(
  message: Pick<Message, "role" | "parts">,
  payloads: RunTurnInput["attachmentPayloads"],
): GatewayMessage[] {
  const text = textOf(message);
  const toolCalls: GatewayToolCall[] = message.parts
    .filter(
      (part): part is Extract<MessagePart, { type: "tool-call" }> => part.type === "tool-call",
    )
    // Calls the student declined are replayed too, paired with the refusal that
    // was returned for them: the model asked, and being told plainly that it was
    // refused is what stops it asking again on the next turn (§11).
    .map((part) => ({
      id: part.toolCallId,
      name: part.toolName,
      arguments: JSON.stringify(part.arguments ?? {}),
    }));

  const results = message.parts.filter(
    (part): part is Extract<MessagePart, { type: "tool-result" }> => part.type === "tool-result",
  );

  const attachmentParts = message.parts.filter(
    (part): part is Extract<MessagePart, { type: "attachment" }> => part.type === "attachment",
  );

  // Text and code files travel inline as part of the message text (they were
  // stored already fenced), so the model reads them the same way it reads what
  // the pupil typed. Images travel as their own content part (§10).
  const imageParts: GatewayContentPart[] = attachmentParts.flatMap((part) => {
    const payload = payloads?.get(part.attachmentId);
    return payload?.kind === "image"
      ? [{ type: "image" as const, mediaType: payload.mediaType, data: payload.data }]
      : [];
  });

  const inlinedText = attachmentParts
    .map((part) => payloads?.get(part.attachmentId))
    .filter(
      (payload): payload is Extract<AttachmentPayload, { kind: "text" }> =>
        payload?.kind === "text",
    )
    .map((payload) => payload.text);

  const fullText = [text, ...inlinedText].filter((chunk) => chunk.length > 0).join("\n\n");

  const content: string | GatewayContentPart[] =
    imageParts.length > 0 ? [{ type: "text", text: fullText }, ...imageParts] : fullText;

  const head: GatewayMessage = {
    role: message.role,
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };

  return [
    head,
    ...results
      .filter((result) => toolCalls.some((call) => call.id === result.toolCallId))
      .map((result) => ({
        role: "tool" as const,
        toolCallId: result.toolCallId,
        content: String(result.result ?? ""),
      })),
  ];
}

/**
 * Assemble the upstream context from the active path plus the layered system
 * prompt (§10, §13).
 *
 * Two things happen to the path on the way. Obsolete copies of an artifact's
 * source are replaced by a line naming them, so a fourth revision of a page does
 * not send four copies of that page. Then the state note is appended to the last
 * user message, so the model reads what exists immediately before the request
 * that asks it to change one of them.
 *
 * Behind the note travel the sources the path does not hold. An artifact whose
 * current revision sits on another branch of the message tree — which is what a
 * pupil editing an earlier prompt produces — is named by the note and present
 * nowhere, so the model would rewrite it from the last copy it can see. They go
 * in the same slot for the same reasons.
 *
 * The note is not a system message: it changes every turn, and putting it in the
 * system layer would break the cacheable prefix on every send. It is not
 * persisted either — it describes the moment the turn was assembled.
 */
export function assembleContext(
  path: readonly Pick<Message, "role" | "parts">[],
  layers?: SystemPromptLayers,
  payloads?: RunTurnInput["attachmentPayloads"],
  artifacts?: ArtifactContext,
): GatewayMessage[] {
  const elided = artifacts ? elideSupersededArtifacts(path, artifacts.index) : path;

  const messages: GatewayMessage[] = [
    { role: "system" as const, content: buildSystemPrompt(layers) },
    ...elided.flatMap((message) => encodeStoredMessage(message, payloads)),
  ];

  const note = artifacts
    ? [
        formatArtifactState(artifacts.state),
        formatCarriedSources(artifacts.carried, artifacts.carriedMaxChars),
      ]
        .filter((part): part is string => part !== null)
        .join("\n\n")
    : "";
  return note ? withStateNote(messages, note) : messages;
}

/** Append the note to the last user message, whatever shape its content has. */
function withStateNote(messages: GatewayMessage[], note: string): GatewayMessage[] {
  const at = messages.findLastIndex((message) => message.role === "user");
  if (at === -1) return messages;

  const target = messages[at];

  if (typeof target.content === "string") {
    messages[at] = { ...target, content: `${target.content}\n\n${note}` };
    return messages;
  }

  // A message with images carries its prose as the first text part.
  const content = [...target.content];
  const textAt = content.findIndex((part) => part.type === "text");
  const held = textAt === -1 ? null : content[textAt];
  if (held?.type === "text") content[textAt] = { type: "text", text: `${held.text}\n\n${note}` };
  else content.unshift({ type: "text", text: note });

  messages[at] = { ...target, content };
  return messages;
}

/**
 * Run one turn, yielding normalised events and terminating with exactly one
 * `done`.
 *
 * Every exit is a `done` with a reason rather than a thrown error: the turn is
 * being streamed to a student who must be told what happened in friendly terms,
 * and a transport that has already begun cannot retroactively become a 500.
 */
export async function* runTurn(input: RunTurnInput): AsyncGenerator<GatewayEvent> {
  const messages: GatewayMessage[] = assembleContext(
    input.path,
    input.promptLayers,
    input.attachmentPayloads,
    input.artifacts,
  );
  const now = input.now ?? Date.now;
  const budget = new TurnBudget(
    input.budgets ?? BUDGET_PRESETS.standard,
    now(),
    input.dailyBudget?.consumed ?? input.consumed,
  );

  /**
   * Linked to the caller's signal so a *hard* stop cancels the upstream request
   * exactly as an abort does. Without it, a generation that has already spent
   * the class's day keeps costing tokens after the loop stopped reading.
   *
   * A checkpoint never cancels upstream: it is a question asked at a boundary
   * where nothing is in flight, and the answer may well be "keep going".
   *
   * A running tool execution reads the same signal, so aborting a turn cancels
   * the call in flight rather than waiting for it (§10).
   */
  const upstream = new AbortController();
  const relayAbort = () => upstream.abort();
  if (input.signal?.aborted) upstream.abort();
  else input.signal?.addEventListener("abort", relayAbort, { once: true });

  let reason: TurnEndReason = "stop";
  const definitions = input.tooling?.tools.definitions() ?? [];
  /** Numbers the checkpoints, so a second one is a question of its own. */
  let checkpoints = 0;
  /** Where this turn's own additions begin: everything before is the planned context. */
  const planned = messages.length;

  try {
    while (true) {
      // A long turn grows between steps. Before each later step, the oldest of
      // this turn's tool results give way first, so the step still fits (§10).
      if (input.contextBudget && messages.length > planned) {
        fitTurnGrowth(messages, planned, definitions, input.contextBudget);
      }

      const step = yield* runStep({
        input,
        messages,
        budget,
        signal: upstream.signal,
        definitions,
      });

      budget.recordStep();

      if (step.stopped) {
        reason = step.stopped;
        // A daily ceiling is the one stop that has to reach upstream: the class
        // is out of tokens, and a generation still running would spend more.
        if (isDailyStop(reason)) upstream.abort();
        break;
      }

      // The zero-tool case, and every turn that ends by the model simply
      // answering: nothing left to execute, so the turn is done.
      if (step.toolCalls.length === 0) break;

      messages.push({
        role: "assistant",
        content: step.text,
        toolCalls: step.toolCalls,
      });

      const outcome = yield* executeCalls({
        input,
        calls: step.toolCalls,
        messages,
        signal: upstream.signal,
        budget,
        now,
      });

      if (outcome) {
        reason = outcome;
        break;
      }

      // A clean boundary: every result is durable and the next model call has
      // not been made. This is where the daily ceilings end the turn, and where
      // a checkpoint asks whether to carry on (§10).
      const exhausted = budget.dailyExhausted();
      if (exhausted) {
        reason = exhausted;
        upstream.abort();
        break;
      }

      const caps = budget.reachedCaps(now());

      if (!input.tooling) {
        // No tools means no multi-step turn, so there is nobody to ask and no
        // second model call to ask about; a reached cap simply ends it.
        if (caps.length > 0) {
          reason = "budget";
          break;
        }
        budget.acknowledgeWarning();
        continue;
      }

      // The pupil may have pressed "Keep going" on the warning banner minutes
      // ago, while the answer was still streaming. That counts, and the boundary
      // must not ask again for something already answered.
      if (budget.warningPending) {
        const early = input.tooling.interactions.takeEarly({
          turnId: input.tooling.turnId,
          requestId: DAILY_WARNING_REQUEST_ID,
        });
        if (early?.kind === "continue") {
          if (!early.proceed) {
            reason = "aborted";
            break;
          }
          budget.acknowledgeWarning();
        }
      }

      if (caps.length > 0 || budget.warningPending) {
        const asked = yield* askToContinue({
          tooling: input.tooling,
          budget,
          now,
          caps,
          signal: upstream.signal,
          requestId: caps.length > 0 ? `continue-${++checkpoints}` : DAILY_WARNING_REQUEST_ID,
        });

        if (asked !== null) {
          reason = asked;
          break;
        }
      }
    }
  } catch (cause) {
    // The abort we issued ourselves surfacing as a cancelled read: the reason is
    // already decided, and a budget stop is not a failure.
    if (isAbort(cause, input.signal)) {
      reason = "aborted";
    } else if (cause instanceof GatewayError && cause.code === "context-overflow") {
      // Not an error to show: the runner compacts harder and asks again, and
      // when it cannot, the notice says what happened in the pupil's words.
      reason = "context-full";
    } else {
      reason = "error";
      yield {
        type: "error",
        // One student-facing message for every gateway failure; the upstream
        // detail stays in the operator log (§9, §21).
        message: cause instanceof GatewayError ? cause.code : "unavailable",
      };
    }
  } finally {
    input.signal?.removeEventListener("abort", relayAbort);
  }

  yield { type: "done", reason };
}

interface StepOutcome {
  readonly text: string;
  readonly toolCalls: GatewayToolCall[];
  /** Set when the step itself ended the turn. */
  readonly stopped: TurnEndReason | null;
}

/**
 * One model round trip: stream its text, collect the tools it asked for.
 *
 * Separated from the loop because "a step" is exactly the unit the per-turn caps
 * are denominated in, and reading the budget checks beside the streaming is what
 * makes the clean boundary of §10 visible.
 */
async function* runStep(args: {
  input: RunTurnInput;
  messages: readonly GatewayMessage[];
  budget: TurnBudget;
  signal: AbortSignal;
  definitions: ReturnType<ToolSet["definitions"]>;
}): AsyncGenerator<GatewayEvent, StepOutcome> {
  const { input, messages, budget } = args;
  const promptText = promptTextOf(messages);
  const promptTokens = estimateTokens(promptText);
  const allocation = input.dailyBudget?.reserve(promptTokens);
  if (allocation && "stop" in allocation) {
    return { text: "", toolCalls: [], stopped: allocation.stop };
  }
  // The prompt is billed before output arrives. Reserve its estimate before
  // starting the request, then replace it with provider usage at settlement.
  budget.recordProvisionalTokens(promptTokens);
  const exhaustedBeforeRequest = budget.dailyExhausted();
  if (exhaustedBeforeRequest) {
    budget.settleStepTokens(0);
    input.dailyBudget?.settle(0);
    return { text: "", toolCalls: [], stopped: exhaustedBeforeRequest };
  }

  let text = "";
  let reasoning = "";
  const toolCalls: GatewayToolCall[] = [];
  let sawUsage = false;
  /** Whether the request reached the provider at all — see the trailing usage below. */
  let reachedUpstream = false;
  /**
   * The provisional figure already handed to the budget.
   *
   * Estimating each delta on its own would round every fragment up separately,
   * so the same answer would cost more the more finely the gateway sliced it —
   * up to four times more when it streams a character at a time. Estimating the
   * text so far and recording only the increase keeps the running figure equal
   * to one estimate over the whole completion, whatever the chunking.
   */
  let provisional = 0;
  let stepTokens = promptTokens;
  let stopped: TurnEndReason | null = null;
  let finishReason: FinishReason | undefined;

  /**
   * The one warning this turn may show, claimed the moment the day passes 70 %.
   *
   * Emitted mid-stream and nothing more: the answer in flight is never cut for
   * it. The confirmation to carry on is collected at the next clean boundary,
   * or early if the pupil presses the banner's button before then (§10).
   */
  function* warnIfDue(): Generator<GatewayEvent> {
    if (!budget.takeWarning()) return;

    input.tooling?.interactions.expect({
      turnId: input.tooling.turnId,
      requestId: DAILY_WARNING_REQUEST_ID,
    });

    const binding = budget.dailyBinding();
    yield {
      type: "budget-warning",
      requestId: DAILY_WARNING_REQUEST_ID,
      fraction: budget.dailyFraction(),
      usedTokens: binding.usedTokens,
      limitTokens: binding.limitTokens,
    };
  }

  try {
    yield* warnIfDue();
    for await (const event of input.adapter.streamChat(input.dialect, {
      model: input.model,
      messages,
      ...(args.definitions.length > 0 ? { tools: args.definitions } : {}),
      ...(input.contextBudget?.maxOutputTokens
        ? { maxOutputTokens: input.contextBudget.maxOutputTokens }
        : {}),
      signal: args.signal,
    })) {
      reachedUpstream = true;

      if (event.type === "text-delta" || event.type === "thinking-delta") {
        if (event.type === "text-delta") text += event.text;
        else reasoning += event.text;
        // A provisional figure while the step is in flight, so the token cap can
        // bind mid-stream; the gateway's own number supersedes it below.
        const estimate = estimateTokens(text + reasoning);
        budget.recordProvisionalTokens(estimate - provisional);
        provisional = estimate;
        stepTokens = promptTokens + estimate;
      }
      if (event.type === "usage") {
        // The provider's own count of what it was sent: what keeps the size
        // estimate honest for whatever model is behind the alias today (§10).
        if (!event.estimated && input.contextBudget) {
          recordCalibration(
            input.contextBudget.aliasId,
            rawRequestTokens(messages, args.definitions),
            event.inputTokens,
          );
        }
        sawUsage = true;
        finishReason = event.finishReason;
        stepTokens = event.inputTokens + event.outputTokens;
        budget.settleStepTokens(event.inputTokens + event.outputTokens);
        input.dailyBudget?.settle(event.inputTokens + event.outputTokens);
      }
      if (event.type === "tool-call-started") {
        toolCalls.push({
          id: event.toolCallId,
          name: event.toolName,
          arguments: typeof event.arguments === "string" ? event.arguments : "{}",
        });
        // Held back until the permission mode has been applied: a student in
        // strict mode must see the request, not the announcement (§11).
        continue;
      }

      yield event;

      yield* warnIfDue();

      // The one thing that stops a response mid-stream: the day's tokens are
      // gone. The event just yielded is durable, the student keeps every word
      // that reached them, and nothing further is read (§10).
      const exhausted =
        budget.dailyExhausted() ??
        (allocation && stepTokens >= promptTokens + allocation.outputTokens
          ? allocation.limit
          : null);
      if (exhausted) {
        stopped = exhausted;
        break;
      }
    }
  } catch (cause) {
    /**
     * A cancelled read leaves this loop by *throwing*, not by breaking, so the
     * trailing usage below is never reached — which is how an aborted turn came
     * to be recorded as costing nothing at all. The tokens were spent: the
     * gateway generated them and the pupil read them. Account for what was
     * produced before the cancellation, then let the abort carry on to
     * `runTurn`, which is where it decides the turn ended `aborted`.
     *
     * A budget stop breaks out normally and settles below; only this path was
     * losing the figure.
     *
     * A request refused for length produced nothing and was not processed, so
     * it is not charged as if it had been — the retry that follows will be.
     */
    const refused = cause instanceof GatewayError && cause.code === "context-overflow";
    if (!sawUsage && reachedUpstream && !(refused && text + reasoning === "")) {
      const usage = resolveUsage({ promptText, completionText: text + reasoning });
      budget.settleStepTokens(usage.inputTokens + usage.outputTokens);
      input.dailyBudget?.settle(usage.inputTokens + usage.outputTokens);
      yield usage;
    } else if (!sawUsage) {
      budget.settleStepTokens(0);
      input.dailyBudget?.settle(0);
    }
    throw cause;
  }

  // A hard stop cuts the dialect off before it reports usage, and those tokens
  // were still spent: usage is never counted as zero (§10).
  if (!sawUsage && reachedUpstream) {
    const usage = resolveUsage({ promptText, completionText: text + reasoning });
    budget.settleStepTokens(usage.inputTokens + usage.outputTokens);
    input.dailyBudget?.settle(usage.inputTokens + usage.outputTokens);
    yield usage;
  } else if (!sawUsage) {
    budget.settleStepTokens(0);
    input.dailyBudget?.settle(0);
  }

  /**
   * The provider stopped at its own output ceiling.
   *
   * The answer is cut mid-sentence and anything the model was about to call is
   * half-written, so the tool calls of a truncated step are not executed: the
   * pupil is told the answer was cut short instead of watching it act on an
   * argument list that never finished.
   */
  if (stopped === null && finishReason === "length") stopped = "truncated";

  return { text, toolCalls, stopped };
}

/**
 * Apply the permission mode to each call, run the permitted ones, and append
 * their results to the context (§11).
 *
 * Returns a reason when the turn should end, and null when it should continue.
 */
async function* executeCalls(args: {
  input: RunTurnInput;
  calls: readonly GatewayToolCall[];
  messages: GatewayMessage[];
  signal: AbortSignal;
  budget: TurnBudget;
  now: () => number;
}): AsyncGenerator<GatewayEvent, TurnEndReason | null> {
  const tooling = args.input.tooling;

  for (const call of args.calls) {
    const tool = tooling?.tools.find(call.name);

    if (!tooling || !tool) {
      // The model named something outside this classroom's allowlist. Refused
      // by construction rather than by a check anyone could forget (§11, §21).
      yield* emitResult(
        args.messages,
        call,
        "That tool is not available. Continue without it.",
        true,
        args.input.contextBudget,
      );
      continue;
    }

    const decision = yield* decide({
      tooling,
      tool,
      call,
      signal: args.signal,
      budget: args.budget,
      now: args.now,
    });

    if (decision !== "approved") {
      const refusal = decision === "declined" ? DECLINED_RESULT : UNANSWERED_RESULT;
      yield {
        type: "tool-result",
        toolCallId: call.id,
        result: refusal,
        isError: true,
        decision,
      };
      args.messages.push({ role: "tool", toolCallId: call.id, content: refusal });
      // A declined call returns a refusal and the loop continues (§11); an
      // unanswered one does the same, so a closed tab cannot hang a turn.
      continue;
    }

    yield {
      type: "tool-call-started",
      toolCallId: call.id,
      toolName: tool.name,
      serverLabel: tool.serverLabel,
      arguments: parseArguments(call.arguments),
    };

    let execution = await executeTool({
      context: tooling.context,
      tool,
      arguments: parseArguments(call.arguments),
      signal: args.signal,
    });

    // "An interim result requesting input is surfaced to the student by default…
    // and the original request is retried with the responses attached" (§11).
    for (let round = 0; execution.elicitation && round < MAX_ELICITATION_ROUNDS; round++) {
      const answer = yield* elicit({
        tooling,
        tool,
        call,
        elicitation: execution.elicitation,
        signal: args.signal,
        budget: args.budget,
        now: args.now,
      });

      if (!answer) {
        execution = {
          text: "The pupil did not answer the question this tool asked. Continue without it.",
          isError: true,
        };
        break;
      }

      execution = await executeTool({
        context: tooling.context,
        tool,
        arguments: parseArguments(call.arguments),
        elicitationResponse: answer,
        signal: args.signal,
      });
    }

    if (execution.imageId) {
      yield { type: "image-generated", imageId: execution.imageId, prompt: execution.prompt ?? "" };
    }

    yield* emitResult(
      args.messages,
      call,
      execution.text,
      execution.isError,
      args.input.contextBudget,
    );
  }

  return null;
}

/**
 * Yield the result event and append the matching upstream message.
 *
 * The pupil and the transcript get the whole result. The model gets at most a
 * share of its context: one tool returning a whole web page must not be the
 * reason the next step cannot be sent (§10).
 */
function* emitResult(
  messages: GatewayMessage[],
  call: GatewayToolCall,
  text: string,
  isError: boolean,
  context?: RunTurnInput["contextBudget"],
): Generator<GatewayEvent> {
  yield { type: "tool-result", toolCallId: call.id, result: text, isError };

  const limit = context
    ? Math.max(4_000, Math.floor(context.inputTokens * 0.2 * CHARS_PER_ESTIMATED_TOKEN))
    : Number.POSITIVE_INFINITY;
  const sent =
    text.length > limit
      ? `${text.slice(0, limit)}\n[… ${text.length - limit} more characters left out to fit the model's context]`
      : text;
  messages.push({ role: "tool", toolCallId: call.id, content: sent });
}

/**
 * Make room for the next step by shortening this turn's oldest tool results.
 *
 * Only what this turn added — the planned context is already the size the
 * runner chose — and never the latest batch, which the next step is about to
 * read. A result keeps its place beside its call; only its text gives way.
 */
export function fitTurnGrowth(
  messages: GatewayMessage[],
  planned: number,
  definitions: ReturnType<ToolSet["definitions"]>,
  context: NonNullable<RunTurnInput["contextBudget"]>,
): void {
  const fits = () => requestTokens(context.aliasId, messages, definitions) <= context.inputTokens;
  const latestBatch = messages.findLastIndex(
    (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
  );

  // Older results first: the next step is about the latest ones.
  for (let at = planned; at < latestBatch; at++) {
    if (fits()) return;

    const message = messages[at];
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    if (message.content.startsWith(SHORTENED)) continue;

    messages[at] = { ...message, content: `${SHORTENED} (${message.content.length} characters)]` };
  }

  /**
   * Then the latest batch, which shares one allowance: each result is capped on
   * its own as it arrives, and several capped results can still not fit
   * together. Halve the longest until the step fits, down to a floor that still
   * says something; past that the provider decides, and an overflow ends the
   * turn with the notice rather than a guess.
   */
  for (let round = 0; round < 32 && !fits(); round++) {
    let longest = -1;
    for (let at = Math.max(planned, latestBatch + 1); at < messages.length; at++) {
      const message = messages[at];
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      if (longest === -1 || message.content.length > String(messages[longest].content).length) {
        longest = at;
      }
    }
    if (longest === -1) return;

    const content = String(messages[longest].content);
    if (content.length <= LATEST_FLOOR) return;
    const keep = Math.max(LATEST_FLOOR, Math.floor(content.length / 2));
    messages[longest] = {
      ...messages[longest],
      content: `${content.slice(0, keep)}\n[… ${content.length - keep} more characters left out to fit the model's context]`,
    };
  }
}

/** The least of a latest tool result the model is still shown. */
const LATEST_FLOOR = 1_500;

const SHORTENED = "[Earlier tool result left out to fit the model's context";

/** Apply the classroom's permission mode, asking the student when it says to (§11). */
async function* decide(args: {
  tooling: TurnTooling;
  tool: NonNullable<ReturnType<ToolSet["find"]>>;
  call: GatewayToolCall;
  signal: AbortSignal;
  budget: TurnBudget;
  now: () => number;
}): AsyncGenerator<GatewayEvent, PermissionDecision> {
  const { tooling, tool, call } = args;

  if (!requiresPermission(tooling.mode, tool)) return "approved";

  yield {
    type: "permission-request",
    toolCallId: call.id,
    toolName: tool.name,
    serverLabel: tool.serverLabel,
    sensitive: tool.sensitive,
    arguments: parseArguments(call.arguments),
  };

  const answer = await awaitAnswer({ ...args, tooling, requestId: call.id });

  if (answer?.kind !== "permission") return "unanswered";
  return answer.approved ? "approved" : "declined";
}

/** Surface an interim request for input and collect the student's answers (§11). */
async function* elicit(args: {
  tooling: TurnTooling;
  tool: NonNullable<ReturnType<ToolSet["find"]>>;
  call: GatewayToolCall;
  elicitation: NonNullable<Awaited<ReturnType<typeof executeTool>>["elicitation"]>;
  signal: AbortSignal;
  budget: TurnBudget;
  now: () => number;
}): AsyncGenerator<GatewayEvent, Record<string, unknown> | null> {
  const { tooling, tool, call } = args;

  yield {
    type: "elicitation-request",
    toolCallId: call.id,
    toolName: tool.name,
    serverLabel: tool.serverLabel,
    message: args.elicitation.message,
    fields: args.elicitation.fields,
  };

  const answer: InteractionAnswer | null = await awaitAnswer({
    ...args,
    tooling,
    requestId: call.id,
  });

  if (answer?.kind !== "elicitation" || answer.declined) return null;
  return { ...answer.values };
}

/**
 * Ask the pupil whether the turn should keep going, at a clean boundary (§10).
 *
 * Returns null to carry on, or the reason the turn ends. Saying yes grants one
 * more allotment of every cap that was reached, so the same checkpoint recurs
 * one allotment later rather than immediately.
 */
async function* askToContinue(args: {
  tooling: TurnTooling;
  budget: TurnBudget;
  now: () => number;
  caps: readonly PerTurnCap[];
  signal: AbortSignal;
  requestId: string;
}): AsyncGenerator<GatewayEvent, TurnEndReason | null> {
  const { budget, caps, now } = args;
  const binding = budget.dailyBinding();

  // Declared before it is emitted, so an answer that races the wait is held
  // rather than dropped as a late click.
  args.tooling.interactions.expect({ turnId: args.tooling.turnId, requestId: args.requestId });

  yield {
    type: "continue-request",
    requestId: args.requestId,
    cause: caps[0] ?? "daily-warning",
    caps,
    turn: { steps: budget.steps, tokens: budget.tokens, elapsedMs: budget.elapsedMs(now()) },
    daily: { usedTokens: binding.usedTokens, limitTokens: binding.limitTokens },
  };

  const answer = await awaitAnswer({ ...args, budget });

  // Nobody was there. The turn ends where it stood, with everything it produced
  // preserved — the friendly notice §10 asks for, never an error.
  if (answer?.kind !== "continue") return "budget";
  // "Stop here" is the same decision as pressing Stop, and reads the same way.
  if (!answer.proceed) return "aborted";

  budget.extend(now());
  budget.acknowledgeWarning();
  return null;
}

/**
 * Wait for one answer, and give the pupil's own time back to the turn.
 *
 * Every question — permission, elicitation, checkpoint — gets one full
 * wall-clock allotment. That used to be what was *left* of the turn's cap, on
 * the reasoning that a question outliving its turn would be answered into
 * nothing; now that a cap is a checkpoint rather than a ceiling there is nothing
 * left to outlive, and time spent reading a question is excluded from the
 * elapsed figure instead, so asking cannot bring the next checkpoint forward
 * (§10, §11).
 */
async function awaitAnswer(args: {
  tooling: TurnTooling;
  requestId: string;
  budget: TurnBudget;
  now: () => number;
  signal: AbortSignal;
}): Promise<InteractionAnswer | null> {
  const startedAt = args.now();

  const answer = await args.tooling.interactions.wait({
    turnId: args.tooling.turnId,
    requestId: args.requestId,
    timeoutMs: args.budget.allotmentMs,
    signal: args.signal,
  });

  args.budget.recordWait(args.now() - startedAt);
  return answer;
}

/** Whether a stop is one of the hard daily ceilings rather than a checkpoint. */
function isDailyStop(reason: TurnEndReason): boolean {
  return reason === "student-allowance-exhausted" || reason === "classroom-cap-exhausted";
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A model that emitted malformed arguments is told so by the tool, which is
    // more useful to it than a failed turn.
    return {};
  }
}

function isAbort(cause: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return cause instanceof Error && cause.name === "AbortError";
}
