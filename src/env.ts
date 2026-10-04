import { defineEnvVars } from "@sveltejs/kit/env";

/**
 * Every environment variable the application reads through SvelteKit (`$app/env/private`).
 *
 * SvelteKit 3 exposes only the variables declared here: an undeclared one silently reads as
 * `undefined`, which for an optional setting such as SETUN_MCP_CONFIG_PATH would switch its
 * feature off without a word. `src/env.test.ts` fails when `readEnvironment()` in
 * `$lib/server/config` reads a name that is not declared here.
 *
 * Each variable passes through unchanged, so "unset" stays `undefined`: the `??` defaults and
 * the blank-means-absent handling in `readEnvironment()` depend on it, and `validateConfig()`
 * stays the one validator, listing every problem at once (PRD §6.2). A declaration without a
 * schema would instead make the variable required at startup and at build time, where the
 * Docker build stage has no secrets.
 *
 * Not declared here, on purpose: SETUN_LOG_LEVEL (read from `process.env` by
 * `$lib/server/logging`) and the MCP credentials, whose names the operator chooses in mcp.json
 * (read from `process.env` by `$lib/server/credentials`).
 */
const passThrough = (value: string | undefined) => value;

export const variables = defineEnvVars({
  SETUN_STUDENT_CODE_PEPPER: { schema: passThrough },
  SETUN_EDUCATOR_SEED_USERNAME: { schema: passThrough },
  SETUN_EDUCATOR_SEED_PASSWORD: { schema: passThrough },
  SETUN_CPA_LISTENER_KEY: { schema: passThrough },
  SETUN_CPA_BASE_URL: { schema: passThrough },
  SETUN_APP_ORIGIN: { schema: passThrough },
  SETUN_SANDBOX_ORIGIN: { schema: passThrough },
  SETUN_DATABASE_PATH: { schema: passThrough },
  SETUN_STORAGE_PATH: { schema: passThrough },
  SETUN_BACKUP_PATH: { schema: passThrough },
  SETUN_MCP_CONFIG_PATH: { schema: passThrough },
  SETUN_BOOTSTRAP_TOKEN_PATH: { schema: passThrough },
  NODE_ENV: { schema: passThrough },
});
