import { describe, expect, test } from "bun:test";
import { CROSS_ORIGIN_WRITE, foreignWriteResponse, isForeignWrite } from "./request-origin";

const url = new URL("http://192.168.1.10:3000/api/conversations");

function request(method: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers });
}

describe("isForeignWrite", () => {
  test.each(["POST", "PUT", "PATCH", "DELETE"])(
    "lets a %s from the app's own origin through",
    (method) => {
      expect(isForeignWrite(request(method, { origin: "http://192.168.1.10:3000" }), url)).toBe(
        false,
      );
    },
  );

  test.each([
    ["another origin", { origin: "http://attacker.test" }],
    ["the https variant of the app's origin", { origin: "https://192.168.1.10:3000" }],
    ["another port", { origin: "http://192.168.1.10:3001" }],
    ["Origin: null", { origin: "null" }],
    ["no Origin at all", {}],
    ["a trailing slash, which no browser sends", { origin: "http://192.168.1.10:3000/" }],
  ])("refuses a write from %s, whatever its content type", (_case, headers) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const contentType of [
        "application/json",
        "text/plain",
        "multipart/form-data",
        undefined,
      ]) {
        const all =
          contentType === undefined ? headers : { ...headers, "content-type": contentType };
        expect(isForeignWrite(request(method, all), url)).toBe(true);
      }
    }
  });

  test("leaves reads alone, whatever their origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isForeignWrite(request(method, { origin: "http://attacker.test" }), url)).toBe(false);
      expect(isForeignWrite(request(method), url)).toBe(false);
    }
  });
});

describe("foreignWriteResponse", () => {
  test("is a 403 with its own error code", async () => {
    const response = foreignWriteResponse();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: CROSS_ORIGIN_WRITE });
  });
});
