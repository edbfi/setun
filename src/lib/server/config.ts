import * as v from "valibot";
import { dev } from "$app/env";
import * as env from "$app/env/private";
import { resolveAppOrigin } from "./app-origin";

/**
 * Required environment, validated at boot (PRD §6.2).
 *
 * "Absence of a required variable fails boot with a clear message rather than
 * starting degraded."
 *
 * Read through `$app/env/private` rather than `process.env`: the module is
 * server-only by construction, so a component importing this is a build error
 * rather than a leaked secret. SvelteKit 3 exposes only the variables declared
 * in `src/env.ts`, so a name read here must be declared there too
 * (`src/env.test.ts` checks it).
 *
 * Validation is lazy and cached rather than performed at import time, so
 * importing a server module in a test does not require a populated environment.
 */

const nonEmpty = (description: string) =>
  v.pipe(v.string(description), v.trim(), v.minLength(1, description));

const ConfigSchema = v.object({
  /** Pepper for the student-code HMAC. Changing it invalidates every code (§7). */
  studentCodePepper: nonEmpty("SETUN_STUDENT_CODE_PEPPER is required"),
  /**
   * The operator account, seeded at boot when it is configured (§6.2, §7).
   *
   * Optional since v0.7 of the PRD. Absent, the first-run wizard collects the
   * credential instead, and boot prints a bootstrap token so the person who can
   * read the console is the person who creates the account. Present, boot seeds
   * exactly as it always has — which is what keeps re-seeding and restarting the
   * documented password-recovery path (§7). The wizard does not replace it, and
   * there is still no in-application reset.
   */
  educatorUsername: v.optional(nonEmpty("SETUN_EDUCATOR_SEED_USERNAME must not be blank")),
  educatorPassword: v.optional(nonEmpty("SETUN_EDUCATOR_SEED_PASSWORD must not be blank")),
  /** Shared with CPA; the only thing authenticating the gateway (§9). */
  cpaListenerKey: nonEmpty("SETUN_CPA_LISTENER_KEY is required"),
  cpaBaseUrl: v.pipe(nonEmpty("SETUN_CPA_BASE_URL is required"), v.url()),
  /**
   * The address people open in the browser: ORIGIN, or SETUN_APP_ORIGIN when ORIGIN is unset
   * (`$lib/server/app-origin`). Either one is enough.
   */
  appOrigin: v.pipe(nonEmpty("ORIGIN or SETUN_APP_ORIGIN is required"), v.url()),
  /** A distinct host from the app origin — artifacts are isolated by origin (§14). */
  sandboxOrigin: v.pipe(nonEmpty("SETUN_SANDBOX_ORIGIN is required"), v.url()),
  databasePath: nonEmpty("SETUN_DATABASE_PATH is required"),
  /**
   * Where attachments and generated images are written (§15, §21).
   *
   * Outside any web root by construction: nothing serves this directory, and
   * every read goes through an owner-scoped endpoint.
   */
  storagePath: nonEmpty("SETUN_STORAGE_PATH is required"),
  /**
   * Where the nightly snapshot job writes (§21, Appendix A).
   *
   * A separate volume from the database in Compose, so a lost database file does
   * not take its own backups with it.
   */
  backupPath: nonEmpty("SETUN_BACKUP_PATH is required"),
  /**
   * The on-disk MCP server configuration, the third operator file of §6.2.
   *
   * Optional: a deployment that uses no tools has no file to point at, and
   * requiring one would fail boot over a feature it does not use (§11).
   */
  mcpConfigPath: v.optional(v.string()),
  /**
   * A second sink for the first-run bootstrap token (§6.2).
   *
   * Unset by default, and never the only sink — the console banner is always
   * written. It exists for two real cases: an operator running detached who has
   * already scrolled past the banner, and the end-to-end suite, which cannot
   * read a `webServer` child's stdout. The file is written `0600` and unlinked
   * the moment setup completes; it must not point inside the storage or backup
   * volume, where a snapshot would copy it.
   */
  bootstrapTokenPath: v.optional(v.string()),
  /**
   * The runtime mode, read rather than assumed.
   *
   * One decision depends on it: in production a database file that does not
   * exist is a dropped volume mount, not a first run — see `boot()`.
   */
  nodeEnv: v.optional(v.string()),
});

/**
 * The seed credentials are a pair.
 *
 * Half a pair is always a mistake — an operator who set the username and lost
 * the password line would otherwise get a silent wizard where they expected a
 * seeded account, and would create a second credential without noticing the
 * first never applied.
 */
const PairedSeedSchema = v.pipe(
  ConfigSchema,
  v.check(
    (config) => (config.educatorUsername === undefined) === (config.educatorPassword === undefined),
    "SETUN_EDUCATOR_SEED_USERNAME and SETUN_EDUCATOR_SEED_PASSWORD must be set together, or both left unset to use the first-run setup wizard",
  ),
);

export type ServerConfig = v.InferOutput<typeof ConfigSchema>;

export class ConfigurationError extends Error {
  constructor(issues: string[]) {
    super(
      `Setun cannot start — invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    );
    this.name = "ConfigurationError";
  }
}

/**
 * A value that is present but blank counts as absent.
 *
 * `.env.example` ships the optional variables with an empty value, so a `.env`
 * copied and only partly filled in delivers `""` rather than `undefined` —
 * which, for a variable whose absence *means* something, would otherwise fail
 * boot instead of selecting the behaviour the blank was asking for.
 */
function optionalValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Development defaults exist only for values with no security meaning. */
function readEnvironment() {
  return {
    studentCodePepper: env.SETUN_STUDENT_CODE_PEPPER,
    educatorUsername: optionalValue(env.SETUN_EDUCATOR_SEED_USERNAME),
    educatorPassword: optionalValue(env.SETUN_EDUCATOR_SEED_PASSWORD),
    cpaListenerKey: env.SETUN_CPA_LISTENER_KEY,
    cpaBaseUrl: env.SETUN_CPA_BASE_URL ?? "http://localhost:8317",
    appOrigin: resolveAppOrigin({ origin: env.ORIGIN, appOrigin: env.SETUN_APP_ORIGIN, dev }),
    sandboxOrigin: env.SETUN_SANDBOX_ORIGIN ?? "http://localhost:5174",
    databasePath: env.SETUN_DATABASE_PATH ?? "./data/setun.sqlite",
    storagePath: env.SETUN_STORAGE_PATH ?? "./data/storage",
    backupPath: env.SETUN_BACKUP_PATH ?? "./data/backups",
    mcpConfigPath: env.SETUN_MCP_CONFIG_PATH,
    bootstrapTokenPath: optionalValue(env.SETUN_BOOTSTRAP_TOKEN_PATH),
    nodeEnv: optionalValue(env.NODE_ENV),
  };
}

/**
 * Validate the environment, listing every problem at once.
 *
 * One variable at a time would mean an operator fixes one, restarts, and
 * discovers the next; §6.2 asks for a clear failure, not a scavenger hunt.
 */
export function validateConfig(raw: Record<string, unknown> = readEnvironment()): ServerConfig {
  const result = v.safeParse(PairedSeedSchema, raw);
  if (result.success) return result.output;

  const issues = result.issues.map((issue) => {
    const path = issue.path?.map((segment) => String(segment.key)).join(".") ?? "config";
    return `${path}: ${issue.message}`;
  });
  throw new ConfigurationError(issues);
}

let cached: ServerConfig | null = null;

/** The validated configuration. Throws on first access if the environment is incomplete. */
export function getConfig(): ServerConfig {
  cached ??= validateConfig();
  return cached;
}
