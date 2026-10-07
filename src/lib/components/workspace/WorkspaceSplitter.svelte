<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { SplitAxis } from "$lib/workspace/axis";

/**
 * The divider between the conversation and the build surface (PRD §20).
 *
 * "Panel handles are draggable by touch." Pointer events rather than mouse or
 * touch events: one code path covers a finger, a stylus and a trackpad, and
 * `setPointerCapture` keeps the drag alive when the finger leaves the bar —
 * which on a touchscreen it does immediately.
 *
 * Stacked, it is also the grab handle of the sheet, so it carries a visible grip
 * rather than a hairline: a bar you are meant to pull needs to look like one.
 *
 * The ARIA window-splitter pattern: a focusable `separator` carrying a value is
 * a widget rather than decoration, and the keyboard moves it — a drag must never
 * be the only way to reach a layout.
 */
interface Props {
  axis: SplitAxis;
  /** The conversation's share, 0–1. */
  fraction: number;
  min: number;
  max: number;
  /** Measured from the pointer's position inside the shell, in the same units. */
  onfraction: (fraction: number) => void;
}

let { axis, fraction, min, max, onfraction }: Props = $props();

const STEP = 0.04;

function drag(event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement;
  const shell = handle.parentElement;
  if (!shell) return;

  handle.setPointerCapture(event.pointerId);

  const move = (moved: PointerEvent) => {
    const box = shell.getBoundingClientRect();
    const along =
      axis === "inline"
        ? (moved.clientX - box.left) / box.width
        : (moved.clientY - box.top) / box.height;
    onfraction(along);
  };
  const release = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", release);
    handle.removeEventListener("pointercancel", release);
  };

  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);
}

function nudge(event: KeyboardEvent): void {
  const smaller = event.key === (axis === "inline" ? "ArrowLeft" : "ArrowUp");
  const larger = event.key === (axis === "inline" ? "ArrowRight" : "ArrowDown");
  const home = event.key === "Home";
  const end = event.key === "End";
  if (!smaller && !larger && !home && !end) return;

  event.preventDefault();
  if (home) onfraction(min);
  else if (end) onfraction(max);
  else onfraction(fraction + (smaller ? -STEP : STEP));
}
</script>

<!--
  The compiler's heuristic reads the element rather than the role, so the two
  rules it raises for a focusable, interactive `div` are suppressed deliberately:
  a `separator` with a value *is* a widget, which is the whole point.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-orientation={axis === "inline" ? "vertical" : "horizontal"}
  aria-label={m.artifact_split_handle()}
  aria-valuenow={Math.round(fraction * 100)}
  aria-valuemin={Math.round(min * 100)}
  aria-valuemax={Math.round(max * 100)}
  tabindex="0"
  onpointerdown={drag}
  onkeydown={nudge}
  class={[
    "workspace-splitter group/splitter relative z-10 flex shrink-0 items-center justify-center",
    "bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    axis === "inline" ? "w-2 cursor-col-resize" : "h-4 cursor-row-resize",
  ]}
>
  <span
    class={[
      "pointer-events-none rounded-full bg-border motion-safe:transition-colors",
      "group-hover/splitter:bg-primary/60 group-focus-visible/splitter:bg-primary",
      axis === "inline" ? "h-full w-px" : "h-1 w-10",
    ]}
  ></span>
</div>

<style>
/* A drag must move the divider, not scroll the surface behind it. */
.workspace-splitter {
  touch-action: none;
}
</style>
