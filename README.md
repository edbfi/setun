<p align="center">
  <img src="static/setun-mark.svg" alt="Setun logo" width="192" height="192">
</p>

<h1 align="center">Setun</h1>

<p align="center">
  <strong>A privacy-first AI learning environment for classrooms</strong>
</p>

<p align="center">
  <a href="https://github.com/edbpede/setun/actions/workflows/ci.yml"><img src="https://github.com/edbpede/setun/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/edbpede/setun/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0 license"></a>
  <img src="https://img.shields.io/badge/Bun_1.4+-000000?logo=bun&logoColor=white" alt="Bun 1.4 or newer">
  <img src="https://img.shields.io/badge/SvelteKit_2-FF3E00?logo=svelte&logoColor=white" alt="SvelteKit 2">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white" alt="SQLite">
</p>

---

## What is Setun?

Setun is a self-hosted environment for teaching AI and *Teknologiforståelse*. Students use
pseudonymous access cards instead of accounts, email addresses, or real names. Educators control
which models, skills, tools, schedules, and spending limits each classroom receives.

The application combines streaming AI chat with a code artifact workspace, while keeping generated
code on a separate, tightly restricted origin. Model credentials stay behind an internal gateway and
never reach the browser or the Setun database.

The name comes from the 1958 Setun computer, built around balanced ternary. The mark stacks its three
states: minus, zero, and plus.

## Features

- **Pseudonymous student access** — issue printable access cards without collecting names, email
  addresses, or third-party identities.
- **Classroom controls** — manage rosters, weekly schedules, temporary locks, model allowlists,
  instructions, retention, and daily or per-student budgets.
- **Streaming AI chat** — run classroom-scoped conversations with attachments, search, cancellation,
  and model aliases chosen by the educator.
- **Live artifacts beside the conversation** — preview, edit, rerun, and version HTML, SVG, JSX,
  TSX, and Svelte creations in a pane that never covers the composer, so a student can look at what
  the model made while asking for the next change. One control moves the workspace between the
  conversation, both, and the build. Artifacts are built up over several turns: the model writes an
  id on the fence (` ```html id=home-page `) and reuses it to revise the same thing, and a run's
  outcome travels back so the next answer can fix the error the student saw.
- **Curated capabilities** — publish reusable skills and expose only approved MCP tools, with
  per-classroom controls for tools that require confirmation.
- **Image workflows** — support image attachments and model-generated images without exposing the
  underlying storage directory.
- **English and Danish** — complete localized interfaces, with a classroom default and per-student
  override.
- **Light and dark** — the interface follows the device by default, with an explicit choice stored
  in the browser and never against the student.
- **Self-hosted operations** — SQLite persistence, automatic migrations, retention jobs, nightly
  snapshots, and a Compose deployment behind Caddy.

## Architecture

```mermaid
flowchart LR
  Browser[Student and educator browsers] -->|app.example.org| Caddy
  Browser -->|artifacts.example.org| Caddy
  Caddy --> App[Setun app]
  Caddy --> Sandbox[Static artifact sandbox]
  App --> SQLite[(SQLite)]
  App --> Storage[(Private file storage)]
  App --> CPA[CLIProxyAPI]
  CPA --> Providers[AI providers]
  App --> MCP[Approved MCP servers]
```

The application and artifact sandbox must use different hostnames. That origin boundary is part of
the security model: Caddy serves the sandbox as static files with a restrictive content security
policy, and generated code has no route back into the authenticated application. CLIProxyAPI is
reachable only from the app's internal network and has no published host port.

## Tech stack

| Layer | Technology |
| --- | --- |
| Runtime and package manager | [Bun](https://bun.com) 1.4+ |
| Application | [SvelteKit](https://svelte.dev/docs/kit) 2, Svelte 5, TypeScript |
| UI | UnoCSS, shadcn-svelte, bits-ui |
| Data | SQLite with Drizzle ORM |
| Validation and forms | Valibot and sveltekit-superforms |
| Localization | Paraglide JS |
| Model gateway | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) |
| Production edge | Caddy and Docker Compose |
| Quality gates | svelte-check, Biome, Bun test, Vitest, Playwright, Python, repository hygiene |

## Quick start

For local development, install:

- [Bun](https://bun.com) 1.4 or newer
- Python 3.14 for the development suite
- [prek](https://prek.j178.dev) for repository hooks

Then run:

```sh
bun install
prek install
./scripts/devsuite start
```

The suite starts the application, sandbox, and a persistent development database, then prints the
student and educator URLs and credentials. Development secrets are generated per instance when they
are not present in the environment or `.env`; the suite never writes them to `.env`.

The default application is at `http://localhost:5173`, with educator login at
`http://localhost:5173/educator/login`. The sandbox runs separately on port `5174`. Pressing Ctrl-C
stops an attached stack while preserving its data.

Useful commands:

```sh
./scripts/devsuite status                 # show services, ports, and health
./scripts/devsuite logs app               # follow one service
./scripts/devsuite stop                   # stop and preserve the default instance
./scripts/devsuite start --ephemeral      # use a disposable database
./scripts/devsuite start --with-cpa       # include the model gateway; needs Docker
./scripts/devsuite start --production     # reproduce the Caddy deployment locally
./scripts/devsuite --help                 # all commands and options
```

Production mode serves `http://setun.localhost:8080` and
`http://sandbox.setun.localhost:8080`. It builds both applications, runs the adapter-node server
behind the repository's Caddy configuration, and uses Caddy's static file server for artifacts. TLS
is the only production behavior omitted.

To run the two development servers manually instead:

```sh
bun --bun run dev       # application on :5173
bun run dev:sandbox     # sandbox on :5174, in a second terminal
```

## First-time setup

### 1. Prepare the deployment

You need Docker with Compose, Bun 1.4+, and two DNS names pointing to the host: one for Setun and one
for the artifact sandbox.

```sh
bun install --frozen-lockfile
cp .env.example .env
cp cpa/config.example.yaml cpa/config.yaml
cp mcp.example.json mcp.json
```

Fill in `.env`, then configure the provider account in `cpa/config.yaml`. Two secrets deserve special
care:

- `SETUN_STUDENT_CODE_PEPPER` must be high-entropy and permanent. Changing it invalidates every
  existing student access code.
- `SETUN_CPA_LISTENER_KEY` must exactly match the value under `api-keys` in
  `cpa/config.yaml`.

`SETUN_APP_ORIGIN` and `SETUN_SANDBOX_ORIGIN` must be full public URLs on different hosts. Their
hostname-only counterparts configure Caddy. Leave both educator seed variables blank to use the
guided first-run setup.

MCP is optional. If the installation offers no tools, replace the example entry in `mcp.json` with
an empty `servers` object. Credentials are referenced there by environment-variable name; do not put
secret values in the JSON file.

### 2. Build and start

```sh
bun run build:sandbox
docker compose up -d --build
docker compose logs app
```

The sandbox build is explicit because Caddy serves `build-sandbox/` directly from the host. The app
itself is built into its container image.

### 3. Complete the wizard

On an unconfigured database, Setun writes a one-time setup token to the app log and redirects every
route to `/setup`. Open the application URL, enter the token, and follow the wizard to:

1. Create the educator account.
2. Verify the model gateway.
3. Add the first model alias.
4. Create a classroom.
5. Issue the first student access cards.

The token expires after 15 minutes; restarting the app issues a new one. If
`SETUN_EDUCATOR_SEED_USERNAME` and `SETUN_EDUCATOR_SEED_PASSWORD` are both set, Setun seeds that
account at boot and skips the wizard. Updating the seeded credential and restarting remains a
supported recovery path for forgotten educator credentials.

## Educator credential recovery

The educator login page shows a generic command that an operator with shell access can run against
the live database. The browser never performs the reset, and recovery needs neither manual SQL nor
an application restart.

From the deployment directory, use the interactive mode to enter a new educator username and a new
password. Both password prompts hide terminal input:

```sh
docker compose exec app bun /app/recover-educator.js
```

To have Setun generate a 256-bit password instead, run:

```sh
docker compose exec app bun /app/recover-educator.js --generate
```

The generated password is printed exactly once, on its own terminal line after the database commit.
Setun does not copy it to the clipboard or write it to a log or configuration file. Save it before
closing the terminal; if it is lost, run recovery again. The new username is always collected by the
prompt, so neither credential belongs in shell history or a process listing.

For a source-based installation or manual development server, run the matching package scripts from
the repository root:

```sh
bun run recover:educator
bun run recover:educator -- --generate
```

The application must already be running on an existing, migrated database. Compose supplies the
container with the same database path and seed environment automatically. For a direct invocation,
run from the same configured environment as the application: `SETUN_DATABASE_PATH` must identify the
live database, and the command must see the same `SETUN_EDUCATOR_SEED_*` values when they are used.
Bun loads the repository's `.env` automatically. The command refuses a missing database, a partial
seed pair, a non-interactive terminal, and any password supplied as an argument.

Recovery updates the one educator row and invalidates every live educator session in one immediate
SQLite transaction. Pupil sessions and all classroom data, conversations, artifacts, files, and
backups are untouched. Exit status `0` means success, `1` an operational failure with no committed
change, `2` invalid usage or input, and `130` cancellation.

Boot-time seeds remain backward compatible. A CLI recovery stores only an Argon2id hash identifying
the seed pair that it superseded, so restarting with that unchanged pair cannot silently restore the
old credentials. Changing either seed value and restarting is treated as an intentional seed-based
reset, updates the same educator row, and invalidates educator sessions. Leaving both variables blank
keeps the recovered credential under CLI control; the recovery command never edits `.env` itself.

## Student access slips and QR sign-in

The roster can replace one pupil's access code or every active pupil's code and produce A4 access
slips for printing or direct PDF download. Reissuing a slip immediately invalidates the previous code
and that pupil's signed-in sessions. Plaintext codes exist only in the issuing action response; Setun
does not store them, and reloading or leaving the page makes them unrecoverable.

Each QR code contains the configured application origin followed by `/login#code=…`. The access code
is in the URL fragment, so browsers do not send it in HTTP requests or referrers, and the login page
removes the fragment from browser history before submitting through the normal sign-in action. PDF
files are generated entirely in the browser; no credential-bearing PDF request reaches the server.

An access slip is still a bearer credential: anyone with a copy can sign in as that pseudonymous
pupil until the code is rotated, the account is disabled or removed, or normal access policy blocks
the sign-in. Store and distribute printed and downloaded copies accordingly.

## Configuration notes

- **Provider credentials** belong to CLIProxyAPI, not Setun. Its management API, control panel,
  plugins, and public port are disabled by the supplied configuration.
- **MCP servers** are defined in the read-only `mcp.json`; the educator panel may enable configured
  servers and tools but cannot add endpoints.
- **Persistent data** lives in separate Compose volumes for the database, private storage, backups,
  provider authentication, and Caddy state.
- **TLS** is handled automatically by Caddy for publicly reachable hostnames. For a closed network,
  use Caddy's internal CA as described in the comments in `Caddyfile`.
- **Backups** contain a consistent SQLite snapshot plus private storage. Fourteen daily snapshots are
  retained by default; copy the backup volume off-host for disaster recovery.

## Development

Every build has two outputs:

- `build/` — the adapter-node application
- `build-sandbox/` — the static artifact host, runtimes, and compilers

Always use `bun run build`; running only the SvelteKit build leaves the artifact panel without the
files it needs. The development suite keeps each named instance under `.devsuite/instances/` with
its own database, logs, and production build outputs.

### Quality gates

CI preserves the five application checks and adds Python and repository hygiene checks.
The required aggregate blocks missing, skipped, cancelled, and failed jobs. See [CI.md](CI.md).

```sh
bun run check         # Svelte and TypeScript correctness
bunx biome ci         # formatting and linting
bun test              # server logic and rune modules
bun run test:component # Chromium components and Vite server tests
bunx playwright test  # end-to-end flows
bun run check:python  # locked Ruff, format, strict types, syntax
```

Install Chromium once with `bunx playwright install chromium` if it is not already available.

Test filenames select their runner:

| Scope | Filename | Runner |
| --- | --- | --- |
| Server logic and `.svelte.ts` rune modules | `*.test.ts` | Bun |
| Svelte components | `*.svelte.spec.ts` | Vitest Browser Mode |
| Other tests needing Vite resolution | `*.spec.ts` | Vitest server project |
| Real-server flows | `*.e2e.ts` | Playwright |

### Project conventions

- Add every user-facing message to both `messages/en.json` and `messages/da.json`.
- Styling uses UnoCSS, not Tailwind. Add shadcn-svelte components with
  `bunx shadcn-svelte add <component> --skip-preflight`; never run `init`.
- Use `bun run check` as the authority for Svelte templates. Biome does not fully understand Svelte
  markup, so never apply its unsafe fixes to a component.
- The design baseline is tweakcn's clean-slate theme, ported to bare oklch components in
  `uno.config.ts`. A `<style>` block reading one of those variables must wrap it —
  `oklch(var(--muted))` — because the preset's utilities supply the wrapper and a bare `var()`
  silently resolves to transparent. Dark mode is `<html class="dark">`; check both themes.
- Install `prek` before committing. Hooks enforce Conventional Commits, protect `main`, and scan for
  secrets.

See [`AGENTS.md`](AGENTS.md) for the complete repository rules before contributing.

## License

Setun is licensed under the [GNU Affero General Public License v3.0](LICENSE).
