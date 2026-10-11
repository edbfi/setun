import { describe, expect, test } from "bun:test";
import { readEventStream } from "../../chat/sse-client";
import { OPENING_FRAME, sseResponse, TURN_ID_HEADER } from "./sse-response";
import type { DoneEvent } from "../gateway/events";
import type { BufferedEvent } from "./turn-buffer";

const done: DoneEvent = { type: "done", reason: "stop" };

describe("sseResponse", () => {
  // Bun sends a streamed response's headers with its first chunk; the turn id must not wait
  // for the model's first event (the client needs it to stop the turn, and a turn cut off at
  // shutdown must end as a stream, not as a failed request).
  test("sends the status and the turn id before the first event", async () => {
    let release: () => void = () => {};
    const firstEvent = new Promise<void>((done) => {
      release = done;
    });
    async function* events(): AsyncGenerator<BufferedEvent> {
      await firstEvent;
      yield { seq: 1, event: done } as BufferedEvent;
    }
    const server = Bun.serve({
      port: 0,
      fetch: () => sseResponse(events(), { headers: { [TURN_ID_HEADER]: "turn-1" } }),
    });
    try {
      const response = await Promise.race([
        fetch(`http://127.0.0.1:${server.port}/`),
        Bun.sleep(2000).then(() => "headers waited for the first event" as const),
      ]);
      if (typeof response === "string") throw new Error(response);
      expect(response.status).toBe(200);
      expect(response.headers.get(TURN_ID_HEADER)).toBe("turn-1");
      release();
      const seen = [];
      for await (const streamed of readEventStream(response, new AbortController().signal)) {
        seen.push(streamed);
      }
      expect(seen).toEqual([{ seq: 1, event: done }]);
    } finally {
      await server.stop(true);
    }
  });

  test("opens with a comment frame, which the client parser ignores", async () => {
    async function* none(): AsyncGenerator<BufferedEvent> {}
    const body = await sseResponse(none()).text();
    expect(body).toBe(OPENING_FRAME);
    expect(OPENING_FRAME.startsWith(":")).toBe(true);
  });
});
