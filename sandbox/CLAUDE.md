# CLAUDE.md — sandbox

This is the artifact host: a standalone Vite app served as static files on its own origin. That
origin separation is the isolation mechanism, so keep this build independent of the SvelteKit
build. `src/` never imports from `sandbox/`.

- Import direction is one way. Sandbox code may import only the pure, dependency-free modules in
  `src/lib/artifacts/` (through the `$lib` alias in `vite.config.ts`). Put logic that needs tests
  there, not here: no unit runner reaches `sandbox/` (`bunfig.toml` ignores it, and Vitest only
  includes `src/`). Everything under `sandbox/src/` is covered only by `e2e/artifact-*.e2e.ts`.
- The app ↔ runner message vocabulary is `src/lib/artifacts/protocol.ts`, and both ends validate
  against it. The runner ↔ compiler-worker protocol is `sandbox/src/compile-protocol.ts`.
- There are three build passes (`build:sandbox` in `package.json`, selected by
  `SETUN_SANDBOX_BUILD_TARGET`): `runner` (the default; it inlines everything into `index.html` and
  is the only pass that empties `build-sandbox/`), `runtimes`, and `compiler`. Run
  `bun run build:sandbox` for all three, never one `vite build --config sandbox/vite.config.ts`.
- The CSP exists twice: `CSP` in `vite.config.ts` (dev, preview, and e2e) and the sandbox site
  block in `/Caddyfile` (production). Change both together. `e2e/artifact-escape.e2e.ts` tests the
  Vite copy.
- Only `SANDBOX_`-prefixed env vars reach sandbox code (`envPrefix`).

## Adding a pinned runtime module

1. Add `sandbox/src/runtimes/<name>.ts`. Enumerate named exports explicitly, as `react.ts` does:
   `export *` of a CommonJS package produces a module with no exports.
2. Add `<name>` to `RUNTIMES` and the bare specifier to `specifiers`, both in `vite.config.ts`.
3. If it belongs to React or Svelte, add it to `FRAMEWORK_ENTRIES` in
   `src/lib/artifacts/assets.ts`, which decides what an artifact loads.
