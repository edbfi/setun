import { defineConfig } from "@playwright/test";

/**
 * Setun runs on two origins (PRD §6): the application, and the artifact sandbox.
 * Both are served here, by two independent servers: the application by
 * `bun ./server.js`, and the sandbox by the prebuilt static files Caddy serves
 * in a real deployment. Sharing one server would mean one origin, and origin
 * separation is the entire artifact isolation mechanism (§14).
 */
const APP_PORT = Number(process.env.SETUN_E2E_APP_PORT ?? 4173);
export const SANDBOX_PORT = Number(process.env.SETUN_E2E_SANDBOX_PORT ?? 4174);
const GATEWAY_PORT = Number(process.env.SETUN_E2E_GATEWAY_PORT ?? 4175);

/**
 * A fourth server, for the first-run suite alone (PRD §6.2).
 *
 * The other suites need a seeded educator; this one needs the opposite — a cold
 * installation with the seed variables *unset*, so boot mints a bootstrap token
 * and the gate sends everything to `/setup`. The two cannot share a server or a
 * database file, because completing setup in one would silently change what
 * every other suite is testing.
 */
const SETUP_PORT = Number(process.env.SETUN_E2E_SETUP_PORT ?? 4176);

export const APP_ORIGIN = `http://localhost:${APP_PORT}`;
export const SANDBOX_ORIGIN = `http://localhost:${SANDBOX_PORT}`;
export const SETUP_ORIGIN = `http://localhost:${SETUP_PORT}`;

/**
 * A disposable database per run, so a suite never inherits another's students,
 * conversations or turns. Exported for the seed helper.
 */
export const E2E_DATABASE_PATH = "./test-results/e2e/setun.sqlite";

/**
 * Attachments and generated images, kept beside the disposable database.
 *
 * Outside any web root, as they are in a real deployment — nothing serves this
 * directory, and every read goes through an owner-scoped endpoint (§21).
 */
export const E2E_STORAGE_PATH = "./test-results/e2e/storage";

/** Test-only pepper. Real deployments supply a secret via `.env` (§6.2, §7). */
export const E2E_PEPPER = "e2e-pepper-not-a-real-secret";

/**
 * The operator account, seeded from deployment configuration at boot (§7, §6.2).
 *
 * Test-only values. There is no in-application password recovery, so re-seeding
 * these and restarting is how a real deployment resets the credential — which is
 * exactly what a fresh e2e run does.
 */
export const E2E_EDUCATOR_USERNAME = "e2e-educator";
export const E2E_EDUCATOR_PASSWORD = "e2e-educator-password-not-a-real-secret";

/** The first-run suite's own disposable tree, beside the others and never shared. */
const SETUP_ROOT = "./test-results/e2e-setup";

/**
 * Where the first-run server writes its bootstrap token (§6.2).
 *
 * The console banner is the operator's channel and always written; this file is
 * the opt-in second sink, and the only one a test can read — Playwright gives a
 * suite no access to a `webServer` child's stdout. There is deliberately no
 * endpoint that returns the token.
 */
export const SETUP_TOKEN_PATH = `${SETUP_ROOT}/bootstrap-token`;

const appEnv = {
  PORT: String(APP_PORT),
  // SvelteKit's CSRF origin check compares against this, through the front in
  // server.js, which does not start without it (or SETUN_APP_ORIGIN below).
  ORIGIN: APP_ORIGIN,
  SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
  SETUN_STORAGE_PATH: E2E_STORAGE_PATH,
  SETUN_STUDENT_CODE_PEPPER: E2E_PEPPER,
  SETUN_CPA_LISTENER_KEY: "e2e-listener-key",
  SETUN_EDUCATOR_SEED_USERNAME: E2E_EDUCATOR_USERNAME,
  SETUN_EDUCATOR_SEED_PASSWORD: E2E_EDUCATOR_PASSWORD,
  // The stub gateway stands in for CPA; everything from the route down is real.
  SETUN_CPA_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
  SETUN_APP_ORIGIN: APP_ORIGIN,
  SETUN_SANDBOX_ORIGIN: SANDBOX_ORIGIN,
};

export default defineConfig({
  testMatch: "**/*.e2e.ts",
  /**
   * One worker, because the suites are not independent of each other.
   *
   * Playwright runs test *files* in parallel by default, but every suite here
   * shares one application server, one SQLite file, and the global state inside
   * it: the per-IP login window (every worker is loopback, Appendix A caps one
   * address at 30 attempts per 15 minutes) and the model aliases the seed helper
   * creates. A suite's `beforeEach` can clear the login window for itself, but
   * it cannot stop a suite running beside it from filling the window up again
   * before the sign-in that needed it — which surfaces as a login that silently
   * stays on /login, a duplicate alias insert, or a request answered 403.
   *
   * The classrooms are already separated per suite (`SETUN_E2E_CLASSROOM`).
   * What is left is global by nature, so the suites are serialised rather than
   * given a limiter that is weaker under test than in production.
   */
  workers: 1,
  use: { baseURL: APP_ORIGIN },
  /**
   * Two projects, because the two application servers are different
   * installations: one seeded and set up, one deliberately cold.
   */
  projects: [
    { name: "app", testIgnore: "**/setup.e2e.ts", use: { baseURL: APP_ORIGIN } },
    { name: "setup", testMatch: "**/setup.e2e.ts", use: { baseURL: SETUP_ORIGIN } },
  ],
  webServer: [
    {
      command: `rm -rf ${E2E_DATABASE_PATH.replace(/\/[^/]+$/, "")} && bun --bun vite build && bun ./server.js`,
      port: APP_PORT,
      reuseExistingServer: !process.env.CI,
      // SIGTERM (not Playwright's default SIGKILL) lets server.js drain and
      // remove its private socket directory.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      env: appEnv,
    },
    {
      // The artifact host, built and served exactly as Caddy serves it — the
      // same content security policy included, because that policy is what the
      // escape suite is testing (§14, §22).
      command: "bun run build:sandbox && bun --bun vite preview --config sandbox/vite.config.ts",
      port: SANDBOX_PORT,
      reuseExistingServer: !process.env.CI,
      env: { SETUN_SANDBOX_PORT: String(SANDBOX_PORT) },
    },
    {
      command: "bun run e2e/support/stub-gateway-server.ts",
      port: GATEWAY_PORT,
      reuseExistingServer: !process.env.CI,
      env: { SETUN_E2E_GATEWAY_PORT: String(GATEWAY_PORT) },
    },
    {
      /**
       * The cold installation.
       *
       * It waits for the application server rather than building for itself:
       * every `webServer` starts at once, and two concurrent `vite build` runs
       * would write over each other's output.
       */
      command: `rm -rf ${SETUP_ROOT} && bun run e2e/support/await-app.ts && bun ./server.js`,
      port: SETUP_PORT,
      /**
       * Never reused, unlike the others.
       *
       * Setup can only be done once per database, so a server left over from a
       * previous run is a *completed* installation — and the suite would be
       * testing a `404` instead of a wizard. A fresh process with a fresh
       * database is the only starting state this suite has.
       */
      reuseExistingServer: false,
      timeout: 10 * 60 * 1000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      env: {
        SETUN_E2E_APP_URL: APP_ORIGIN,
        PORT: String(SETUP_PORT),
        ORIGIN: SETUP_ORIGIN,
        SETUN_APP_ORIGIN: SETUP_ORIGIN,
        SETUN_SANDBOX_ORIGIN: SANDBOX_ORIGIN,
        SETUN_DATABASE_PATH: `${SETUP_ROOT}/setun.sqlite`,
        SETUN_STORAGE_PATH: `${SETUP_ROOT}/storage`,
        SETUN_BACKUP_PATH: `${SETUP_ROOT}/backups`,
        SETUN_STUDENT_CODE_PEPPER: E2E_PEPPER,
        SETUN_CPA_LISTENER_KEY: "e2e-listener-key",
        SETUN_CPA_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
        SETUN_BOOTSTRAP_TOKEN_PATH: SETUP_TOKEN_PATH,
        // Deliberately no SETUN_EDUCATOR_SEED_* here: their absence is the
        // whole point of this server.
      },
    },
  ],
});
