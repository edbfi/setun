import type { ModelAlias } from "../db/schema";
import type { DialectName, GatewayAdapter } from "../gateway/adapter";
import { defaultMaxTokens } from "../gateway/anthropic/dialect";
import type { GatewayMessage, GatewayModel, GatewayToolDefinition } from "../gateway/dialect";
import { baseModelId } from "../gateway/health";

/**
 * How much a model can read, and how much a request is (PRD §9, §10).
 *
 * Any model can sit behind any alias, so nothing here interprets a model's
 * name. The window comes from what the operator stated, then from what the
 * gateway reports, then from a conservative default — and is lowered for an
 * hour by a request the provider refused for length, when that request was big
 * enough for the refusal to say something about the window.
 *
 * Sizes are estimated without a tokenizer: one per model would be a large
 * dependency on a small server, and none would cover every model CPA fronts.
 * Instead the estimate is calibrated against the input tokens providers report,
 * per alias, so it converges on the truth for whatever the alias is today.
 *
 * Everything held here is process memory. A restart forgets the calibration and
 * the learned ceilings, which costs one conservative turn, not a wrong answer.
 */

/** The window assumed for a model nobody has described. */
export const DEFAULT_CONTEXT_TOKENS = 32_000;

/** How long a listing of the gateway's models is trusted. */
const MODEL_LIST_TTL_MS = 10 * 60_000;

/** The share of what is left after the output reserve that a request may fill. */
const SAFETY_FACTOR = 0.9;

/** Where an alias's window came from, so the educator panel can say so. */
export type ContextWindowSource = "alias" | "gateway" | "default";

export interface ContextWindow {
  readonly tokens: number;
  /** The output ceiling the gateway reports for this model, when it reports one. */
  readonly maxOutputTokens?: number;
  readonly source: ContextWindowSource;
  /** True when a refused request has lowered the window below its source's figure. */
  readonly learned: boolean;
}

interface ModelListing {
  readonly at: number;
  readonly models: ReadonlyMap<string, GatewayModel>;
}

let listing: ModelListing | null = null;
let pending: Promise<ModelListing | null> | null = null;
/** When the last refresh failed, so a gateway that is down is not asked on every turn. */
let failedAt: number | null = null;
const RETRY_AFTER_FAILURE_MS = 30_000;
/** Alias id → a window a refusal proved too generous, and when that was learned. */
const learned = new Map<string, { readonly tokens: number; readonly at: number }>();
/** How long a learned ceiling holds before the source's own figure is trusted again. */
const LEARNED_TTL_MS = 60 * 60_000;
/** Alias id → reported input tokens per estimated token. */
const ratios = new Map<string, number>();

/**
 * The gateway's model listing, cached and shared.
 *
 * A failed refresh keeps the previous listing: a gateway that cannot answer
 * `/v1/models` for a moment has not changed what its models can read.
 */
async function modelListing(adapter: GatewayAdapter, now: number): Promise<ModelListing | null> {
  if (listing && now - listing.at < MODEL_LIST_TTL_MS) return listing;
  // A refresh that just failed is not retried on every turn: each attempt can
  // wait out the timeout before the first token, and the gateway is down.
  if (failedAt !== null && now - failedAt < RETRY_AFTER_FAILURE_MS) return listing;

  pending ??= adapter
    .listModels("openai", AbortSignal.timeout(5_000))
    .then((models) => {
      listing = { at: now, models: new Map(models.map((model) => [model.id, model])) };
      failedAt = null;
      return listing;
    })
    .catch(() => {
      failedAt = now;
      return listing;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

/** Forget the cached listing, so an alias saved a moment ago is looked up afresh. */
export function invalidateModelListing(): void {
  listing = null;
  failedAt = null;
}

/**
 * Forget what was learned about an alias: its lowered ceiling and its ratio.
 *
 * Saved by an educator, an alias may name another model or state its window
 * outright, and nothing learned about the old one is evidence about the new.
 */
export function forgetAlias(aliasId: string): void {
  learned.delete(aliasId);
  ratios.delete(aliasId);
}

/** The window an alias's model can read, and where that figure came from. */
export async function resolveContextWindow(
  adapter: GatewayAdapter,
  alias: Pick<ModelAlias, "id" | "gatewayModelId" | "contextWindowTokens">,
  now = Date.now(),
): Promise<ContextWindow> {
  const models = (await modelListing(adapter, now))?.models;
  const model = models?.get(alias.gatewayModelId) ?? models?.get(baseModelId(alias.gatewayModelId));

  const stated =
    alias.contextWindowTokens && alias.contextWindowTokens > 0 ? alias.contextWindowTokens : null;
  const base: Omit<ContextWindow, "learned"> = stated
    ? { tokens: stated, source: "alias" }
    : model?.contextTokens
      ? { tokens: model.contextTokens, source: "gateway" }
      : { tokens: DEFAULT_CONTEXT_TOKENS, source: "default" };

  const held = learned.get(alias.id);
  const ceiling = held && now - held.at < LEARNED_TTL_MS ? held.tokens : undefined;
  const output = model?.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {};

  return ceiling && ceiling < base.tokens
    ? { ...base, ...output, tokens: ceiling, learned: true }
    : { ...base, ...output, learned: false };
}

/**
 * Remember that a request of about this size was refused for length.
 *
 * Only from a request that was a plausible share of what it was planned
 * against: a refusal of something far smaller than the budget is about
 * something else — the request's bytes, a provider's own limit on images —
 * and learning a window from it would squeeze every conversation on the alias.
 *
 * Lowered to 85 % of the estimate, because the estimate is what was wrong; only
 * ever lowered while it holds, and held for an hour.
 */
export function learnContextCeiling(
  aliasId: string,
  refusedAtTokens: number,
  plannedBudget: number,
  now = Date.now(),
): void {
  if (refusedAtTokens < plannedBudget * 0.5) return;

  const ceiling = Math.max(2_048, Math.floor(refusedAtTokens * 0.85));
  const previous = learned.get(aliasId);
  const live = previous && now - previous.at < LEARNED_TTL_MS ? previous.tokens : undefined;
  if (live === undefined || ceiling < live) learned.set(aliasId, { tokens: ceiling, at: now });
}

/**
 * What to hold back for the answer (§10).
 *
 * Anthropic always sends a `max_tokens`, and refuses a request whose input and
 * `max_tokens` together exceed the window — so for that dialect this figure is
 * also what is sent (`sentOutputCeiling`), never the dialect's own default. For
 * the others it is a share of the window, bounded by the output ceiling the
 * gateway reports, with room for reasoning tokens; nothing is sent, because a
 * cap there would cut a reasoning model's answer short.
 */
export function outputReserve(window: ContextWindow, dialect: DialectName, model: string): number {
  if (dialect === "anthropic")
    return Math.min(defaultMaxTokens(model), Math.floor(window.tokens / 2));
  return Math.min(
    window.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    Math.floor(window.tokens / 4),
    32_000,
  );
}

/** The `maxOutputTokens` to send so that the reserve is what the provider sees. */
export function sentOutputCeiling(
  window: ContextWindow,
  dialect: DialectName,
  model: string,
): number | undefined {
  return dialect === "anthropic" ? outputReserve(window, dialect, model) : undefined;
}

/** How many tokens of input a request may hold, after the answer and a margin. */
export function inputBudget(window: ContextWindow, dialect: DialectName, model: string): number {
  const room = window.tokens - outputReserve(window, dialect, model);
  return Math.max(1_024, Math.floor(room * SAFETY_FACTOR));
}

/**
 * The raw size of a request, before calibration.
 *
 * Three characters a token, which is close for Danish and for code and
 * generous for English; calibration moves it from there. Every part counts —
 * the system prompt, the tool definitions, the arguments of every call — and an
 * image counts as a flat figure rather than as its base64, which would put a
 * screenshot at a hundred thousand tokens.
 */
export const CHARS_PER_ESTIMATED_TOKEN = 3;
const IMAGE_TOKENS = 1_600;
const MESSAGE_OVERHEAD = 8;

export function rawRequestTokens(
  messages: readonly GatewayMessage[],
  tools: readonly GatewayToolDefinition[] = [],
): number {
  let chars = 0;
  let fixed = 0;

  for (const message of messages) {
    fixed += MESSAGE_OVERHEAD;
    if (typeof message.content === "string") chars += message.content.length;
    else {
      for (const part of message.content) {
        if (part.type === "text") chars += part.text.length;
        else fixed += IMAGE_TOKENS;
      }
    }
    for (const call of message.toolCalls ?? []) chars += call.name.length + call.arguments.length;
  }

  if (tools.length > 0) chars += JSON.stringify(tools).length;

  return Math.ceil(chars / CHARS_PER_ESTIMATED_TOKEN) + fixed;
}

/** The ratio this alias's provider has shown between reported and estimated tokens. */
export function calibrationRatio(aliasId: string): number {
  return ratios.get(aliasId) ?? 1;
}

/** A request's size as this alias's provider will count it, as far as is known. */
export function requestTokens(
  aliasId: string,
  messages: readonly GatewayMessage[],
  tools: readonly GatewayToolDefinition[] = [],
): number {
  return Math.ceil(rawRequestTokens(messages, tools) * calibrationRatio(aliasId));
}

/**
 * Fold one provider-reported input count into the alias's ratio.
 *
 * Only reported figures, never Setun's own estimates, and only from requests
 * large enough for the ratio to mean something. Clamped, so one odd response —
 * a provider counting a cached prefix differently, a gateway adding its own
 * system prompt — moves the figure without throwing it.
 */
export function recordCalibration(aliasId: string, raw: number, reportedInput: number): void {
  if (raw < 500 || reportedInput <= 0) return;
  const observed = Math.min(2.5, Math.max(0.6, reportedInput / raw));
  const previous = ratios.get(aliasId);
  ratios.set(aliasId, previous === undefined ? observed : previous * 0.7 + observed * 0.3);
}

/** For tests: forget every cached figure. */
export function resetContextWindowState(): void {
  listing = null;
  pending = null;
  failedAt = null;
  learned.clear();
  ratios.clear();
}
