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
 * gateway reports, then from a conservative default — and is lowered for a
 * while by any request the provider actually refused for length.
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
/** Alias id → a window a refusal proved too generous. */
const learned = new Map<string, number>();
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

  pending ??= adapter
    .listModels("openai", AbortSignal.timeout(5_000))
    .then((models) => {
      listing = { at: now, models: new Map(models.map((model) => [model.id, model])) };
      return listing;
    })
    .catch(() => listing)
    .finally(() => {
      pending = null;
    });

  return pending;
}

/** Forget the cached listing, so an alias saved a moment ago is looked up afresh. */
export function invalidateModelListing(): void {
  listing = null;
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

  const ceiling = learned.get(alias.id);
  const output = model?.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {};

  return ceiling && ceiling < base.tokens
    ? { ...base, ...output, tokens: ceiling, learned: true }
    : { ...base, ...output, learned: false };
}

/**
 * Remember that a request of about this size was refused for length.
 *
 * Lowered to 85 % of the estimate, because the estimate is what was wrong. Only
 * ever lowered: a larger refused request says nothing a smaller one did not.
 */
export function learnContextCeiling(aliasId: string, refusedAtTokens: number): void {
  const ceiling = Math.max(2_048, Math.floor(refusedAtTokens * 0.85));
  const previous = learned.get(aliasId);
  if (previous === undefined || ceiling < previous) learned.set(aliasId, ceiling);
}

/**
 * What to hold back for the answer (§10).
 *
 * Anthropic always sends a `max_tokens`, and refuses a request whose input and
 * `max_tokens` together exceed the window — so for that dialect the reserve is
 * exactly what is sent. For the others it is a share of the window, bounded by
 * the output ceiling the gateway reports, with room for reasoning tokens.
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
  learned.clear();
  ratios.clear();
}
