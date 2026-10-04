import { readFileSync } from "node:fs";
import * as v from "valibot";

/**
 * The on-disk MCP server configuration (PRD §6.2, §11).
 *
 * "Students never configure servers; servers are defined in a version-controlled
 * configuration file on disk — an endpoint is a security decision and belongs in
 * reviewable config — with credentials referenced by environment-variable name,
 * never stored in the database."
 *
 * This is the third operator file of §6.2, beside the Compose file and the
 * `.env`. Nothing in the application can add an entry to it, and nothing in it
 * can travel to a browser: the resolved credential never leaves this module's
 * return value, which only the transport reads.
 *
 * The environment arrives as an argument rather than being read here, so this
 * module stays pure enough for `bun test` to exercise the validation without a
 * populated environment. The one caller that has an environment — the boot
 * path — takes it from `credentialEnvironment()` in `$lib/server/credentials`,
 * which reads `process.env`: the variable names are the operator's choice, so
 * SvelteKit's declared environment (`src/env.ts`) cannot list them.
 */

/** The subset of the environment this module reads: credential variables, by name. */
export type CredentialEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * A header name a tool's parameters may set, or nothing at all.
 *
 * "Header injection derived from tool parameters is disabled or strictly
 * allowlisted per server" (§11) — so the default is the empty list, and an
 * operator who wants the behaviour has to name each header in reviewable config.
 * Hop-by-hop and authentication headers are refused outright below, because an
 * allowlist that could name `authorization` would be no allowlist at all.
 */
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
]);

const HeaderName = v.pipe(
  v.string(),
  v.toLowerCase(),
  v.regex(/^[a-z0-9-]+$/, "header names may contain only letters, digits and hyphens"),
  v.check(
    (name) => !FORBIDDEN_HEADERS.has(name),
    "authentication and hop-by-hop headers may never be set from tool parameters (§11)",
  ),
);

const ServerEntry = v.object({
  /** Shown to educators in the panel; never shown to students (§11). */
  label: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** Streamable HTTP endpoint. The deprecated HTTP+SSE transport is not implemented (§11). */
  url: v.pipe(v.string(), v.url()),
  /**
   * The *name* of the environment variable holding the credential — never the
   * credential (§11). Absence means the server needs none.
   */
  credentialEnv: v.optional(v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/))),
  /** Static headers the operator wants on every request (never credentials). */
  headers: v.optional(v.record(HeaderName, v.string()), {}),
  /** Header names a tool's parameters may set. Empty disables the behaviour (§11). */
  parameterHeaderAllowlist: v.optional(v.array(HeaderName), []),
});

const ConfigFile = v.object({
  servers: v.record(
    v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, "server keys are lowercase slugs")),
    ServerEntry,
  ),
});

export type McpServerConfig = v.InferOutput<typeof ServerEntry> & { readonly key: string };

export class McpConfigurationError extends Error {
  constructor(message: string) {
    super(`Setun cannot start — invalid MCP configuration:\n  ${message}`);
    this.name = "McpConfigurationError";
  }
}

/**
 * Parse configuration text into server entries.
 *
 * Separate from reading the file so the validation is testable without one, and
 * so the boot path can report the file's own path alongside the failure.
 */
export function parseMcpConfig(text: string): McpServerConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new McpConfigurationError("the file is not valid JSON");
  }

  const result = v.safeParse(ConfigFile, raw);
  if (!result.success) {
    const issues = result.issues
      .map((issue) => {
        const path = issue.path?.map((segment) => String(segment.key)).join(".") ?? "servers";
        return `${path}: ${issue.message}`;
      })
      .join("\n  ");
    throw new McpConfigurationError(issues);
  }

  return Object.entries(result.output.servers).map(([key, entry]) => ({ key, ...entry }));
}

/**
 * Resolve one server's credential from the environment (§11).
 *
 * Returns null when the entry names none. A named variable that is missing is a
 * misconfiguration and fails loudly: a server silently called without its
 * credential would look like an authorisation problem at the far end and be
 * debugged there instead.
 */
export function resolveCredential(
  server: McpServerConfig,
  env: CredentialEnvironment,
): string | null {
  if (!server.credentialEnv) return null;

  const value = env[server.credentialEnv];
  if (!value) {
    throw new McpConfigurationError(
      `server '${server.key}' references ${server.credentialEnv}, which is not set`,
    );
  }
  return value;
}

/**
 * Load the configured servers, or an empty list when no file is configured.
 *
 * MCP is optional: a classroom that uses no tools should not be prevented from
 * booting by a file it does not need. A file that is *named* and unreadable is a
 * different matter and fails boot, as §6.2 requires.
 */
export function loadMcpConfig(input: {
  readonly path: string | null;
  readonly env: CredentialEnvironment;
}): { readonly path: string | null; readonly servers: McpServerConfig[] } {
  const { path } = input;
  if (!path) return { path: null, servers: [] };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new McpConfigurationError(
      `${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const servers = parseMcpConfig(text);
  // Fail here rather than at the first tool call: an operator restarting after
  // an edit should learn about a missing credential now (§6.2).
  for (const server of servers) resolveCredential(server, input.env);

  return { path, servers };
}
