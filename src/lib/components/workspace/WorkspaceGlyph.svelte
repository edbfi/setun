<script lang="ts">
import type { WorkspaceStage } from "$lib/state/artifacts.svelte";
import type { SplitAxis } from "$lib/workspace/axis";

/**
 * One position of the workspace switcher, drawn as the screen it produces.
 *
 * Setun's build state is already a trit — three slots, one filled — and the
 * workspace is three-valued in the same way, so the switcher repeats that
 * rhythm without repeating that glyph: circles mean *how a thing ran*, and
 * rectangles mean *what is on screen*. Reusing the trit here would have made one
 * shape mean two things, which is the opposite of why the trit works.
 *
 * The divider follows the real axis, because a vertical rule on a screen that
 * stacks its panes is a small lie about what the control is about to do.
 *
 * Decorative: the switcher's own radio carries the accessible name.
 */
interface Props {
  stage: WorkspaceStage;
  axis: SplitAxis;
}

let { stage, axis }: Props = $props();

/** Text lines, so the conversation half reads as prose at 24×16. */
const lines = $derived(
  axis === "block" && stage === "both"
    ? [
        { x: 4, y: 2.6, width: 10 },
        { x: 4, y: 5.1, width: 6 },
      ]
    : stage === "both"
      ? [
          { x: 4, y: 4.2, width: 6 },
          { x: 4, y: 7.2, width: 6 },
          { x: 4, y: 10.2, width: 4 },
        ]
      : [
          { x: 4, y: 4.2, width: 16 },
          { x: 4, y: 7.2, width: 16 },
          { x: 4, y: 10.2, width: 10 },
        ],
);

/** The build half, drawn as the one solid thing on the screen. */
const block = $derived(
  stage === "chat"
    ? null
    : stage === "build"
      ? { x: 4, y: 4.2, width: 16, height: 7.6 }
      : axis === "block"
        ? { x: 4, y: 9.4, width: 16, height: 4 }
        : { x: 14, y: 4.2, width: 6, height: 7.6 },
);

const divider = $derived(
  stage !== "both"
    ? null
    : axis === "block"
      ? { x1: 1, y1: 8, x2: 23, y2: 8 }
      : { x1: 12, y1: 1, x2: 12, y2: 15 },
);
</script>

<svg viewBox="0 0 24 16" width="24" height="16" fill="none" aria-hidden="true" class="shrink-0">
  <rect
    x="0.75"
    y="0.75"
    width="22.5"
    height="14.5"
    rx="2.5"
    stroke="currentColor"
    stroke-width="1.5"
    opacity="0.55"
  />

  {#if divider}
    <line
      x1={divider.x1}
      y1={divider.y1}
      x2={divider.x2}
      y2={divider.y2}
      stroke="currentColor"
      stroke-width="1.5"
      opacity="0.55"
    />
  {/if}

  {#if stage !== "build"}
    {#each lines as line, at (at)}
      <rect
        x={line.x}
        y={line.y}
        width={line.width}
        height="1.5"
        rx="0.75"
        fill="currentColor"
        opacity="0.5"
      />
    {/each}
  {/if}

  {#if block}
    <rect
      x={block.x}
      y={block.y}
      width={block.width}
      height={block.height}
      rx="1.25"
      fill="currentColor"
    />
  {/if}
</svg>
