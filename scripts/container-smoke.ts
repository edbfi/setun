/**
 * Container smoke of the Compose deployment: docker-compose.yml with its real images, networks and
 * Caddyfile. Run after `bun run build` (Caddy serves the host's build-sandbox/); CI runs it as
 * `bun run smoke:container`, so a Dependabot bump of the app's base image, CLIProxyAPI or Caddy
 * cannot merge without starting.
 *
 * A dummy installation with nothing real in it: a throwaway env file, a CPA config made from
 * cpa/config.example.yaml with a dummy listener key, and an MCP file with no servers, mounted by a
 * temporary override that also publishes Caddy on a random loopback port instead of 80/443. The
 * operator's own .env, cpa/config.yaml and mcp.json are never read. It follows the README's new
 * installation steps, then checks:
 *
 * - both Compose files pin the same CPA and Caddy images;
 * - through Caddy: the app's `/` -> `/setup` and the first-run banner, and the sandbox's static
 *   files with their isolation headers;
 * - from the app: CPA answers its listener key and nothing else, and its management API is off;
 * - from CPA: a route out (DNS for github.com), which the providers need;
 * - `docker compose stop app` drains and the container exits 0.
 *
 * Not covered: a real provider call, TLS issuance, and the floating `oven/bun:1.4-alpine` and
 * `caddy:2.11-alpine` tags moving after this ran.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import en from "../messages/en.json" with { type: "json" };

const ROOT = join(import.meta.dir, "..");
const LISTENER_KEY = "container-smoke-listener-key-not-a-real-secret";
const APP_HOST = "setun.localhost";
const SANDBOX_HOST = "sandbox.localhost";
const expectedTitle = `${en.setup_title} · ${en.app_name}`;

if (!existsSync(join(ROOT, "build-sandbox", "index.html"))) {
  throw new Error("build-sandbox/ is missing: run `bun run build` first");
}

const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "setun-container-smoke-"));
const project = `setun-container-smoke-${process.pid}`;
const cpaConfig = readFileSync(join(ROOT, "cpa", "config.example.yaml"), "utf8");
if (!cpaConfig.includes("replace-with-the-value-of-SETUN_CPA_LISTENER_KEY")) {
  throw new Error("cpa/config.example.yaml no longer has the listener key placeholder");
}
writeFileSync(
  join(root, "cpa-config.yaml"),
  cpaConfig.replace("replace-with-the-value-of-SETUN_CPA_LISTENER_KEY", LISTENER_KEY),
);
writeFileSync(join(root, "mcp.json"), '{ "servers": {} }\n');
// Explicit `http://` hostnames make Caddy serve plain HTTP and skip ACME, as scripts/devsuite does.
writeFileSync(
  join(root, "smoke.env"),
  [
    "SETUN_STUDENT_CODE_PEPPER=container-smoke-pepper-not-a-real-secret",
    `SETUN_CPA_LISTENER_KEY=${LISTENER_KEY}`,
    `SETUN_APP_ORIGIN=http://${APP_HOST}`,
    `SETUN_SANDBOX_ORIGIN=http://${SANDBOX_HOST}`,
    `SETUN_APP_HOSTNAME=http://${APP_HOST}`,
    `SETUN_SANDBOX_HOSTNAME=http://${SANDBOX_HOST}`,
    "",
  ].join("\n"),
);
writeFileSync(
  join(root, "override.yml"),
  `services:
  app:
    volumes:
      - ${join(root, "mcp.json")}:/config/mcp.json:ro
  cpa:
    volumes:
      - ${join(root, "cpa-config.yaml")}:/CLIProxyAPI/config.yaml:ro
  caddy:
    ports: !override
      - "127.0.0.1::80"
`,
);

// Compose lets shell variables win over --env-file, so a developer's own Setun settings must not
// reach it.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !/^(SETUN_|COMPOSE_)/.test(key)) env[key] = value;
}

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const COMPOSE = [
  "docker",
  "compose",
  "--project-name",
  project,
  "--file",
  "docker-compose.yml",
  "--file",
  join(root, "override.yml"),
  "--env-file",
  join(root, "smoke.env"),
];

function compose(...args: string[]): string {
  const result = run([...COMPOSE, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`docker compose ${args.join(" ")}: exit ${result.exitCode}\n${result.stderr}`);
  }
  return result.stdout;
}

/** The HTTP status a busybox `wget` inside `service` saw, or the error when it saw none. */
function statusFrom(service: string, url: string, headers: string[] = []): number {
  const result = run([
    ...COMPOSE,
    "exec",
    "-T",
    service,
    "wget",
    "-q",
    "-S",
    "-O",
    "/dev/null",
    "-T",
    "5",
    ...headers.flatMap((header) => ["--header", header]),
    url,
  ]);
  const status = result.stderr.match(/HTTP\/[\d.]+ (\d{3})/)?.[1];
  if (status === undefined) throw new Error(`${service}: no HTTP answer from ${url}\n${result.stderr}`);
  return Number(status);
}

function imagesOf(file: string): Record<string, string> {
  const result = run([
    "docker",
    "compose",
    "--file",
    file,
    "--env-file",
    join(root, "smoke.env"),
    "config",
    "--format",
    "json",
  ]);
  if (result.exitCode !== 0) throw new Error(`${file}: docker compose config failed\n${result.stderr}`);
  const services: Record<string, { image?: string }> = JSON.parse(result.stdout).services;
  return Object.fromEntries(
    Object.entries(services).flatMap(([name, service]) => (service.image ? [[name, service.image]] : [])),
  );
}

const timeout = () => AbortSignal.timeout(5_000);
let base = "";

async function waitForApp(): Promise<Response> {
  const deadline = Date.now() + 90_000;
  let last = "no answer";
  while (Date.now() < deadline) {
    const states = compose("ps", "--all", "--format", "{{.Service}} {{.State}}");
    const stopped = states.split("\n").filter((line) => line !== "" && !line.endsWith(" running"));
    if (stopped.length > 0) throw new Error(`services stopped early: ${stopped.join(", ")}`);
    try {
      const home = await fetch(`${base}/`, {
        headers: { host: APP_HOST },
        redirect: "manual",
        signal: timeout(),
      });
      if (home.status !== 502) return home;
      last = "502 from Caddy";
    } catch (error) {
      last = String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`the app did not answer through Caddy within 90 s (${last})`);
}

async function check(): Promise<void> {
  const production = imagesOf("docker-compose.yml");
  const development = imagesOf("scripts/devsuite.compose.yml");
  for (const service of ["cpa", "caddy"]) {
    if (!production[service] || production[service] !== development[service]) {
      throw new Error(
        `${service}: docker-compose.yml pins ${production[service]}, scripts/devsuite.compose.yml ${development[service]}`,
      );
    }
  }
  console.log(`ok images: cpa ${production.cpa}, caddy ${production.caddy} in both Compose files`);

  // The README's new-installation steps: the database file is created deliberately, once.
  compose("build", "app");
  compose("run", "--rm", "--no-deps", "app", "touch", "/data/db/setun.sqlite");
  compose("up", "--detach");
  const published = compose("port", "caddy", "80").trim();
  base = `http://${published}`;

  const home = await waitForApp();
  const location = home.headers.get("location");
  if (home.status < 300 || home.status > 399 || location !== "/setup") {
    throw new Error(`/ answered ${home.status} with location ${JSON.stringify(location)}, not /setup`);
  }
  console.log(`ok /: ${home.status} -> /setup through Caddy`);

  const setup = await fetch(`${base}/setup`, {
    headers: { host: APP_HOST, "accept-language": "en" },
    signal: timeout(),
  });
  const title = (await setup.text()).match(/<title>([^<]*)<\/title>/)?.[1]?.trim();
  if (setup.status !== 200 || title !== expectedTitle) {
    throw new Error(`/setup: status ${setup.status}, title ${JSON.stringify(title)}`);
  }
  console.log(`ok /setup: ${title}`);

  const log = compose("logs", "--no-color", "app");
  if (!log.includes("Setun first-run setup") || !log.includes(`Open   http://${APP_HOST}/setup`)) {
    throw new Error("first-run banner with the setup address missing from the app log");
  }
  console.log("ok banner: first-run setup address printed");

  const sandbox = await fetch(`${base}/index.html`, { headers: { host: SANDBOX_HOST }, signal: timeout() });
  await sandbox.arrayBuffer();
  const csp = sandbox.headers.get("content-security-policy") ?? "";
  if (
    sandbox.status !== 200 ||
    !csp.startsWith("default-src 'none';") ||
    !csp.includes(`frame-ancestors http://${APP_HOST}`) ||
    sandbox.headers.get("access-control-allow-origin") !== "*" ||
    sandbox.headers.get("x-content-type-options") !== "nosniff"
  ) {
    throw new Error(`sandbox /index.html: status ${sandbox.status}, CSP ${JSON.stringify(csp)}`);
  }
  console.log("ok sandbox: /index.html with its isolation headers");

  const models = "http://cpa:8317/v1/models";
  const answers = {
    key: statusFrom("app", models, [`Authorization: Bearer ${LISTENER_KEY}`]),
    wrongKey: statusFrom("app", models, ["Authorization: Bearer not-the-listener-key"]),
    noKey: statusFrom("app", models),
    management: statusFrom("app", "http://cpa:8317/v0/management/config"),
  };
  if (answers.key !== 200 || answers.wrongKey !== 401 || answers.noKey !== 401 || answers.management < 400) {
    throw new Error(`CPA from the app: ${JSON.stringify(answers)}`);
  }
  console.log(`ok cpa: ${JSON.stringify(answers)}`);

  const egress = run([...COMPOSE, "exec", "-T", "cpa", "getent", "hosts", "github.com"]);
  if (egress.exitCode !== 0) throw new Error(`CPA cannot resolve github.com: exit ${egress.exitCode}`);
  console.log("ok cpa egress: github.com resolves");

  compose("stop", "app");
  const exit = run(["docker", "inspect", "--format", "{{.State.ExitCode}}", `${project}-app-1`]).stdout.trim();
  if (exit !== "0") throw new Error(`docker compose stop app: exit code ${exit}`);
  console.log("ok stop: app exited 0");
}

const failures: string[] = [];
try {
  await check();
} catch (error) {
  failures.push(String(error));
  const logs = run([...COMPOSE, "logs", "--no-color"]);
  console.error(`compose logs:\n${logs.stdout}${logs.stderr}`);
} finally {
  run([...COMPOSE, "down", "--volumes", "--remove-orphans", "--rmi", "local"]);
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
