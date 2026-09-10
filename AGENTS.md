# AGENTS.md

This file provides guidance to AI coding agents when working with code in this
repository.

Setun is a self-hosted SvelteKit 2 / Svelte 5 / Bun learning environment. `README.md` covers
setup, the dev suite, deployment and conventions in depth — read it before non-trivial work.

## The missing PRD

Comments throughout the code, and README's "Normative documents" table, cite `docs/setun-prd.md`
(as "PRD §N"), `docs/setun-implementation-plan.md` and `docs/setun-operations.md`. **These files
were deleted in `16ff9c5` and no `docs/` directory exists.** Treat a `PRD §N` reference as a note
about intent, not a pointer to something readable. Don't search for them; don't re-create them.

## Gates

All five must pass. CI (`.github/workflows/ci.yml`) preserves their separate jobs and adds
Python and repository hygiene checks. The fail-closed `ci / required` check requires them all.

```sh
bun run check         # svelte-check — the authority on template and type correctness
bunx biome ci         # format + lint, writes nothing
bun test              # server logic and rune modules
bun run test:component # both Vitest projects; client needs Chromium
bunx playwright test  # end-to-end (needs chromium)
```

Single targets:

```sh
bun test src/lib/artifacts/detect.test.ts -t "case name"
bunx vitest run src/lib/components/ui/FieldError.svelte.spec.ts
bunx playwright test e2e/chat.e2e.ts --project=app -g "case name"
```

## Test placement — the suffix decides the runner

The three suffixes are disjoint and each runner claims only its own files, so a file with the
wrong suffix is silently never executed.

| Target | Suffix | Runner | Config |
| --- | --- | --- | --- |
| Server logic, `.svelte.ts` rune modules | `*.test.ts` | `bun test` | `bunfig.toml` |
| `.svelte` component behaviour | `*.svelte.spec.ts` | Vitest `client` project | `vite.config.ts` |
| Anything else needing Vite resolution (`$app/*`, `$env/*`) | `*.spec.ts` | Vitest `server` project | `vite.config.ts` |
| Flows through a real server | `*.e2e.ts` | Playwright | `playwright.config.ts` |

Playwright is pinned to `workers: 1` because every suite shares one server, one SQLite file and
global per-IP login state. Don't raise it; separate state per suite instead.

## Two origins, two builds

The application and the artifact sandbox are different origins, and that separation *is* the
artifact isolation. `sandbox/` is a standalone Vite app, deliberately outside the SvelteKit
build — never import it from `src/`, and never merge the two builds.

`bun run build` therefore produces two outputs: `build/` (adapter-node) and `build-sandbox/`
(static files Caddy serves). Running only `vite build` leaves the Build panel with nothing to
render. Locally, run both servers — `./scripts/devsuite start` does it in one terminal.

## Generated files — never hand-edit

| Path | Regenerate with |
| --- | --- |
| `src/lib/paraglide/` | `bun install` / `bun run dev` / `bun run build` (from `messages/`) |
| `.svelte-kit/` | `bunx svelte-kit sync` |
| `build/`, `build-sandbox/` | `bun run build` — `server.js` wraps `build/index.js` rather than patching it |
| `drizzle/*.sql` | `bunx drizzle-kit generate` |

Migrations are applied at boot by `applyMigrations` (`src/lib/server/db/migrate.ts`); there is no
operator migration step. After changing `src/lib/server/db/schema/`, run `bunx drizzle-kit
generate` and commit the SQL — `migrate.test.ts` fails otherwise.

## Localisation

No bare user-facing strings in components. Add every key to **both** `messages/en.json` and
`messages/da.json`, then call it as `m.my_key()`. `src/routes/stack-check/` is the worked example
(dev-only; a production build answers 404).

## Styling is UnoCSS, not Tailwind

`tailwind.config.js` is an empty stub that exists only so the shadcn CLI's `add` command runs.
Never run `shadcn-svelte init`; `components.json` is hand-written. Add components with:

```sh
bunx shadcn-svelte add <component> --skip-preflight
```

Theme variables live in `uno.config.ts` as bare **oklch** components, not HSL — `0.967 0.0029
264.54`, with no function around them, because the preset's own colour utilities supply the
wrapper. So a `<style>` block must write `oklch(var(--muted))`; a plain `var(--muted)` resolves to
an invalid colour and silently falls back to transparent.

Light and dark both ship. `<html class="dark">` is what switches the preset's dark block on; the
inline script in `src/app.html` sets it before first paint and `$lib/state/theme.svelte.ts` keeps
it in step, with `setun:theme` as the contract between the two. Never hardcode a light-only
colour — use the tokens, and check both themes.

## The student workspace

`src/routes/(student)/chat/` is wiring only: the turn stream, the endpoints, the refusals. The
layout belongs to `$lib/components/workspace/`.

`ArtifactWorkspace` (`$lib/state/artifacts.svelte.ts`) holds one `stage` — `chat`, `both` or
`build` — and one `fraction`, and knows nothing about geometry. `WorkspaceShell` splits along the
inline axis above `64rem` (`$lib/workspace/axis.ts`) and stacks below it; the same divider is the
sheet's grab handle. Anything that wants to show an artifact calls `reveal()` or `select()` rather
than setting a stage directly, so a pupil already reading one fullscreen is not knocked back into
the split.

## Biome does not parse `.svelte` markup

`noUnusedImports` and `noUnusedVariables` are off for `.svelte` files in `biome.json` — template-
only imports would otherwise read as unused. Never run Biome's `--unsafe` fixes over a component;
use `bun run check` as the authority there.

## Python: the dev suite only

`scripts/lib/devsuite/` is the Python application tooling (stdlib only, 3.14);
`.github/scripts/check-python.py` adapts its documented config for the type checker. Ruff config is
`scripts/ruff.toml`; type checking is `scripts/lib/basedpyrightconfig.json`.

CI and prek automate the type check using the versions in `scripts/uv.lock`. Run
`bun run check:python` from the repository root and expect **0 errors and 0 warnings**.
The wrapper validates the config shape and removes only its prose `//` key from a temporary
tool input; it preserves the import root, scope, and strict diagnostics.
That config file carries a hard rule against global diagnostic overrides: fix the code, or
suppress a single line with `# pyright: ignore[ruleName]` plus a justification — never
`# type: ignore`.

## Commits

`prek install` is required before your first commit. The hooks block direct commits to `main`,
enforce Conventional Commits, and run gitleaks; pre-push runs `bun run check` and `bun test`.

## Reference rules

- `.agents/rules/svelte5-sveltekit-app.md` — Svelte 5 runes / SvelteKit 2 / Bun / UnoCSS /
  shadcn-svelte idiom, version-anchored, with an anti-pattern table. Read before writing any
  component, load function, or SvelteKit boilerplate.
- `.agents/rules/python-3_14-core.md` — Python 3.14 / uv / Ruff / basedpyright conventions. Read
  before touching `scripts/lib/devsuite/`.
- `README.md` — dev suite commands and instance model, `--production` mode, deployment, theme.
  Read before running the stack locally or changing deployment files.
