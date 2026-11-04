import { beforeEach, describe, expect, it } from "bun:test";
import type { GatewayAdapter } from "../gateway/adapter";
import type { GatewayModel } from "../gateway/dialect";
import {
  calibrationRatio,
  DEFAULT_CONTEXT_TOKENS,
  forgetAlias,
  inputBudget,
  learnContextCeiling,
  outputReserve,
  rawRequestTokens,
  recordCalibration,
  requestTokens,
  resetContextWindowState,
  resolveContextWindow,
  sentOutputCeiling,
} from "./context-window";

/**
 * Where a model's window comes from, and how big a request is (PRD §9, §10).
 *
 * Any model behind any alias: nothing here may depend on a model's name.
 */

function gateway(models: GatewayModel[] | Error): GatewayAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    async listModels() {
      adapter.calls++;
      if (models instanceof Error) throw models;
      return models;
    },
  };
  return adapter as unknown as GatewayAdapter & { calls: number };
}

const alias = (
  overrides: Partial<{
    id: string;
    gatewayModelId: string;
    contextWindowTokens: number | null;
  }> = {},
) => ({
  id: "alias-1",
  gatewayModelId: "gpt-6.1-sol",
  contextWindowTokens: null,
  ...overrides,
});

beforeEach(resetContextWindowState);

describe("resolveContextWindow", () => {
  it("takes the window the operator stated over anything the gateway says", async () => {
    const window = await resolveContextWindow(
      gateway([{ id: "gpt-6.1-sol", contextTokens: 400_000 }]),
      alias({ contextWindowTokens: 100_000 }),
    );
    expect(window).toMatchObject({ tokens: 100_000, source: "alias", learned: false });
  });

  it("uses the gateway's figure, matching an alias that sets an effort suffix", async () => {
    const window = await resolveContextWindow(
      gateway([{ id: "gpt-6.1-sol", contextTokens: 400_000, maxOutputTokens: 128_000 }]),
      alias({ gatewayModelId: "gpt-6.1-sol(high)" }),
    );
    expect(window).toEqual({
      tokens: 400_000,
      maxOutputTokens: 128_000,
      source: "gateway",
      learned: false,
    });
  });

  it("assumes a conservative window when the gateway knows nothing, or cannot answer", async () => {
    expect(await resolveContextWindow(gateway([{ id: "other" }]), alias())).toMatchObject({
      tokens: DEFAULT_CONTEXT_TOKENS,
      source: "default",
    });
    resetContextWindowState();
    expect(await resolveContextWindow(gateway(new Error("down")), alias())).toMatchObject({
      source: "default",
    });
  });

  it("does not ask a gateway that just failed again on every turn", async () => {
    const adapter = gateway(new Error("down"));
    await resolveContextWindow(adapter, alias(), 1_000);
    await resolveContextWindow(adapter, alias(), 2_000);
    expect(adapter.calls).toBe(1);
    await resolveContextWindow(adapter, alias(), 1_000 + 31_000);
    expect(adapter.calls).toBe(2);
  });

  it("asks the gateway once per listing, not once per turn", async () => {
    const adapter = gateway([{ id: "gpt-6.1-sol", contextTokens: 400_000 }]);
    await resolveContextWindow(adapter, alias(), 1_000);
    await resolveContextWindow(adapter, alias(), 2_000);
    expect(adapter.calls).toBe(1);
    await resolveContextWindow(adapter, alias(), 1_000 + 11 * 60_000);
    expect(adapter.calls).toBe(2);
  });

  it("lowers the window after a refusal, and only ever lowers it", async () => {
    const adapter = gateway([{ id: "gpt-6.1-sol", contextTokens: 400_000 }]);
    learnContextCeiling("alias-1", 200_000, 300_000, 1_000);
    learnContextCeiling("alias-1", 300_000, 300_000, 1_000);

    expect(await resolveContextWindow(adapter, alias(), 2_000)).toMatchObject({
      tokens: 170_000,
      source: "gateway",
      learned: true,
    });
    // An hour later the gateway's own figure stands again.
    expect(await resolveContextWindow(adapter, alias(), 1_000 + 61 * 60_000)).toMatchObject({
      tokens: 400_000,
      learned: false,
    });
  });

  it("learns nothing from a refusal far smaller than what was planned", async () => {
    // Two photos refused by a proxy's byte limit, in a fresh conversation.
    learnContextCeiling("alias-1", 4_000, 300_000);
    expect(
      await resolveContextWindow(gateway([{ id: "gpt-6.1-sol", contextTokens: 400_000 }]), alias()),
    ).toMatchObject({ tokens: 400_000, learned: false });
  });

  it("forgets what it learned about an alias once the alias is saved", async () => {
    learnContextCeiling("alias-1", 200_000, 300_000);
    recordCalibration("alias-1", 1_000, 2_000);
    forgetAlias("alias-1");

    expect(calibrationRatio("alias-1")).toBe(1);
    expect(
      await resolveContextWindow(gateway([{ id: "gpt-6.1-sol", contextTokens: 400_000 }]), alias()),
    ).toMatchObject({ learned: false });
  });
});

describe("budgets", () => {
  it("holds back exactly what Anthropic is sent as max_tokens", () => {
    const window = { tokens: 200_000, source: "gateway" as const, learned: false };
    // An opaque alias gets the dialect's conservative 4,096.
    expect(outputReserve(window, "anthropic", "house-model")).toBe(4_096);
    expect(sentOutputCeiling(window, "anthropic", "house-model")).toBe(4_096);

    // A Claude-named model in a small window: the reserve is halved, and the
    // same figure is what gets sent — never the dialect's 32,000.
    const small = { tokens: 32_000, source: "default" as const, learned: false };
    expect(outputReserve(small, "anthropic", "claude-sonnet-4-x")).toBe(16_000);
    expect(sentOutputCeiling(small, "anthropic", "claude-sonnet-4-x")).toBe(16_000);

    // Elsewhere nothing is sent: a cap would cut a reasoning model short.
    expect(sentOutputCeiling(small, "openai", "m")).toBeUndefined();
  });

  it("holds back a share of the window elsewhere, bounded by the reported output ceiling", () => {
    expect(
      outputReserve({ tokens: 32_000, source: "default", learned: false }, "openai", "m"),
    ).toBe(8_000);
    expect(
      outputReserve(
        { tokens: 400_000, maxOutputTokens: 16_000, source: "gateway", learned: false },
        "openai",
        "m",
      ),
    ).toBe(16_000);
    expect(inputBudget({ tokens: 32_000, source: "default", learned: false }, "openai", "m")).toBe(
      21_600,
    );
  });
});

describe("estimates", () => {
  it("counts every part of a request, and an image as a flat figure rather than its base64", () => {
    const text = rawRequestTokens([{ role: "user", content: "x".repeat(300) }]);
    const image = rawRequestTokens([
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(300) },
          { type: "image", mediaType: "image/png", data: "A".repeat(2_000_000) },
        ],
      },
    ]);
    expect(text).toBe(108);
    expect(image).toBe(108 + 1_600);

    const withTools = rawRequestTokens(
      [{ role: "user", content: "x".repeat(300) }],
      [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
    );
    expect(withTools).toBeGreaterThan(text);
  });

  it("calibrates per alias against reported usage, within bounds", () => {
    recordCalibration("alias-1", 1_000, 1_500);
    expect(calibrationRatio("alias-1")).toBe(1.5);
    recordCalibration("alias-1", 1_000, 100_000);
    // One wild figure moves it, and no further than the clamp.
    expect(calibrationRatio("alias-1")).toBeCloseTo(1.5 * 0.7 + 2.5 * 0.3);
    // Small requests and estimates say too little to learn from.
    recordCalibration("alias-2", 100, 1_000);
    expect(calibrationRatio("alias-2")).toBe(1);

    expect(requestTokens("alias-1", [{ role: "user", content: "x".repeat(2_976) }])).toBe(
      Math.ceil(1_000 * calibrationRatio("alias-1")),
    );
  });
});
