import type { BufferedEvent } from "./turn-buffer";

/**
 * Serialising normalised events as an SSE response (PRD §6, §10).
 *
 * "Sending a message is a POST whose response streams the normalised events."
 * There are no WebSockets anywhere in Setun (§5).
 */

/**
 * Header carrying the turn identifier of a freshly started turn.
 *
 * The client needs it immediately to abort or resume, and a header delivers it
 * before the first byte of the body — without inventing an event type outside
 * the normalised set of §10.
 */
export const TURN_ID_HEADER = "x-setun-turn-id";

/** A comment frame: valid SSE that every client ignores (see `sseResponse`). */
export const OPENING_FRAME = ": stream open\n\n";

/**
 * Wrap an event generator in a `Response`.
 *
 * The SSE `id:` field carries the sequence number, so a client that reconnects
 * knows exactly what it has already seen and asks for the remainder.
 *
 * The stream opens with a comment frame. Bun sends a streamed response's status
 * and headers only with its first chunk, so without it the client would learn
 * the turn id (and could stop the turn) only once the model's first event
 * arrived, and a turn cut off at shutdown before that event would reach the
 * client as a failed request instead of a stream that ends normally.
 */
export function sseResponse(
  events: AsyncGenerator<BufferedEvent>,
  init: { headers?: Record<string, string> } = {},
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(OPENING_FRAME));
      try {
        for await (const buffered of events) {
          const frame =
            `id: ${buffered.seq}\n` +
            `event: ${buffered.event.type}\n` +
            `data: ${JSON.stringify(buffered.event)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        }
      } catch {
        // The turn's own failures already arrive as `error` events; reaching
        // here means the transport broke, and there is nothing safe to add.
      } finally {
        controller.close();
      }
    },
    cancel() {
      // The tab went away. The turn keeps running and stays resumable — that is
      // the point of buffering every event (§10).
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Caddy is a plain proxy (§5); this keeps any intermediary from buffering.
      "x-accel-buffering": "no",
      ...init.headers,
    },
  });
}
