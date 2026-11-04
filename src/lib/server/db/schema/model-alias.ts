import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId, updatedAt } from "./helpers";

/** The two gateway dialects behind the adapter's single interface (PRD §9). */
export const GATEWAY_DIALECTS = ["openai", "anthropic"] as const;
export type GatewayDialect = (typeof GATEWAY_DIALECTS)[number];

/**
 * Setun's own model table: friendly names mapped to concrete CPA identifiers
 * (PRD §9). Nothing above the gateway adapter reads `dialect`.
 *
 * Managed in the educator panel from Phase 2.6; seeded by the dev seed until then.
 */
export const modelAlias = sqliteTable("model_alias", {
  id: primaryId(),
  /** Friendly name shown to students — "Fast", "Balanced", "Powerful" (§9). */
  name: text().notNull().unique(),
  /** The identifier CPA knows. Never sent to the browser (§9, §21). */
  gatewayModelId: text().notNull(),
  dialect: text({ enum: GATEWAY_DIALECTS }).notNull().default("openai"),
  available: integer({ mode: "boolean" }).notNull().default(true),
  /** True when the backing access carries a data processing agreement (§9, §16). */
  dataProtection: integer({ mode: "boolean" }).notNull().default(false),
  /** Gates image attachments (§10) and image generation (§15) respectively. */
  supportsImageInput: integer({ mode: "boolean" }).notNull().default(false),
  supportsImageGeneration: integer({ mode: "boolean" }).notNull().default(false),
  /**
   * USD per million tokens, each direction. Display-only: enforcement is
   * denominated in tokens and never depends on a price being present (§10).
   */
  inputPricePerMillion: real(),
  outputPricePerMillion: real(),
  /**
   * The model's context window in tokens, when the operator states it (§10).
   *
   * Null means "ask the gateway": CPA reports a window for the models it knows,
   * and Setun falls back to a conservative default for the ones it does not.
   * Set it where CPA reports nothing, or reports more than the account allows.
   */
  contextWindowTokens: integer(),
  /** Internal work (title generation) runs on the utility alias (§10). */
  isUtility: integer({ mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ModelAlias = typeof modelAlias.$inferSelect;
