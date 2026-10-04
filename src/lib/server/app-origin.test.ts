import { describe, expect, test } from "bun:test";
import { DEV_APP_ORIGIN, resolveAppOrigin } from "./app-origin";

/**
 * One public-origin setting is enough (PRD §6.2; the shared origin contract).
 *
 * `bun ./server.js` takes ORIGIN, or SETUN_APP_ORIGIN when ORIGIN is unset, and exports the
 * canonical value as ORIGIN before the app loads. The app's own origin (QR codes, the
 * first-run banner) must then be that same origin, whichever of the two the operator set.
 */
describe("resolveAppOrigin", () => {
  test("uses SETUN_APP_ORIGIN when it is the only one set", () => {
    expect(resolveAppOrigin({ appOrigin: "https://setun.example.org", dev: false })).toBe(
      "https://setun.example.org",
    );
  });

  test("falls back to ORIGIN when SETUN_APP_ORIGIN is unset or blank", () => {
    expect(resolveAppOrigin({ origin: "http://192.168.1.10:3000", dev: false })).toBe(
      "http://192.168.1.10:3000",
    );
    expect(
      resolveAppOrigin({ origin: "http://192.168.1.10:3000", appOrigin: "  ", dev: false }),
    ).toBe("http://192.168.1.10:3000");
  });

  test("lets ORIGIN win when both are set, as the front does", () => {
    expect(
      resolveAppOrigin({
        origin: "https://setun.example.org",
        appOrigin: "http://localhost:3000",
        dev: false,
      }),
    ).toBe("https://setun.example.org");
  });

  test("keeps the localhost default for `bun run dev` only", () => {
    expect(resolveAppOrigin({ dev: true })).toBe(DEV_APP_ORIGIN);
    expect(DEV_APP_ORIGIN).toBe("http://localhost:5173");
    // A production build with neither set has no origin to print on an access slip, and
    // validateConfig() reports the variable as required instead of using a wrong one.
    expect(resolveAppOrigin({ dev: false })).toBeUndefined();
    expect(resolveAppOrigin({ origin: "", appOrigin: "", dev: false })).toBeUndefined();
  });
});
