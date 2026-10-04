import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BootstrapTokenHolder, bootstrapBanner } from "./auth/bootstrap";
import { seedEducator } from "./auth/educator";
import { getConfig, type ServerConfig } from "./config";
import { credentialEnvironment } from "./credentials";
import { type AppDatabase, createDatabase } from "./db/client";
import { applyMigrations } from "./db/migrate";
import { getFirstEducator } from "./db/queries/educators";
import { reopenSetup } from "./db/queries/instance";
import { markStreamingTurnsInterrupted } from "./db/queries/turns";
import { GatewayAdapter } from "./gateway/adapter";
import { backupJob } from "./jobs/backup";
import { retentionJob } from "./jobs/retention";
import { JobScheduler } from "./jobs/scheduler";
import { sessionSweepJob } from "./jobs/sessions";
import { describeCause, log } from "./logging";
import { McpClient } from "./mcp/client";
import { loadMcpConfig } from "./mcp/config";
import { registerConfiguredServers } from "./mcp/registry";
import { adoptExistingInstall, isSetupComplete } from "./setup/state";
import { FileStore } from "./storage/files";

/**
 * The composition root (PRD §6, §6.2).
 *
 * The boot sequence, in the order §6 requires: validate the environment, apply
 * migrations *before* the listener accepts anything, then mark turns left
 * in-flight by the previous process as interrupted so resume shows a cut-short
 * notice instead of waiting on a producer that no longer exists (§10).
 *
 * Everything the request path needs is constructed once here and reached
 * through the accessors below — never rebuilt per request, and never mutated.
 */

interface Services {
  readonly db: AppDatabase;
  readonly adapter: GatewayAdapter;
  readonly files: FileStore;
  /** Null when the deployment configures no MCP servers, which is a valid pilot (§11). */
  readonly mcp: McpClient | null;
  readonly jobs: JobScheduler;
  /**
   * The first-run bootstrap token (§6.2, §7).
   *
   * Held here rather than in a module-level `let`: mutable module-scope state in
   * a server file is the anti-pattern this codebase's rules name, and the
   * composition root is already where the process-lifetime singletons live. It
   * also makes the token trivially testable — a suite constructs its own holder
   * and has no global to reset.
   */
  readonly bootstrap: BootstrapTokenHolder;
}

let services: Services | null = null;

function boot(): Services {
  // Throws with every missing variable listed, rather than starting degraded (§6.2).
  const config = getConfig();

  if (config.databasePath !== ":memory:") {
    /**
     * In production, a database file that is not there is a dropped volume
     * mount — not a first run.
     *
     * `createDatabase` would happily create one, which used to be an
     * empty-data incident. With a setup gate in front of the application it
     * becomes something worse: an open claim window on a deployment that
     * already has an educator, a roster and a term of conversations, handed to
     * whoever reaches the port first. Failing loudly is the only safe answer.
     * Development, tests and `:memory:` keep the create-on-demand behaviour.
     */
    if (config.nodeEnv === "production" && !existsSync(config.databasePath)) {
      throw new Error(
        `Setun cannot start — SETUN_DATABASE_PATH points at '${config.databasePath}', which does not exist.\n` +
          "  In production this means the database volume is not mounted. Setun will not create a\n" +
          "  fresh database here, because an empty one would present a configured installation as a\n" +
          "  cold start and reopen first-run setup. Check the volume mount, or create the file\n" +
          "  deliberately if this really is a new installation.",
      );
    }

    mkdirSync(dirname(config.databasePath), { recursive: true });
  }

  const db = createDatabase(config.databasePath);

  // Before the listener starts: no request may observe an unmigrated schema (§6).
  applyMigrations(db);

  /**
   * Every installation that predates the first-run wizard is a finished
   * installation (§6.2).
   *
   * Runs before the seed rather than after it, and takes the *configuration*
   * into account rather than only the table, because seeding is asynchronous: a
   * cold start with seed credentials set has no educator row at this instant,
   * and a gate that waited for one would make the first request's answer depend
   * on a race it cannot see.
   */
  adoptExistingInstall(db, {
    educatorConfigured: config.educatorUsername !== undefined,
  });

  const interrupted = markStreamingTurnsInterrupted(db);
  if (interrupted > 0) {
    log.info(`marked ${interrupted} in-flight turn(s) interrupted after restart`);
  }

  const bootstrap = announceBootstrapToken(db, config);

  // The operator account, from deployment configuration, on every boot: this is
  // the documented password-recovery path, so it must take effect on a restart
  // and not only on a first boot (§7, §6.2).
  //
  // Optional since PRD v0.7. With no seed credentials configured, the first-run
  // wizard collects them instead — and re-seeding remains the recovery path for
  // anyone who does configure them.
  const { educatorUsername, educatorPassword } = config;
  if (educatorUsername !== undefined && educatorPassword !== undefined) {
    void seedEducator(db, { username: educatorUsername, password: educatorPassword }).then(
      (result) => {
        if (result.seeded) log.info(`seeded educator account '${educatorUsername}'`);
      },
      (cause) => {
        /**
         * The adoption above ran on the *configuration* rather than on a row,
         * precisely so the setup gate did not have to wait on this promise. That
         * trade is only sound if a seed that never lands is taken back: an
         * installation left marked complete with no educator row has no login —
         * and, because the bootstrap token is minted only while setup is
         * incomplete, no wizard either. Silence here is a locked-out operator.
         *
         * So the failure is loud, the adoption is reversed, and a bootstrap
         * token is minted — `announceBootstrapToken` ran while the installation
         * still looked complete and skipped it, and reopening the gate without
         * one would leave every request redirected to a wizard nobody can enter:
         * no token to claim with, and no educator to recover with. The wizard's
         * account step reappears on its own, because `educatorSeeded` means
         * "configuration produced an account" and this one produced none.
         *
         * The condition is the *state*, not whether this boot happened to be the
         * one that adopted. A process that exits between the adoption and this
         * rejection leaves a later boot with nothing to adopt — and a rollback
         * that only fired on the adopting boot would never run again, which is
         * the lockout made permanent. `reopenSetup` supplies the rest of the
         * condition: it touches only an installation whose wizard was never
         * started, so a real setup is never reopened. An educator row that does
         * exist means the installation has an operator whatever this seed was
         * doing, and reopening would be wrong.
         *
         * A rejection handler rather than a bare `void`: an unhandled rejection
         * would take the process down over a diagnosis it never printed.
         */
        log.error(`could not seed the configured educator account '${educatorUsername}'`, {
          cause: describeCause(cause),
        });

        if (!getFirstEducator(db) && reopenSetup(db, new Date())) {
          log.error(
            "first-run setup re-opened: this installation has no operator account.\n" +
              "  Claim the wizard with the bootstrap token below and create one there,\n" +
              "  or fix the cause above and restart Setun to re-attempt the seed.",
          );
          mintBootstrapToken(bootstrap, config);
        }
      },
    );
  }

  // No pupil seed. Phase 1 printed one access code at first boot so the loop was
  // verifiable before a provisioning UI existed; the panel provisions in batches
  // now, and a code on the operator console is a code in a log file (§7, §21).

  // The third operator file (§6.2). Validated here so a malformed entry or a
  // missing credential fails boot rather than a lesson (§11).
  const mcpConfig = loadMcpConfig({
    path: config.mcpConfigPath ?? null,
    env: credentialEnvironment(),
  });

  if (mcpConfig.servers.length > 0) {
    registerConfiguredServers(db, mcpConfig.servers);
    log.info(`registered ${mcpConfig.servers.length} MCP server(s) from ${mcpConfig.path}`);
  }

  // Retention, the session sweep and the nightly snapshot (§16, §21). In-process
  // rather than a fourth container, and started only once the schema is current
  // — a retention pass against an unmigrated database would delete by a policy
  // column that may not exist yet.
  const files = new FileStore(config.storagePath);
  const jobs = new JobScheduler()
    .register(retentionJob(db, files))
    .register(sessionSweepJob(db))
    .register(
      backupJob({
        db,
        storagePath: config.storagePath,
        backupPath: config.backupPath,
        // The pilot's zone, and the classroom default of §8. A snapshot is
        // "nightly" in somebody's night; a server in UTC would roll the day
        // mid-evening in Denmark.
        timezone: "Europe/Copenhagen",
      }),
    );
  jobs.start();

  return {
    db,
    jobs,
    files,
    adapter: new GatewayAdapter({
      baseUrl: config.cpaBaseUrl,
      listenerKey: config.cpaListenerKey,
    }),
    mcp:
      mcpConfig.servers.length > 0
        ? new McpClient(mcpConfig.servers, { env: credentialEnvironment() })
        : null,
    bootstrap,
  };
}

/**
 * Mint the first-run token and put it where an operator can read it (§6.2, §21).
 *
 * Only on an installation that still needs setting up, so a running pilot never
 * prints a credential it has no use for.
 *
 * Note the timing: `boot()` is lazy — `services ??= boot()` — so this appears on
 * the *first request*, not at process start. That is deliberate and friendlier:
 * a token whose fifteen minutes begin when somebody opens the page is a token
 * that is still valid when they read it.
 *
 * The console is always written to; the file is an opt-in second sink and never
 * a replacement. Both are cleared when setup completes.
 */
function announceBootstrapToken(db: AppDatabase, config: ServerConfig): BootstrapTokenHolder {
  const bootstrap = new BootstrapTokenHolder();

  // A token that outlives the process would be a token in a file nobody owns.
  // Registered whether or not one is minted here: boot may mint into this holder
  // later, when a failed educator seed hands the installation back to the wizard.
  process.once("exit", () => {
    bootstrap.clear();
    removeBootstrapTokenFile(config.bootstrapTokenPath);
  });

  if (isSetupComplete(db)) return bootstrap;

  mintBootstrapToken(bootstrap, config);
  return bootstrap;
}

/**
 * Mint into an existing holder and put the token where an operator can read it.
 *
 * Separate from `announceBootstrapToken` because setup can reopen after boot has
 * already decided not to mint, and the token has to land in the holder the rest
 * of the process is reading — a second `BootstrapTokenHolder` would be a token
 * nothing verifies against.
 */
function mintBootstrapToken(bootstrap: BootstrapTokenHolder, config: ServerConfig): void {
  const token = bootstrap.mint();
  log.info(bootstrapBanner({ token, appOrigin: config.appOrigin }));

  if (config.bootstrapTokenPath) {
    writeBootstrapTokenFile(config.bootstrapTokenPath, token.display);
  }
}

function writeBootstrapTokenFile(path: string, token: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Removed first: `mode` applies at creation, so an existing file would keep
    // whatever permissions it already had.
    rmSync(path, { force: true });
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
  } catch (cause) {
    // A sink that cannot be written is not a reason to refuse to start; the
    // console banner is the one that always exists.
    log.warn("could not write the bootstrap token file", { cause: describeCause(cause) });
  }
}

function removeBootstrapTokenFile(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing useful to do at exit, and nothing left to protect: the token in
    // memory is gone with the process either way.
  }
}

/**
 * Forget the bootstrap token — called once, when setup completes.
 *
 * Both sinks, in one place, so a future caller cannot clear the memory copy and
 * leave the file behind.
 */
export function clearBootstrapToken(): void {
  getServices().bootstrap.clear();
  removeBootstrapTokenFile(getConfig().bootstrapTokenPath);
}

function getServices(): Services {
  services ??= boot();
  return services;
}

export function getDb(): AppDatabase {
  return getServices().db;
}

export function getGatewayAdapter(): GatewayAdapter {
  return getServices().adapter;
}

/** The local file store for attachments and generated images (§15, §21). */
export function getFileStore(): FileStore {
  return getServices().files;
}

/** The MCP client, or null when no servers are configured (§11). */
export function getMcpClient(): McpClient | null {
  return getServices().mcp;
}

/** The job scheduler, for the panel to report on and for tests to trigger (§16, §21). */
export function getJobScheduler(): JobScheduler {
  return getServices().jobs;
}

/** The first-run bootstrap token holder (§6.2). Empty once setup is complete. */
export function getBootstrapTokens(): BootstrapTokenHolder {
  return getServices().bootstrap;
}
