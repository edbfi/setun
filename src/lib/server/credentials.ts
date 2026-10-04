import type { CredentialEnvironment } from "./mcp/config";

/**
 * The environment the MCP credentials are resolved from (PRD §11).
 *
 * `mcp.json` names each credential by an environment variable the operator chooses
 * (`credentialEnv`, for example SETUN_MCP_EXAMPLE_TOKEN in docker-compose.yml), so the names
 * are only known at runtime. SvelteKit 3's `$app/env/private` (and the deprecated
 * `$env/dynamic/private` shim over it) exposes only the variables declared in advance in
 * `src/env.ts`, and an undeclared name silently reads as `undefined`: through it, every
 * configured credential would look unset and boot would refuse the MCP configuration.
 *
 * So this one lookup reads `process.env`, as `$lib/server/logging` does for its level, and
 * this module is the only place that does it. It lives under `$lib/server/`, so it stays
 * server-only, and the values it returns never leave the MCP transport (§11).
 */
export function credentialEnvironment(): CredentialEnvironment {
  return process.env;
}
