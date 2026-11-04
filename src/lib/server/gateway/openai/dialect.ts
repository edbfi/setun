import { log } from "../../logging";
import { parseSseStream } from "../../sse";
import { GatewayClient } from "../client";
import type {
  ChatRequest,
  GatewayContentPart,
  GatewayDialectAdapter,
  GatewayMessage,
  GatewayModel,
  GatewayToolDefinition,
  GeneratedImageBytes,
  ImageRequest,
} from "../dialect";
import { GatewayError, streamFailureCode } from "../errors";
import type { FinishReason, GatewayEvent } from "../events";
import { promptTextOf } from "../messages";
import { resolveUsage } from "../usage";

/**
 * The OpenAI-compatible dialect (PRD §9). This is the default dialect.
 *
 * Two transports, one normalised event stream. `/v1/responses` is preferred
 * because it is the only one that carries the model's reasoning: probed against
 * the live gateway, `/v1/chat/completions` never returns reasoning text for the
 * `gpt-5.6-*` family — only a `reasoning_tokens` figure in usage — while
 * `/v1/responses` with `reasoning: { summary: "auto" }` streams the summary
 * headlines a pupil can actually read (§20). A provider that does not implement
 * it answers 404 or 405, is remembered per model, and is served from
 * `/v1/chat/completions` from then on.
 *
 * Nothing here escapes the module: the caller receives only normalised events.
 */

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** The subset of the Responses stream this dialect reads. */
interface ResponseStreamEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  summary_index?: number;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    incomplete_details?: { reason?: string } | null;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
    error?: { message?: string } | null;
  };
  error?: { message?: string };
}

const DONE_SENTINEL = "[DONE]";

/**
 * The prefix every function name wears on the wire, in both transports.
 *
 * A tool literally named `generate_image` made the upstream run its own built-in
 * image generation instead of calling ours: the request came back with
 * `response.image_generation_call.*` items and our tool was never invoked. The
 * prefix makes a collision with a provider's built-in name impossible, and it is
 * stripped again the moment the call is normalised — the internal names, the
 * `ToolKind` and the transcript labels never see it.
 */
const TOOL_NAME_PREFIX = "setun_";

function wireToolName(name: string): string {
  return `${TOOL_NAME_PREFIX}${name}`;
}

function internalToolName(name: string): string {
  return name.startsWith(TOOL_NAME_PREFIX) ? name.slice(TOOL_NAME_PREFIX.length) : name;
}

/**
 * The key the transport memo is held under.
 *
 * CPA exposes a reasoning-effort suffix — `gpt-5.6 (high)` — as part of the
 * model identifier, and every effort level of one model shares a transport. The
 * suffix is dropped so a fallback learned on one is not re-learned on the next.
 */
function baseModelId(model: string): string {
  return model.replace(/\s*\([^)]*\)\s*$/, "").trim() || model;
}

/**
 * Whether a failure means "this endpoint is not implemented here".
 *
 * 404 and 405 are the honest answers. Some gateways answer 400 with a message
 * naming the path instead, which is why the text is consulted — narrowly, and
 * only for a 400: a 400 that means "your request was wrong" must keep meaning
 * that, or a genuine request error would be silently retried on a transport
 * that would reject it too.
 */
const UNKNOWN_ENDPOINT = /unknown[\s_-]?(url|path|endpoint|route)|no such (endpoint|route|path)/i;

function isUnsupportedEndpoint(cause: unknown): boolean {
  if (!(cause instanceof GatewayError)) return false;
  if (cause.status === 404 || cause.status === 405) return true;
  return cause.status === 400 && UNKNOWN_ENDPOINT.test(cause.detail);
}

export class OpenAiDialect implements GatewayDialectAdapter {
  readonly name = "openai" as const;
  readonly #client: GatewayClient;
  /**
   * Models known not to implement `/v1/responses`.
   *
   * Per instance rather than per module, and consulted only at the `post()`
   * boundary — before a single event has been yielded — so a fallback can never
   * produce two usage events for one turn.
   */
  readonly #chatOnly = new Set<string>();

  constructor(client: GatewayClient) {
    this.#client = client;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<GatewayEvent> {
    const memo = baseModelId(request.model);
    let response: Response | null = null;

    if (!this.#chatOnly.has(memo)) {
      try {
        response = await this.#postResponses(request);
      } catch (cause) {
        if (!isUnsupportedEndpoint(cause)) throw cause;

        this.#chatOnly.add(memo);
        // The model, which §16 permits in a log line; never the prompt.
        log.warn("gateway has no responses endpoint for this model", { model: memo });
      }
    }

    if (response) {
      yield* this.#streamResponses(request, response);
      return;
    }

    yield* this.#streamChatCompletions(request);
  }

  /**
   * Open the Responses stream.
   *
   * Separate from the reading below so the fallback can wrap exactly this and
   * nothing else: a failure once events have begun is a failure of the turn, not
   * a reason to send the same prompt again.
   */
  #postResponses(request: ChatRequest): Promise<Response> {
    const instructions = request.messages
      .filter((message) => message.role === "system")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n\n");

    return this.#client.post(
      "/v1/responses",
      {
        model: request.model,
        input: request.messages.filter((message) => message.role !== "system").flatMap(inputItems),
        stream: true,
        // The whole point of this transport: without it the stream carries a
        // reasoning token count and no reasoning text (§20).
        reasoning: { summary: "auto" },
        // Nothing is kept upstream. Conversation state lives in Setun's own
        // database and travels with each request (§16, §21).
        store: false,
        ...(instructions ? { instructions } : {}),
        ...(request.tools?.length ? { tools: request.tools.map(encodeResponsesTool) } : {}),
        ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
      },
      { signal: request.signal, accept: "text/event-stream" },
    );
  }

  async *#streamResponses(request: ChatRequest, response: Response): AsyncGenerator<GatewayEvent> {
    let completion = "";
    let reasoning = "";
    let reported: { inputTokens?: number; outputTokens?: number } | undefined;
    let finishReason: FinishReason | undefined;
    /** How many summary parts have opened, so the second onwards gets a break. */
    let summaryParts = 0;
    /** Function calls assemble across items, keyed by their output index. */
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    /** See `#streamChatCompletions`: priced from the moment upstream accepted. */
    try {
      for await (const event of parseSseStream(GatewayClient.requireBody(response))) {
        if (event.data === DONE_SENTINEL) break;

        let payload: ResponseStreamEvent;
        try {
          payload = JSON.parse(event.data) as ResponseStreamEvent;
        } catch {
          throw new GatewayError("unavailable", "malformed chunk in upstream stream");
        }

        const type = payload.type ?? event.event;

        switch (type) {
          case "response.reasoning_summary_part.added": {
            // One headline per part. The first needs no separator; every one
            // after it is a new paragraph rather than a run-on sentence.
            if (summaryParts++ > 0) yield { type: "thinking-delta", text: "\n\n" };
            break;
          }
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": {
            if (payload.delta) {
              reasoning += payload.delta;
              yield { type: "thinking-delta", text: payload.delta };
            }
            break;
          }
          case "response.output_text.delta": {
            if (payload.delta) {
              completion += payload.delta;
              yield { type: "text-delta", text: payload.delta };
            }
            break;
          }
          case "response.output_item.added": {
            const index = payload.output_index ?? 0;
            if (payload.item?.type === "function_call") {
              toolCalls.set(index, {
                id: payload.item.call_id ?? crypto.randomUUID(),
                name: payload.item.name ?? "",
                arguments: payload.item.arguments ?? "",
              });
            } else if (payload.item?.type && isBuiltInTool(payload.item.type)) {
              // The provider ran a tool of its own rather than one this
              // classroom allowlisted. Nothing to execute and nothing to show;
              // the operator log is where it belongs (§11, §16).
              log.warn("gateway ran a built-in tool of its own", { item: payload.item.type });
            }
            break;
          }
          case "response.function_call_arguments.delta": {
            const index = payload.output_index ?? 0;
            const existing = toolCalls.get(index);
            if (existing && payload.delta) {
              toolCalls.set(index, {
                ...existing,
                arguments: existing.arguments + payload.delta,
              });
            }
            break;
          }
          case "response.output_item.done": {
            const index = payload.output_index ?? 0;
            if (payload.item?.type !== "function_call") break;

            toolCalls.set(index, {
              id: payload.item.call_id ?? toolCalls.get(index)?.id ?? crypto.randomUUID(),
              name: payload.item.name ?? toolCalls.get(index)?.name ?? "",
              // The completed item carries the whole argument string; prefer it
              // over the fragments, which may have been cut short.
              arguments: payload.item.arguments ?? toolCalls.get(index)?.arguments ?? "",
            });
            break;
          }
          case "response.completed":
          case "response.incomplete": {
            const usage = payload.response?.usage;
            // `output_tokens` already includes the reasoning tokens, so thinking
            // is paid for exactly once (§10).
            if (usage) {
              reported = {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
              };
            }

            finishReason =
              payload.response?.status === "incomplete" &&
              payload.response.incomplete_details?.reason === "max_output_tokens"
                ? "length"
                : toolCalls.size > 0
                  ? "tool-calls"
                  : "stop";
            break;
          }
          case "response.failed":
          case "error": {
            const message =
              payload.response?.error?.message ?? payload.error?.message ?? "upstream stream error";
            throw new GatewayError(streamFailureCode(message), message);
          }
          default:
            break;
        }
      }
    } catch (cause) {
      yield resolveUsage({
        reported,
        promptText: promptTextOf(request.messages),
        completionText: completion + reasoning,
      });
      throw cause;
    }

    for (const call of toolCalls.values()) {
      if (!call.name) continue;
      yield {
        type: "tool-call-started",
        toolCallId: call.id,
        toolName: internalToolName(call.name),
        arguments: call.arguments || "{}",
      };
    }

    yield resolveUsage({
      reported,
      promptText: promptTextOf(request.messages),
      completionText: completion + reasoning,
      finishReason,
    });
  }

  async *#streamChatCompletions(request: ChatRequest): AsyncGenerator<GatewayEvent> {
    const response = await this.#client.post(
      "/v1/chat/completions",
      {
        model: request.model,
        messages: request.messages.map(encodeMessage),
        stream: true,
        // Without this the OpenAI dialect omits usage from streamed responses
        // entirely, and every turn would fall back to an estimate (§10).
        stream_options: { include_usage: true },
        ...(request.tools?.length ? { tools: request.tools.map(encodeTool) } : {}),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      },
      { signal: request.signal, accept: "text/event-stream" },
    );

    let completion = "";
    let reported: { inputTokens?: number; outputTokens?: number } | undefined;
    let finishReason: FinishReason | undefined;
    /** Tool calls arrive in fragments across chunks, keyed by their index. */
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    /**
     * From here the provider has accepted the request: the post above returned
     * a response, so the prompt is already being billed whatever happens next.
     * A cancelled read or a broken stream leaves this loop by *throwing*, which
     * skipped the usage below entirely — so a pupil who pressed Stop while the
     * model was still thinking, before a single event arrived, was accounted as
     * having spent nothing. "Usage is never counted as zero" (§10) has to hold
     * from acceptance onwards, not from the first delta onwards.
     *
     * The guard belongs here rather than in the agent loop, which cannot see
     * this boundary: above it a refused, unreachable or unauthorised request
     * genuinely cost nothing, and charging a pupil for one would be worse than
     * the gap it closed.
     */
    try {
      for await (const event of parseSseStream(GatewayClient.requireBody(response))) {
        if (event.data === DONE_SENTINEL) break;

        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(event.data) as ChatCompletionChunk;
        } catch {
          // A malformed chunk is an upstream fault, not something to pass through.
          throw new GatewayError("unavailable", "malformed chunk in upstream stream");
        }

        if (chunk.usage) {
          reported = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }

        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);

        const delta = choice?.delta;

        if (delta?.content) {
          completion += delta.content;
          yield { type: "text-delta", text: delta.content };
        }

        for (const fragment of delta?.tool_calls ?? []) {
          const index = fragment.index ?? 0;
          const existing = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
          toolCalls.set(index, {
            id: fragment.id ?? existing.id,
            name: fragment.function?.name ?? existing.name,
            arguments: existing.arguments + (fragment.function?.arguments ?? ""),
          });
        }
      }
    } catch (cause) {
      // Whatever was read before the failure, priced and handed on; the abort or
      // the fault then carries on to the agent loop, which decides how the turn
      // ended. Yielded from here so the trailing figure below stays the only one
      // a completed stream produces.
      yield resolveUsage({
        reported,
        promptText: promptTextOf(request.messages),
        completionText: completion,
      });
      throw cause;
    }

    // Emitted once complete: a half-assembled argument string is not a call the
    // loop could execute, and the student's permission prompt would name nothing.
    for (const call of toolCalls.values()) {
      if (!call.name) continue;
      yield {
        type: "tool-call-started",
        toolCallId: call.id || crypto.randomUUID(),
        toolName: internalToolName(call.name),
        arguments: call.arguments,
      };
    }

    yield resolveUsage({
      reported,
      promptText: promptTextOf(request.messages),
      completionText: completion,
      finishReason,
    });
  }

  async listModels(signal?: AbortSignal): Promise<GatewayModel[]> {
    const response = await this.#client.get("/v1/models", { signal });
    const payload = (await response.json()) as {
      data?: {
        id?: string;
        context_length?: unknown;
        max_context_length?: unknown;
        max_completion_tokens?: unknown;
      }[];
    };

    return (payload.data ?? [])
      .filter((entry): entry is typeof entry & { id: string } => typeof entry.id === "string")
      .map((entry) => {
        // The operator's override wins over the registry's figure, as it does
        // inside CPA itself.
        const context =
          positiveInteger(entry.max_context_length) ?? positiveInteger(entry.context_length);
        const output = positiveInteger(entry.max_completion_tokens);
        return {
          id: entry.id,
          ...(context ? { contextTokens: context } : {}),
          ...(output ? { maxOutputTokens: output } : {}),
        };
      });
  }

  /**
   * Generate one image and return its bytes (§15).
   *
   * `b64_json` is requested explicitly so the common case needs no second
   * request; a provider that answers with a URL anyway is fetched here, on the
   * server, so the URL still never reaches a browser.
   */
  async generateImage(request: ImageRequest): Promise<GeneratedImageBytes> {
    const response = await this.#client.post(
      "/v1/images/generations",
      { model: request.model, prompt: request.prompt, n: 1, response_format: "b64_json" },
      { signal: request.signal },
    );

    const payload = (await response.json()) as {
      data?: { b64_json?: string; url?: string }[];
    };
    const first = payload.data?.[0];

    if (first?.b64_json) {
      return { bytes: decodeBase64(first.b64_json), mediaType: "image/png" };
    }
    if (first?.url) {
      const fetched = await fetch(first.url, { signal: request.signal });
      if (!fetched.ok)
        throw new GatewayError("unavailable", `image fetch failed ${fetched.status}`);
      return {
        bytes: new Uint8Array(await fetched.arrayBuffer()),
        mediaType: fetched.headers.get("content-type") ?? "image/png",
      };
    }

    throw new GatewayError("unavailable", "image response carried no image");
  }
}

/** Items a provider runs on its own account, which this dialect never asked for. */
function isBuiltInTool(itemType: string): boolean {
  return itemType.endsWith("_call") && itemType !== "function_call";
}

/**
 * Normalise `finish_reason` (§10).
 *
 * `length` is the one that matters: the provider stopped at its own output
 * ceiling, and without this the loop cannot tell a cut-off answer from a
 * finished one. Anything unfamiliar reads as a clean stop rather than as an
 * invented ceiling.
 */
function mapFinishReason(raw: string): FinishReason {
  if (raw === "length") return "length";
  if (raw === "tool_calls" || raw === "function_call") return "tool-calls";
  return "stop";
}

/**
 * One stored message as Responses input items.
 *
 * The shape is flat where chat completions nests: a function call is an item of
 * its own rather than a field on an assistant message, and its answer is another
 * item rather than a role. `call_id` is the only identifier that travels — the
 * item `id` belongs to the response that produced it, and sending one back is
 * rejected.
 */
function inputItems(message: GatewayMessage): unknown[] {
  if (message.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: typeof message.content === "string" ? message.content : "",
      },
    ];
  }

  const text = typeof message.content === "string" ? message.content : null;

  if (message.role === "assistant") {
    const prose = text ?? textOfParts(message.content);
    return [
      ...(prose
        ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: prose }] }]
        : []),
      ...(message.toolCalls ?? []).map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: wireToolName(call.name),
        arguments: call.arguments,
      })),
    ];
  }

  return [{ type: "message", role: "user", content: userContent(message.content) }];
}

function textOfParts(content: string | readonly GatewayContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function userContent(content: string | readonly GatewayContentPart[]) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];

  return content.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : // Inline data, never a URL the provider would fetch on our behalf (§21).
        { type: "input_image", image_url: `data:${part.mediaType};base64,${part.data}` },
  );
}

/** Responses declares a function flat; chat completions wraps it in `function`. */
function encodeResponsesTool(tool: GatewayToolDefinition) {
  return {
    type: "function",
    name: wireToolName(tool.name),
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function encodeTool(tool: GatewayToolDefinition) {
  return {
    type: "function",
    function: {
      name: wireToolName(tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function encodeMessage(message: GatewayMessage) {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: typeof message.content === "string" ? message.content : "",
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : "",
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: wireToolName(call.name), arguments: call.arguments },
      })),
    };
  }

  return { role: message.role, content: encodeContent(message.content) };
}

function encodeContent(content: string | readonly GatewayContentPart[]) {
  if (typeof content === "string") return content;

  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : // Inline data, never a URL the provider would fetch on our behalf (§21).
        { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } },
  );
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A limit the gateway reported, or undefined for anything that is not one. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
