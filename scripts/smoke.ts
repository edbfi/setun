/**
 * Smoke test of the production entry: `bun ./server.js` over the built `build/`.
 * Run after `bun run build`; CI runs it as `bun run smoke`.
 *
 * A cold installation with a dummy environment: a synthetic ORIGIN (without one
 * the server exits at startup), throwaway paths, an unreachable model gateway and
 * no educator seed, so boot prints the first-run banner and `/` leads to `/setup`.
 * Then SIGTERM must drain and exit 0. Nothing here is a real credential.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import en from "../messages/en.json" with { type: "json" };

// An OS-assigned free port, unless SMOKE_PORT names one. Readiness is this server's own
// "Listening on" line, so a different listener on the port can never pass for it.
let port = Number(process.env.SMOKE_PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("invalid SMOKE_PORT");
if (port === 0) {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  if (probe.port === undefined) throw new Error("no free port assigned");
  port = probe.port;
  await probe.stop(true);
}

const origin = `http://127.0.0.1:${port}`;
const expectedTitle = `${en.setup_title} · ${en.app_name}`;
const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "setun-smoke-"));
// In production Setun refuses a missing database file (a dropped volume); a new
// installation creates it deliberately, as here.
const databasePath = join(root, "db", "setun.sqlite");
mkdirSync(join(root, "db"));
writeFileSync(databasePath, "");

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  // A developer's own Setun, adapter or seed settings must not leak into the cold boot.
  const leaks = /^(SETUN_|ORIGIN$|SOCKET_PATH$|HOST$|PORT$|[A-Z]+_HEADER$|XFF_DEPTH$)/;
  if (value !== undefined && !leaks.test(key)) env[key] = value;
}
Object.assign(env, {
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  PORT: String(port),
  ORIGIN: origin,
  SHUTDOWN_TIMEOUT: "5",
  SETUN_STUDENT_CODE_PEPPER: "smoke-pepper-not-a-real-secret",
  SETUN_CPA_LISTENER_KEY: "smoke-listener-key-not-a-real-secret",
  // Nothing listens on port 9: the smoke never reaches a model gateway.
  SETUN_CPA_BASE_URL: "http://127.0.0.1:9",
  SETUN_SANDBOX_ORIGIN: "http://artifacts.smoke.invalid",
  SETUN_DATABASE_PATH: databasePath,
  SETUN_STORAGE_PATH: join(root, "storage"),
  SETUN_BACKUP_PATH: join(root, "backups"),
});

// --no-env-file: a developer's `.env` would otherwise refill what was removed above.
const server = Bun.spawn(["bun", "--no-env-file", "./server.js"], {
  env,
  stdout: "pipe",
  stderr: "pipe",
});
let log = "";
const stdoutDone = (async () => {
  const decoder = new TextDecoder();
  for await (const chunk of server.stdout) log += decoder.decode(chunk, { stream: true });
})();
const stderr = new Response(server.stderr).text();
const timeout = () => AbortSignal.timeout(5_000);

async function waitForServer(): Promise<void> {
  const ready = `Listening on ${origin}/ for ${origin}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early with ${server.exitCode}`);
    if (log.includes(ready)) return;
    await Bun.sleep(100);
  }
  throw new Error(`server did not report listening on ${origin}`);
}

async function check(): Promise<void> {
  await waitForServer();

  const home = await fetch(`${origin}/`, { redirect: "manual", signal: timeout() });
  const location = home.headers.get("location");
  if (home.status < 300 || home.status > 399 || !location) {
    throw new Error(`/ answered ${home.status} without a redirect`);
  }
  const target = new URL(location, origin);
  if (target.origin !== origin || target.pathname !== "/setup") {
    throw new Error(`/ redirected to ${target.pathname} on ${target.origin}, not /setup`);
  }
  console.log(`ok /: ${home.status} -> /setup`);

  const setup = await fetch(target, { headers: { "accept-language": "en" }, signal: timeout() });
  const html = await setup.text();
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim();
  if (setup.status !== 200 || title !== expectedTitle) {
    throw new Error(`/setup: status ${setup.status}, title ${JSON.stringify(title)}`);
  }
  console.log(`ok /setup: ${title}`);
}

const failures: string[] = [];
try {
  await check();
} catch (error) {
  failures.push(String(error));
}

if (server.exitCode === null) {
  server.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    server.exited.then(() => "exited"),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 20_000);
    }),
  ]);
  clearTimeout(timer);
  if (exited === "timeout") {
    server.kill("SIGKILL");
    await server.exited;
    failures.push("server did not exit within 20 s of SIGTERM");
  } else if (server.exitCode !== 0 || server.signalCode !== null) {
    failures.push(`SIGTERM: exit code ${server.exitCode}, signal ${server.signalCode}`);
  } else {
    console.log("ok SIGTERM: exit code 0");
  }
}

await stdoutDone;
// The operator's banner, which carries the setup address; its one-time token is not repeated.
if (!log.includes("Setun first-run setup") || !log.includes(`Open   ${origin}/setup`)) {
  failures.push("first-run banner with the setup address missing from stdout");
} else {
  console.log("ok banner: first-run setup address printed");
}
rmSync(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`server stdout:\n${log}\nserver stderr:\n${await stderr}`);
  console.error(failures.join("\n"));
  process.exit(1);
}
