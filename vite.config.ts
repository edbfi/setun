import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import { playwright } from "@vitest/browser-playwright";
import UnoCSS from "unocss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // UnoCSS must come before sveltekit() — the order matters for HMR.
  plugins: [
    UnoCSS(),
    sveltekit(),
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
