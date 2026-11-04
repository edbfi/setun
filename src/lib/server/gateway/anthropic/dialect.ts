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
import { GatewayError, refusedUnprocessed, streamFailureCode } from "../errors";
import type { FinishReason, GatewayEvent } from "../events";
import { promptTextOf } from "../messages";
import { resolveUsage } from "../usage";

/**
 * The Anthropic-native Messages dialect (PRD §9).
 *
 * Four shape differences from the OpenAI dialect matter and are absorbed here:
 * the system prompt is a top-level field rather than a message with a role;
 * usage arrives split across `message_start` (input) and `message_delta`
 * (output) rather than in one trailing chunk; tool calls stream as a content
 * block whose input arrives as JSON fragments; and a tool's answer travels back
 * as a user message rather than as a role of its own.
 *
 * Thinking blocks are parsed if a provider sends them, but nothing here asks for
 * them: the request-side thinking parameter is a follow-up (§20).
 */

interface MessageStreamEvent {
  type?: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  content_block?: { type?: string; text?: string; thinking?: string; id?: string; name?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/**
 * Anthropic requires an explicit output ceiling; CPA forwards it unchanged.
 *
 * Keep the larger ceiling for newer Claude families without rejecting requests
 * to older models. An opaque gateway alias has no known capability, so it gets
 * the conservative default; a caller can still supply an explicit ceiling.
 */
export function defaultMaxTokens(model: string): number {
  if (/^claude-(?:3-7-|(?:opus|sonnet|haiku)-4(?:-|$)|4-)/i.test(model)) return 32_000;
  if (/^claude-3-5-/i.test(model)) return 8_192;
  return 4_096;
}

export class AnthropicDialect implements GatewayDialectAdapter {
  readonly name = "anthropic" as const;
  readonly #client: GatewayClient;

  constructor(client: GatewayClient) {
    this.#client = client;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<GatewayEvent> {
    // System messages are a top-level parameter in this dialect, not a role.
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n\n");
    const conversation = request.messages.filter((m) => m.role !== "system");

    const response = await this.#client.post(
      "/v1/messages",
      {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? defaultMaxTokens(request.model),
        stream: true,
        ...(system ? { system } : {}),
        ...(request.tools?.length ? { tools: request.tools.map(encodeTool) } : {}),
        messages: encodeConversation(conversation),
      },
      { signal: request.signal, accept: "text/event-stream" },
    );

    let completion = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finishReason: FinishReason | undefined;
    /** Tool blocks stream their input as JSON fragments, keyed by block index. */
    const toolBlocks = new Map<number, { id: string; name: string; arguments: string }>();

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
        let payload: MessageStreamEvent;
        try {
          payload = JSON.parse(event.data) as MessageStreamEvent;
        } catch {
          throw new GatewayError("unavailable", "malformed chunk in upstream stream");
        }

        const type = payload.type ?? event.event;
        const index = payload.index ?? 0;

        switch (type) {
          case "message_start": {
            inputTokens = payload.message?.usage?.input_tokens ?? inputTokens;
            outputTokens = payload.message?.usage?.output_tokens ?? outputTokens;
            break;
          }
          case "content_block_delta": {
            if (payload.delta?.partial_json !== undefined) {
              const existing = toolBlocks.get(index);
              if (existing) {
                toolBlocks.set(index, {
                  ...existing,
                  arguments: existing.arguments + payload.delta.partial_json,
                });
              }
              break;
            }

            // A thinking block, where a provider sends one. Not added to the
            // completion: it is never replayed to the model and never priced as
            // output text (§20, §10).
            const thinking = payload.delta?.thinking;
            if (thinking) {
              yield { type: "thinking-delta", text: thinking };
              break;
            }

            const text = payload.delta?.text;
            if (text) {
              completion += text;
              yield { type: "text-delta", text };
            }
            break;
          }
          case "content_block_start": {
            if (payload.content_block?.type === "tool_use") {
              toolBlocks.set(index, {
                id: payload.content_block.id ?? crypto.randomUUID(),
                name: payload.content_block.name ?? "",
                arguments: "",
              });
              break;
            }

            if (payload.content_block?.type === "thinking") {
              const opening = payload.content_block.thinking;
              if (opening) yield { type: "thinking-delta", text: opening };
              break;
            }

            // A text block can open with text already in it.
            const text = payload.content_block?.text;
            if (text) {
              completion += text;
              yield { type: "text-delta", text };
            }
            break;
          }
          case "message_delta": {
            outputTokens = payload.usage?.output_tokens ?? outputTokens;
            if (payload.delta?.stop_reason) {
              finishReason = mapStopReason(payload.delta.stop_reason);
            }
            break;
          }
          case "error": {
            const message = payload.error?.message ?? "upstream stream error";
            throw new GatewayError(streamFailureCode(message), message);
          }
          default:
            break;
        }
      }
    } catch (cause) {
      // Whatever the stream reported or produced before the failure, priced and
      // handed on; the abort or the fault then carries on to the agent loop,
      // which decides how the turn ended. This dialect reports its input tokens
      // in `message_start`, so an early cancellation usually keeps the real
      // figure rather than an estimate.
      if (refusedUnprocessed(cause, completion, inputTokens)) throw cause;
      yield resolveUsage({
        reported: { inputTokens, outputTokens },
        promptText: promptTextOf(request.messages),
        completionText: completion,
      });
      throw cause;
    }

    for (const block of toolBlocks.values()) {
      if (!block.name) continue;
      yield {
        type: "tool-call-started",
        toolCallId: block.id,
        toolName: block.name,
        // An empty input block legitimately means "no arguments".
        arguments: block.arguments || "{}",
      };
    }

    yield resolveUsage({
      reported: { inputTokens, outputTokens },
      promptText: promptTextOf(request.messages),
      completionText: completion,
      finishReason,
    });
  }

  async listModels(signal?: AbortSignal): Promise<GatewayModel[]> {
    const response = await this.#client.get("/v1/models", { signal });
    const payload = (await response.json()) as { data?: { id?: string }[] };

    return (payload.data ?? [])
      .filter((entry): entry is { id: string } => typeof entry.id === "string")
      .map((entry) => ({ id: entry.id }));
  }

  /**
   * This dialect has no generation endpoint (§9).
   *
   * Reached only if an alias is flagged image-generation-capable *and* set to
   * this dialect, which is an educator misconfiguration rather than a student
   * action — so it is refused as such, and the student sees the same friendly
   * unavailability message as any other gateway refusal (§9, §15).
   */
  generateImage(_request: ImageRequest): Promise<GeneratedImageBytes> {
    return Promise.reject(
      new GatewayError("rejected", "the Anthropic dialect exposes no image generation endpoint"),
    );
  }
}

/**
 * Normalise `stop_reason` (§10).
 *
 * `max_tokens` is this dialect's name for "I stopped at the output ceiling",
 * which the loop turns into a truncation notice rather than a clean stop.
 */
function mapStopReason(raw: string): FinishReason {
  if (raw === "max_tokens" || raw === "model_context_window_exceeded") return "length";
  if (raw === "tool_use") return "tool-calls";
  if (raw === "end_turn" || raw === "stop_sequence" || raw === "refusal") return "stop";
  // pause_turn requires replaying server-tool blocks, which this dialect does
  // not support. Unknown reasons likewise cannot establish a completed answer.
  throw new GatewayError("unavailable", `unsupported Anthropic stop reason: ${raw}`);
}

function encodeTool(tool: GatewayToolDefinition) {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

/**
 * Encode the conversation.
 *
 * A tool's answer is a user message carrying a `tool_result` block in this
 * dialect, so consecutive tool messages are folded into one user message —
 * which is also what the API requires when a turn called several tools at once.
 */
function encodeConversation(messages: readonly GatewayMessage[]) {
  const encoded: { role: "user" | "assistant"; content: unknown[] }[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: typeof message.content === "string" ? message.content : "",
      };

      const previous = encoded.at(-1);
      if (previous?.role === "user" && isToolResultBlock(previous.content.at(-1))) {
        previous.content.push(block);
      } else {
        encoded.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const text = typeof message.content === "string" ? message.content : "";
      encoded.push({
        role: "assistant",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...message.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: parseArguments(call.arguments),
          })),
        ],
      });
      continue;
    }

    encoded.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: encodeContent(message.content),
    });
  }

  return encoded;
}

function isToolResultBlock(block: unknown): boolean {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: string }).type === "tool_result"
  );
}

function encodeContent(content: string | readonly GatewayContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];

  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : // Inline bytes, never a URL the provider would fetch on our behalf (§21).
        {
          type: "image",
          source: { type: "base64", media_type: part.mediaType, data: part.data },
        },
  );
}

/**
 * Re-parse the arguments the model emitted.
 *
 * This dialect wants an object where the other wants the text, and a model that
 * emitted malformed JSON gets an empty object rather than a failed turn — the
 * tool will tell it what was wrong, which is the more useful lesson.
 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
