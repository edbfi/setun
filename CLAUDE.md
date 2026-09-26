# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Deps not installed? `bun install --frozen-lockfile`. Its `prepare` script compiles
`src/lib/paraglide/` and runs `svelte-kit sync`; type checks and Vitest fail without them.

```sh
bun run check            # svelte-kit sync + svelte-check + tsgo native check; the type authority
bun run lint             # biome ci (read-only); `bun run format` writes fixes
bun test                 # *.test.ts only (bunfig.toml ignores the other runners' files)
bun run test:component   # Vitest client (Chromium) then server project
bunx playwright test     # e2e; builds the app and all three sandbox passes first
bun run check:python     # dev-suite Python (scripts/lib/devsuite)
bun run build            # BOTH build/ and build-sandbox/; plain `vite build` omits the sandbox
```

Single file / single case:
```sh
bun test src/lib/artifacts/detect.test.ts -t "recognises the five artifact tags"
bunx vitest run --project client src/lib/components/ui/FieldError.svelte.spec.ts -t "<name>"
bunx vitest run --project server src/lib/classroom/state-label.spec.ts
bunx playwright test e2e/chat.e2e.ts --project=app -g "<name>"   # setup.e2e.ts is --project=setup
```

Run the Vitest projects one after the other, not in parallel: both regenerate SvelteKit and
Paraglide output. Playwright reuses already-running servers on ports 4173-4175 outside CI, so a
stale server there means you are testing an old build. Keep `workers: 1`; suites share one database
and the per-IP login limiter.

## The suffix picks the runner (a wrong suffix is silently never run)

| Testing | Suffix | Runner |
| --- | --- | --- |
| Pure logic, server modules, DB queries | `*.test.ts` | `bun test` |
| `.svelte` components **and `.svelte.ts` rune modules** | `*.svelte.spec.ts` | Vitest `client` (browser) |
| Needs Vite resolution (`$app/*`, `$env/*`, virtual modules) | `*.spec.ts` | Vitest `server` |
| Real server flows | `e2e/*.e2e.ts` | Playwright |

`bun test` has no Svelte compiler, so runes never run under it. Every rune-module test is a
`*.svelte.spec.ts`, for example `src/lib/state/theme.svelte.spec.ts`; README and the `bunfig.toml`
comment say otherwise and are wrong. Never name a file `*.svelte.test.ts`: `bun test` picks it up
and fails.

## Where the repo overrides `.agents/rules/svelte5-sveltekit-app.md` (follow the repo)

- UnoCSS uses **`presetWind4`** and the root `unocss-preset-shadcn` entry (`uno.config.ts`), not
  Wind3 / `unocss-preset-shadcn/v3`.
- Biome formats with 2 spaces and double quotes (`biome.json`), not tabs and single quotes.
- Scripts: `dev`/`build` run Vite under `bun --bun`; unit script is `test:component`, not
  `test:unit`; production is `bun ./server.js`, never `bun ./build/index.js`. The latter skips the
  process guard in `server-guard.js`.

## Server code

Routes stay thin: guard, `getDb()` from `$lib/server/boot`, then call the query or domain functions.
Query functions take the db handle as their first argument (`src/lib/server/db/queries/*`). Canonical
shape, from `src/routes/api/conversations/+server.ts`:

```ts
export const GET: RequestHandler = ({ locals }) => {
  const student = requireStudentApi(locals);
  const conversations = listConversations(getDb(), student.id).map(/* shape */);
  return json({ conversations });
};
```

Guards (`src/lib/server/auth/guards.ts`):
| Where the guard runs | Student | Educator |
| --- | --- | --- |
| `load` and form actions (redirects to login) | `requireStudentPage` | `requireEducatorPage` |
| `+server.ts` endpoints (401, no redirect) | `requireStudentApi` | `requireEducatorApi` |

Every form action calls its guard itself. The `(panel)/+layout.server.ts` guard does not run before
actions.

- Read config with `getConfig()` from `src/lib/server/config.ts`, not `process.env` or `$env/*`.
  To add a `SETUN_*` variable, update `ConfigSchema` and `readEnvironment` there, `.env.example`, and
  the `app` service's `environment:` in `docker-compose.yml`. Compose has no `env_file`, so a
  variable missing there never reaches production.
- Validate with Valibot: `superValidate` (sveltekit-superforms) for multi-field forms, and
  `v.safeParse` on `formData` for single-id actions. Both appear in
  `src/routes/(educator)/educator/(panel)/models/+page.server.ts`.
- Runtime image (`Dockerfile`) ships only `build/`, `drizzle/`, `server.js`, `server-guard.js` and
  `recover-educator.js`. Any other file needed at runtime must be added there.

## Database changes

1. Edit or add a module in `src/lib/server/db/schema/`, and re-export it from `schema/index.ts`.
2. `bunx drizzle-kit generate --name <slug>`, then commit `drizzle/*.sql` and `drizzle/meta/*`.
   They run at boot (`applyMigrations`), in one transaction with foreign keys on. Never edit a
   migration that is already committed.
3. A `NOT NULL` column on an existing table needs a constant `.default(...)`. `$defaultFn` (as in
   `schema/helpers.ts`) never reaches the DDL, so the migration fails only on a populated database.
   If generated SQL can't work, hand-order the new file like `drizzle/0012_artifact_project_files.sql`.
   A generated `PRAGMA foreign_keys=OFF` is a silent no-op there. Data-moving migrations get an
   upgrade case in `src/lib/server/db/migrate.test.ts`.
4. Add query functions in `db/queries/<aggregate>.ts` with a `*.test.ts` beside them:

```ts
beforeEach(() => {
  db = createTestDatabase();       // in-memory, runs the committed migrations
  fixtures = seedTestFixtures(db); // classroom + alias + student
});
```
(`src/lib/server/db/queries/messages.test.ts`; helpers are in `src/lib/server/db/testing.ts`.)

## UI

- No bare user-facing strings. Add each key to both `messages/en.json` and `messages/da.json`, then
  use it as `import * as m from "$lib/paraglide/messages"` and `m.key()`. `src/lib/paraglide/` is
  generated; never edit it.
- Theme tokens in `uno.config.ts` are bare oklch components. In a `<style>` block, write
  `oklch(var(--muted))`: a bare `var(--muted)` is an invalid colour and silently renders
  transparent. Dark mode is `.dark` on `<html>` (set before first paint in `src/app.html`, key
  `setun:theme`); check both themes.
- shadcn-svelte: `bunx shadcn-svelte add <component> --skip-preflight`, never `init`.
  `tailwind.config.js` is an empty stub for the CLI.
- Biome cannot fully parse `.svelte` markup. Never run `--unsafe` fixes on components.
  `bun run check` is the authority there.
- To show an artifact, call `reveal()` / `select()` on `ArtifactWorkspace`
  (`src/lib/state/artifacts.svelte.ts`) rather than assigning `stage`. Layout lives in
  `src/lib/components/workspace/`, not in `src/routes/(student)/chat/`.

## Commits

Run `prek install` first (`prek.toml`). Its hooks block commits to `main`, enforce Conventional
Commits and run gitleaks. Pre-push runs `bun run check` and `bun test`.

## Stale references

Comments cite `PRD §N`, `plan N.N` and `docs/setun-*.md`. None of these exist (`docs/` was
deleted in `16ff9c5`). Read them as intent; don't search for or recreate them.

## Reference

- `.agents/rules/svelte5-sveltekit-app.md`: runes, load/actions, and shadcn-svelte/bits-ui idiom,
  plus an anti-pattern table. Read before writing components or SvelteKit route files (subject to
  the overrides above).
- `README.md`: dev-suite commands, `--production` mode, deployment, and educator recovery. Read
  before running the full stack or changing `Caddyfile`, `docker-compose.yml` or `Dockerfile`.
