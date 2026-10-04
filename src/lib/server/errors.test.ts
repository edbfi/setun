import { describe, expect, test } from "bun:test";
import { createHandleError } from "./errors";

/** SvelteKit 3 hands `handleError` every error, tagged by `kind`. */
function setup() {
  const logged: unknown[][] = [];
  const handleError = createHandleError((...parts) => logged.push(parts));
  const event = {
    route: { id: "/chat" },
    request: new Request("http://localhost/chat", { method: "POST" }),
  } as unknown as Parameters<typeof handleError>[0]["event"];
  return { handleError, event, logged };
}

describe("handleError", () => {
  test("passes an app error's safe body through without logging it", async () => {
    const { handleError, event, logged } = setup();
    const error = { message: "Not found", status: 404 };
    expect(await handleError({ kind: "app", error, event })).toBe(error);
    expect(logged).toEqual([]);
  });

  test("passes framework errors (404, 405, 413) through without logging them", async () => {
    const { handleError, event, logged } = setup();
    for (const status of [404, 405, 413]) {
      const error = { message: `framework ${status}`, status };
      expect(await handleError({ kind: "framework", error, event })).toBe(error);
    }
    expect(logged).toEqual([]);
  });

  test("passes a validation error through", async () => {
    const { handleError, event, logged } = setup();
    const error = { message: "Bad Request", status: 400 };
    expect(await handleError({ kind: "validation", error, issues: [], event })).toBe(error);
    expect(logged).toEqual([]);
  });

  test("answers an unknown error with a fixed message and logs one redacted line", async () => {
    const { handleError, event, logged } = setup();
    const result = await handleError({
      kind: "unknown",
      error: new TypeError("detail that must not reach the browser"),
      event,
    });
    expect(result).toEqual({ message: "Internal Error" });
    expect(logged).toHaveLength(1);
    const [message, fields] = logged[0] as [string, Record<string, unknown>];
    expect(message).toBe("request failed");
    expect(fields).toMatchObject({ route: "/chat", method: "POST" });
    expect(typeof fields.cause).toBe("string");
    expect(String(fields.cause)).not.toContain("    at ");
  });
});
