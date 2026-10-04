import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { variables } from "./env";

/**
 * SvelteKit 3 hands the application only the variables `src/env.ts` declares; any other name
 * reads as `undefined` without an error. This compares the declarations with what the code
 * actually reads, so adding a read without a declaration fails here instead of in a classroom.
 */
const CONFIG_SOURCE = readFileSync(join(import.meta.dir, "lib/server/config.ts"), "utf8");

/** Every `env.NAME` read in config.ts, where `env` is the `$app/env/private` namespace. */
function namesReadByConfig(): string[] {
  expect(CONFIG_SOURCE).toContain('import * as env from "$app/env/private"');
  return [...new Set([...CONFIG_SOURCE.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))];
}

describe("src/env.ts", () => {
  test("declares every variable readEnvironment() reads, and nothing it does not", () => {
    const read = namesReadByConfig().sort();
    expect(read.length).toBeGreaterThan(10);
    expect(Object.keys(variables).sort()).toEqual(read);
  });

  test("keeps an unset variable undefined and passes a set one through unchanged", () => {
    // defineEnvVars turns each function into a Standard Schema; validate the way SvelteKit does.
    for (const [name, config] of Object.entries(variables)) {
      const schema = config.schema as StandardSchemaV1<string | undefined, unknown> | undefined;
      expect(schema, `${name} has a schema (without one it is required)`).toBeDefined();
      const validate = (value: string | undefined) => schema?.["~standard"].validate(value);
      expect(validate(undefined), name).toEqual({ value: undefined });
      expect(validate(" value "), name).toEqual({ value: " value " });
      expect(validate(""), name).toEqual({ value: "" });
    }
  });

  test("declares no public or static variable", () => {
    for (const config of Object.values(variables) as { public?: boolean; static?: boolean }[]) {
      expect(config.public).toBeFalsy();
      expect(config.static).toBeFalsy();
    }
  });
});
