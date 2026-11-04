import type { GatewayEvent } from "./events";

/**
 * The single internal interface both dialects implement (PRD §9).
 *
 * Everything above the adapter depends on this type and on `GatewayEvent` —
 * never on a provider's own request or response shape.
 */

/** One image travelling to the model, inline. No external URL is ever used (§15, §21). */
export interface GatewayImagePart {
  readonly type: "image";
  readonly mediaType: string;
  /** Base64, because both dialects take the bytes inline and neither fetches. */
  readonly data: string;
}

export interface GatewayTextPart {
  readonly type: "text";
  readonly text: string;
}

export type GatewayContentPart = GatewayTextPart | GatewayImagePart;

/**
 * A tool call as the model asked for it.
 *
 * `arguments` stays the raw JSON text the provider emitted rather than a parsed
 * object: a model that emits malformed arguments should be told so by the tool,
 * and re-serialising a parse would hide what it actually said.
 */
export interface GatewayToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** A message as the loop assembles it, before any dialect-specific encoding. */
export interface GatewayMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | readonly GatewayContentPart[];
  /** Present on an assistant message that requested tools (§10, §11). */
  readonly toolCalls?: readonly GatewayToolCall[];
  /** Present on a tool message, naming the call it answers. */
  readonly toolCallId?: string;
}

/** A tool offered to the model, in the normalised shape both dialects encode. */
export interface GatewayToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, forwarded as the server or the internal tool declared it. */
  readonly inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  /** The concrete gateway model identifier from the alias. Never sent to the browser (§9, §21). */
  readonly model: string;
  readonly messages: readonly GatewayMessage[];
  /** The tools this turn may use, already filtered by the classroom allowlist (§11, §21). */
  readonly tools?: readonly GatewayToolDefinition[];
  /** Aborting a turn cancels the upstream request (§10). */
  readonly signal?: AbortSignal;
  readonly maxOutputTokens?: number;
}

/** A generation request, offered only on aliases carrying the capability flag (§15). */
export interface ImageRequest {
  readonly model: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export interface GeneratedImageBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** One entry of the gateway's model listing, used for educator-panel health (§9). */
export interface GatewayModel {
  readonly id: string;
  /**
   * The context window the gateway reports for this model, in tokens (§9, §10).
   *
   * CPA lists `max_context_length` (an operator override in its own config)
   * and `context_length` (its registry's figure) on the OpenAI-format listing,
   * and omits both for models it knows nothing about — so absent is common, and
   * means "unknown", never "unlimited".
   */
  readonly contextTokens?: number;
  /** The output ceiling the gateway reports, when it reports one. */
  readonly maxOutputTokens?: number;
}

export interface GatewayDialectAdapter {
  readonly name: "openai" | "anthropic";
  /** Streams normalised events. Always terminates with exactly one `done`. */
  streamChat(request: ChatRequest): AsyncGenerator<GatewayEvent>;
  listModels(signal?: AbortSignal): Promise<GatewayModel[]>;
  /**
   * Generate one image, returning its bytes.
   *
   * Bytes rather than a URL: "no external image URL is ever handed to the
   * browser" (§15), so the adapter is where a provider URL stops.
   */
  generateImage(request: ImageRequest): Promise<GeneratedImageBytes>;
}
