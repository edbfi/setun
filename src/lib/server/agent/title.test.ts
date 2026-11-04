import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { createConversation, getOwnedConversation } from "../db/queries/conversations";
import { createAlias, updateAlias } from "../db/queries/model-aliases";
import { recordUsageEvent } from "../db/queries/usage";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { GatewayAdapter } from "../gateway/adapter";
import { streamingResponse, stubFetch } from "../gateway/testing";
import { fallbackTitle, generateConversationTitle, titlingAlias } from "./title";

/**
 * Conversation titles and their fallback (plan 1.7, PRD §10).
 */

let db: AppDatabase;
let fixtures: ReturnType<typeof seedTestFixtures>;

beforeEach(() => {
  db = createTestDatabase();
  fixtures = seedTestFixtures(db);
});

function adapterOver(responder: Parameters<typeof stubFetch>[0]) {
  return new GatewayAdapter({
    baseUrl: "http://cpa:8317",
    listenerKey: "k",
    fetch: stubFetch(responder).fetch,
  });
}

function titleStream(text: string) {
  return streamingResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } }),
    "[DONE]",
  ]);
}

function withUtilityAlias(dataProtection = false) {
  return createAlias(db, {
    name: "Utility",
    gatewayModelId: "small-model",
    dialect: "openai",
    isUtility: true,
    dataProtection,
  });
}

function generate(
  adapter: GatewayAdapter,
  firstMessage: string,
  conversationId: string,
  conversationAlias = fixtures.alias,
) {
  return generateConversationTitle({
    db,
    adapter,
    conversationId,
    studentId: fixtures.student.id,
    classroom: fixtures.classroom,
    conversationAlias,
    firstMessage,
  });
}

/** The model each title request named. */
function recordingAdapter(models: string[]) {
  return adapterOver((call) => {
    models.push((call.body as { model: string }).model);
    return titleStream("Loops i Python");
  });
}

function newConversation() {
  return createConversation(db, {
    studentId: fixtures.student.id,
    modelAliasId: fixtures.alias.id,
  });
}

describe("fallbackTitle", () => {
  it("keeps a short message intact", () => {
    expect(fallbackTitle("Forklar loops")).toBe("Forklar loops");
  });

  it("collapses whitespace", () => {
    expect(fallbackTitle("  Forklar   loops\n\n")).toBe("Forklar loops");
  });

  it("truncates a long message at a word boundary with an ellipsis", () => {
    const title = fallbackTitle(
      "Kan du forklare mig hvordan et neuralt netværk sender information mellem lagene i detaljer",
    );

    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
  });

  it("never returns an empty title for a non-empty message", () => {
    expect(fallbackTitle("x").length).toBeGreaterThan(0);
  });
});

describe("generateConversationTitle", () => {
  it("stores the utility alias's answer", async () => {
    withUtilityAlias();
    const conversation = newConversation();

    const title = await generate(
      adapterOver(() => titleStream("Loops i Python")),
      "Forklar loops",
      conversation.id,
    );

    expect(title).toBe("Loops i Python");
    expect(
      getOwnedConversation(db, {
        conversationId: conversation.id,
        studentId: fixtures.student.id,
      })?.title,
    ).toBe("Loops i Python");
  });

  it("strips quotation marks and trailing punctuation a model tends to add", async () => {
    withUtilityAlias();
    const conversation = newConversation();

    expect(
      await generate(
        adapterOver(() => titleStream('"Loops i Python."')),
        "q",
        conversation.id,
      ),
    ).toBe("Loops i Python");
  });

  it("counts utility usage against the classroom only, never the student", async () => {
    const utility = withUtilityAlias();
    const conversation = newConversation();

    await generate(
      adapterOver(() => titleStream("Et svar")),
      "Forklar loops",
      conversation.id,
    );

    const rows = db.$client.query("SELECT * FROM usage_event").all() as {
      studentId: string | null;
      classroomId: string;
      modelAliasId: string;
    }[];

    expect(rows).toHaveLength(1);
    // Null student is the mechanism: the classroom cap sees it, the personal
    // allowance does not (§10).
    expect(rows[0].studentId).toBeNull();
    expect(rows[0].classroomId).toBe(fixtures.classroom.id);
    expect(rows[0].modelAliasId).toBe(utility.id);
  });

  it("falls back to a truncation when no utility alias is designated", async () => {
    const conversation = newConversation();

    const title = await generate(
      adapterOver(() => titleStream("unused")),
      "Forklar loops",
      conversation.id,
    );

    expect(title).toBe("Forklar loops");
  });

  it("falls back silently when the gateway fails", async () => {
    withUtilityAlias();
    const conversation = newConversation();

    const title = await generate(
      adapterOver(() => new Response("upstream detail", { status: 502 })),
      "Forklar loops",
      conversation.id,
    );

    expect(title).toBe("Forklar loops");
  });

  it("falls back when the model returns nothing usable", async () => {
    withUtilityAlias();
    const conversation = newConversation();

    expect(
      await generate(
        adapterOver(() => titleStream("   ")),
        "Forklar loops",
        conversation.id,
      ),
    ).toBe("Forklar loops");
  });
});

describe("titles respect the conversation's data protection (§9, §16)", () => {
  const alias = (over: { dataProtection: boolean; available?: boolean }) => ({
    id: "a",
    dialect: "openai" as const,
    gatewayModelId: "m",
    available: true,
    ...over,
  });

  it("uses the utility alias when it is at least as protected", () => {
    const utility = alias({ dataProtection: true });
    expect(titlingAlias(utility, alias({ dataProtection: true }))).toBe(utility);
    expect(titlingAlias(utility, alias({ dataProtection: false }))).toBe(utility);

    const open = alias({ dataProtection: false });
    expect(titlingAlias(open, alias({ dataProtection: false }))).toBe(open);
  });

  it("titles a protected conversation on its own model when the utility alias is not", () => {
    const own = alias({ dataProtection: true });
    expect(titlingAlias(alias({ dataProtection: false }), own)).toBe(own);
  });

  it("falls back to truncation when no internal work is configured, or the own model is off", () => {
    expect(titlingAlias(undefined, alias({ dataProtection: true }))).toBeNull();
    expect(
      titlingAlias(
        alias({ dataProtection: false, available: false }),
        alias({ dataProtection: false }),
      ),
    ).toBeNull();
    expect(
      titlingAlias(
        alias({ dataProtection: false }),
        alias({ dataProtection: true, available: false }),
      ),
    ).toBeNull();
  });

  it("never sends a protected conversation's first message to an unprotected utility model", async () => {
    withUtilityAlias(false);
    const own = updateAlias(db, { aliasId: fixtures.alias.id, values: { dataProtection: true } });
    if (!own) throw new Error("alias missing");
    const conversation = newConversation();
    const models: string[] = [];

    const title = await generate(recordingAdapter(models), "Forklar loops", conversation.id, own);

    expect(title).toBe("Loops i Python");
    expect(models).toEqual([own.gatewayModelId]);

    // Still the classroom's cost, never the pupil's, booked to the model used.
    const rows = db.$client.query("SELECT studentId, modelAliasId FROM usage_event").all() as {
      studentId: string | null;
      modelAliasId: string;
    }[];
    expect(rows).toEqual([{ studentId: null, modelAliasId: own.id }]);
  });

  it("keeps using a protected utility model for a protected conversation", async () => {
    const utility = withUtilityAlias(true);
    const own = updateAlias(db, { aliasId: fixtures.alias.id, values: { dataProtection: true } });
    if (!own) throw new Error("alias missing");
    const conversation = newConversation();
    const models: string[] = [];

    await generate(recordingAdapter(models), "Forklar loops", conversation.id, own);

    expect(models).toEqual([utility.gatewayModelId]);
  });
});

describe("the classroom cap skips utility work (plan 2.7, §10, §22)", () => {
  it("falls back to a truncated title once the classroom cap is exhausted", async () => {
    const utility = withUtilityAlias();
    const conversation = newConversation();

    // The class has spent its whole day, on real student work.
    recordUsageEvent(db, {
      classroomId: fixtures.classroom.id,
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
      inputTokens: fixtures.classroom.perClassroomDailyTokens,
      outputTokens: 0,
      estimated: false,
    });

    let called = false;
    const title = await generate(
      adapterOver(() => {
        called = true;
        return titleStream("Loops i Python");
      }),
      "Forklar loops i Python for mig",
      conversation.id,
    );

    // "When the classroom cap is exhausted, utility work is skipped and its
    // fallback used" (§10) — so the gateway is never called at all.
    expect(called).toBe(false);
    expect(title).toBe("Forklar loops i Python for mig");
    expect(utility.isUtility).toBe(true);
  });

  it("runs normally while the classroom cap still has headroom", async () => {
    withUtilityAlias();
    const conversation = newConversation();

    recordUsageEvent(db, {
      classroomId: fixtures.classroom.id,
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
      inputTokens: 10,
      outputTokens: 10,
      estimated: false,
    });

    const title = await generate(
      adapterOver(() => titleStream("Loops i Python")),
      "Forklar loops",
      conversation.id,
    );

    expect(title).toBe("Loops i Python");
  });
});
