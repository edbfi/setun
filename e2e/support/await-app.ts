export {};

/**
 * Block until the application server is answering.
 *
 * Playwright starts every `webServer` entry at once, and the application's entry
 * is the one that runs `vite build`. The first-run suite's server needs that
 * build to exist before `bun ./server.js` means anything, so its command
 * waits here first.
 *
 * A readiness poll rather than a file check: `build/index.js` appears partway
 * through the build, and a server started from a half-written bundle fails in a
 * way that looks like a product bug.
 */
const url = process.env.SETUN_E2E_APP_URL;
if (!url) {
  console.error("SETUN_E2E_APP_URL is required");
  process.exit(1);
}

const DEADLINE_MS = 10 * 60 * 1000;
const INTERVAL_MS = 500;
const startedAt = Date.now();

while (Date.now() - startedAt < DEADLINE_MS) {
  try {
    await fetch(url, { redirect: "manual" });
    process.exit(0);
  } catch {
    await Bun.sleep(INTERVAL_MS);
  }
}

console.error(`the application server at ${url} did not answer within ten minutes`);
process.exit(1);
