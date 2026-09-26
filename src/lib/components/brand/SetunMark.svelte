<script lang="ts">
import type { SVGAttributes } from "svelte/elements";

/**
 * The Setun mark (placeholder brand identity).
 *
 * Setun was the 1958 Soviet computer built on balanced ternary — three states
 * rather than two, written minus, zero, plus. The mark is those three trits
 * stacked inside a rounded tile.
 *
 * Inlined rather than an `<img>` so the tile picks up `currentColor` and tracks
 * the clean-slate theme. Size it with a utility class (`size-8`) or the `size`
 * prop; `static/setun-mark.svg` is the standalone twin used as the favicon,
 * where `currentColor` has nothing to resolve against.
 */
interface Props extends SVGAttributes<SVGSVGElement> {
  /** Rendered pixel size. Ignored when a sizing class is supplied. */
  size?: number;
  /**
   * Accessible name. Empty marks the mark decorative, which is correct whenever
   * it sits beside the wordmark — a screen reader should not read it twice.
   */
  title?: string;
}

let { size = 32, title = "", class: className, ...rest }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 32 32"
  width={size}
  height={size}
  class={className}
  role={title ? "img" : "presentation"}
  aria-label={title || undefined}
  aria-hidden={title ? undefined : "true"}
  {...rest}
>
  {#if title}
    <title>{title}</title>
  {/if}
  <rect width="32" height="32" rx="7" fill="currentColor" />
  <g fill="var(--setun-mark-glyph, #fff)">
    <!-- minus -->
    <rect x="12" y="8.6" width="8" height="2.8" rx="1.4" />
    <!-- zero -->
    <circle cx="16" cy="15.8" r="2.1" />
    <!-- plus -->
    <rect x="12" y="21.4" width="8" height="2.8" rx="1.4" />
    <rect x="14.6" y="19.6" width="2.8" height="6.4" rx="1.4" />
  </g>
</svg>
