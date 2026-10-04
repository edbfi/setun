import { paraglideVitePlugin } from "@inlang/paraglide-js";
import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import UnoCSS from "unocss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // UnoCSS must come before sveltekit() — the order matters for HMR.
  plugins: [
    UnoCSS(),
    sveltekit({
      preprocess: vitePreprocess(),
      // Runes are mandatory in application code (see .agents/rules/svelte5-sveltekit-app.md).
      // Dependencies keep their own mode so non-runes libraries still compile.
      compilerOptions: {
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },

      /**
       * Production runs `bun ./server.js`, which loads this output (PRD §5).
       *
       * `out` is normally `build/`, and every path that names it — the Dockerfile,
       * the Playwright `webServer` commands, `.gitignore` — assumes that. It is
       * overridable only so the dev suite can give each of its instances a
       * directory of its own: `vite build` empties `out` before it writes, so two
       * instances sharing one would have the second delete the files the first is
       * still serving. Unset, which is every case but that one, nothing moves.
       */
      adapter: adapter({ out: process.env.SETUN_BUILD_DIR || "build" }),
    }),

    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      emitTsDeclarations: true,
    }),
  ],
  /*
   * Dependencies discovered only when a particular component first renders —
   * icon deep imports, and the validation stack a form spec pulls in. Left to
   * itself Vite optimises them mid-run and reloads the page under the test,
   * which the browser-mode runner reports as flaky.
   */
  optimizeDeps: {
    include: [
      "@lucide/svelte/icons/arrow-down",
      "@lucide/svelte/icons/arrow-up",
      "@lucide/svelte/icons/chevron-left",
      "@lucide/svelte/icons/chevron-right",
      "@lucide/svelte/icons/image",
      "@lucide/svelte/icons/monitor",
      "@lucide/svelte/icons/moon",
      "@lucide/svelte/icons/panel-left",
      "@lucide/svelte/icons/paperclip",
      "@lucide/svelte/icons/pencil",
      "@lucide/svelte/icons/plus",
      "@lucide/svelte/icons/rotate-ccw",
      "@lucide/svelte/icons/square",
      "@lucide/svelte/icons/sun",
      "@lucide/svelte/icons/trash-2",
      "@lucide/svelte/icons/x",
      // The client entry too, not only the adapters: the first-run wizard's
      // step components call `superForm`, so a spec that renders one discovers
      // the root export mid-run and reloads the page under the test.
      "sveltekit-superforms",
      "sveltekit-superforms/adapters",
      "valibot",
      "drizzle-orm/sqlite-core",
      "date-fns-tz",
      "qrcode",
      "jspdf",
      "svg2pdf.js",
      // CodeMirror is loaded on demand when a pupil opens an artifact's source
      // (§20), so it is discovered mid-run exactly like the icons above.
      "@codemirror/view",
      "@codemirror/state",
      "@codemirror/commands",
      "@codemirror/lang-css",
      "@codemirror/lang-html",
      "@codemirror/lang-json",
      "@codemirror/lang-javascript",
      "@codemirror/merge",
      "@codemirror/language",
      "@lezer/highlight",
    ],
  },
  test: {
    expect: { requireAssertions: true },
    // Both projects have suites; an empty project must fail instead of passing silently.
    passWithNoTests: false,
    projects: [
      {
        extends: "./vite.config.ts",
        test: {
          name: "client",
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium", headless: true }],
          },
          // Component behaviour only. Pure logic belongs to `bun test` (PRD §22).
          include: ["src/**/*.svelte.spec.ts"],
          exclude: ["src/lib/server/**"],
          setupFiles: ["vitest-browser-svelte", "./src/test/vitest-setup-client.ts"],
        },
      },
      {
        extends: "./vite.config.ts",
        test: {
          name: "server",
          environment: "node",
          // Reserved for suites that need Vite resolution (virtual modules,
          // `$app/*`, `$env/*`). Plain server logic runs under `bun test`.
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/*.svelte.spec.ts"],
        },
      },
    ],
  },
});
