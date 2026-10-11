import {
  defineConfig,
  type Preset,
  presetWind4,
  transformerDirectives,
  transformerVariantGroup,
} from "unocss";
import extractorSvelte from "@unocss/extractor-svelte";
import presetAnimations from "unocss-preset-animations";
import { presetShadcn } from "unocss-preset-shadcn";

/** The `color` option of `presetShadcn`, whose published type is HSL-only (see below). */
type ShadcnColorOption = NonNullable<
  Exclude<Parameters<typeof presetShadcn>[0], undefined | unknown[]>
>["color"];

/**
 * tweakcn "clean-slate" theme (PRD §5), ported into the preset-shadcn CSS-variable theme.
 *
 * Source of truth: https://tweakcn.com/r/themes/clean-slate.json
 * (installable for a Tailwind project with
 *  `bunx shadcn@latest add https://tweakcn.com/r/themes/clean-slate.json`;
 *  Setun runs UnoCSS, so the variables are ported here by hand instead.)
 *
 * Values are bare oklch components — L C H with no wrapper — because
 * `unocss-preset-shadcn` 1.0.1's Wind4 entry emits `oklch(var(--token))` in every
 * colour utility. The upstream theme is already authored in oklch, so this port is exact.
 */
const cleanSlate = {
  name: "clean-slate",
  light: {
    background: "0.9842 0.0034 247.8575",
    foreground: "0.2795 0.0368 260.0310",
    card: "1.0000 0 0",
    "card-foreground": "0.2795 0.0368 260.0310",
    popover: "1.0000 0 0",
    "popover-foreground": "0.2795 0.0368 260.0310",
    primary: "0.5854 0.2041 277.1173",
    "primary-foreground": "1.0000 0 0",
    secondary: "0.9276 0.0058 264.5313",
    "secondary-foreground": "0.3729 0.0306 259.7328",
    muted: "0.9670 0.0029 264.5419",
    "muted-foreground": "0.5510 0.0234 264.3637",
    accent: "0.9299 0.0334 272.7879",
    "accent-foreground": "0.3729 0.0306 259.7328",
    destructive: "0.6368 0.2078 25.3313",
    "destructive-foreground": "1.0000 0 0",
    border: "0.8717 0.0093 258.3382",
    input: "0.8717 0.0093 258.3382",
    ring: "0.5854 0.2041 277.1173",
    "chart-1": "0.5854 0.2041 277.1173",
    "chart-2": "0.5106 0.2301 276.9656",
    "chart-3": "0.4568 0.2146 277.0229",
    "chart-4": "0.3984 0.1773 277.3662",
    "chart-5": "0.3588 0.1354 278.6973",
    sidebar: "0.9670 0.0029 264.5419",
    "sidebar-foreground": "0.2795 0.0368 260.0310",
    "sidebar-primary": "0.5854 0.2041 277.1173",
    "sidebar-primary-foreground": "1.0000 0 0",
    "sidebar-accent": "0.9299 0.0334 272.7879",
    "sidebar-accent-foreground": "0.3729 0.0306 259.7328",
    "sidebar-border": "0.8717 0.0093 258.3382",
    "sidebar-ring": "0.5854 0.2041 277.1173",
  },
  dark: {
    background: "0.2077 0.0398 265.7549",
    foreground: "0.9288 0.0126 255.5078",
    card: "0.2795 0.0368 260.0310",
    "card-foreground": "0.9288 0.0126 255.5078",
    popover: "0.2795 0.0368 260.0310",
    "popover-foreground": "0.9288 0.0126 255.5078",
    primary: "0.6801 0.1583 276.9349",
    "primary-foreground": "0.2077 0.0398 265.7549",
    secondary: "0.3351 0.0331 260.9120",
    "secondary-foreground": "0.8717 0.0093 258.3382",
    muted: "0.2427 0.0381 259.9437",
    "muted-foreground": "0.7137 0.0192 261.3246",
    accent: "0.3729 0.0306 259.7328",
    "accent-foreground": "0.8717 0.0093 258.3382",
    destructive: "0.6368 0.2078 25.3313",
    "destructive-foreground": "0.2077 0.0398 265.7549",
    border: "0.4461 0.0263 256.8018",
    input: "0.4461 0.0263 256.8018",
    ring: "0.6801 0.1583 276.9349",
    "chart-1": "0.6801 0.1583 276.9349",
    "chart-2": "0.5854 0.2041 277.1173",
    "chart-3": "0.5106 0.2301 276.9656",
    "chart-4": "0.4568 0.2146 277.0229",
    "chart-5": "0.3984 0.1773 277.3662",
    sidebar: "0.2795 0.0368 260.0310",
    "sidebar-foreground": "0.9288 0.0126 255.5078",
    "sidebar-primary": "0.6801 0.1583 276.9349",
    "sidebar-primary-foreground": "0.2077 0.0398 265.7549",
    "sidebar-accent": "0.3729 0.0306 259.7328",
    "sidebar-accent-foreground": "0.8717 0.0093 258.3382",
    "sidebar-border": "0.4461 0.0263 256.8018",
    "sidebar-ring": "0.6801 0.1583 276.9349",
  },
};

export default defineConfig({
  extractors: [extractorSvelte()],
  presets: [
    presetWind4(),
    // Both presets declare `Preset<Theme>` against `unocss/preset-mini`'s Theme,
    // while presetWind4 infers its own — the structural mismatch is in the
    // declarations only, not the runtime.
    presetAnimations() as Preset,
    // preset-shadcn 1.0.1 ships one set of type declarations for both its Wind3
    // (`/v3`) and Wind4 (root) entries, typing colours as HSL triplets
    // (`${number} ${number}% ${number}%`). The Wind4 runtime this project uses
    // emits `oklch(var(--token))` and its own bundled themes are oklch component
    // triplets, so the declared type contradicts the shipped behaviour. The
    // values below are oklch because that is what the runtime requires.
    presetShadcn({ color: cleanSlate as unknown as ShadcnColorOption, radius: 0.5 }) as Preset,
  ],
  theme: {
    // preset-shadcn declares its radius scale under `borderRadius`, a Wind3 key that
    // presetWind4 ignores — restated here under `radius` so `rounded-*` tracks `--radius`.
    radius: {
      sm: "calc(var(--radius) - 4px)",
      md: "calc(var(--radius) - 2px)",
      lg: "var(--radius)",
      xl: "calc(var(--radius) + 4px)",
    },
    // presetWind4 reads `font`, not `fontFamily`, and each value must be a SINGLE STRING.
    // clean-slate families come first; the rest are system fallbacks, because Setun
    // ships no webfont and contacts no CDN (PRD §20).
    font: {
      sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      serif: 'Merriweather, ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
      mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    },
  },
  transformers: [transformerDirectives(), transformerVariantGroup()],
  content: {
    // Scanned up front, not only as the build pipeline transforms modules.
    // Vitest Browser Mode imports `virtual:uno.css` from its setup file before any
    // component is transformed, so without this the stylesheet a component test
    // sees carries the theme preflight but none of the utilities — themed
    // assertions would then run against unstyled markup.
    filesystem: ["src/**/*.{svelte,svelte.ts,ts,js}"],
    pipeline: {
      // shadcn-svelte variants live in .ts files — without this include those
      // components render unstyled.
      include: [
        /\.(vue|svelte|[jt]sx|mdx?|astro|elm|php|phtml|html)($|\?)/,
        "(components|src)/**/*.{js,ts}",
      ],
    },
  },
});
