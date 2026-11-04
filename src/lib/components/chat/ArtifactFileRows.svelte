<script lang="ts">
import Check from "@lucide/svelte/icons/check";
import Minus from "@lucide/svelte/icons/minus";
import * as m from "$lib/paraglide/messages";

/**
 * The files one write touched, one row each (PRD §13, §20).
 *
 * The same rows under a write that is still arriving and under the card it
 * settles into, so the unit a pupil watched being written is the unit they can
 * open afterwards. A row says which file, whether it is done, and — while it is
 * being written — how far along it is: a count that climbs is the cheapest
 * honest sign that a long file has not stalled.
 */
export interface FileRow {
  readonly path: string;
  readonly state: "writing" | "written" | "deleted";
  /**
   * Lines so far, or the file's length once written. Shown above one only: a
   * one-line file needs no count, and "1 lines" is wrong in both languages.
   */
  readonly lines?: number;
}

interface Props {
  files: readonly FileRow[];
  /**
   * Phrasing elements only, for a card that is itself one `<button>`: a list is
   * not allowed inside a button, and the button's label already names it.
   */
  inline?: boolean;
}

let { files, inline = false }: Props = $props();
</script>

<svelte:element
  this={inline ? "span" : "ul"}
  class="mt-1.5 flex flex-col gap-0.5"
  aria-label={inline ? undefined : m.artifact_write_files()}
>
  {#each files as file, index (index)}
    <svelte:element
      this={inline ? "span" : "li"}
      class="flex items-center gap-2 text-xs text-muted-foreground"
      data-file-state={file.state}
    >
      <span class="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        {#if file.state === "writing"}
          <span class="file-pulse size-1.5 rounded-full bg-primary"></span>
        {:else if file.state === "deleted"}
          <Minus class="size-3.5" />
        {:else}
          <Check class="size-3.5 text-primary" />
        {/if}
      </span>
      <span class="min-w-0 flex-1 truncate font-mono text-foreground/80">{file.path}</span>
      <span class="shrink-0 tabular-nums">
        {#if file.state === "writing"}
          <!-- The card's header already says "Writing…"; the row's pulse says which. -->
          <span class="sr-only">{m.artifact_write_writing()}</span>
        {:else if file.state === "deleted"}
          <span>{m.artifact_write_deleted()}</span>
        {/if}
        {#if (file.lines ?? 0) > 1 && file.state !== "deleted"}
          <span
            >{m.artifact_file_lines({
              lines: file.lines ?? 0,
            })}</span
          >
        {/if}
      </span>
    </svelte:element>
  {/each}
</svelte:element>

<style>
@media (prefers-reduced-motion: no-preference) {
  .file-pulse {
    animation: setun-file-pulse 1.4s ease-in-out infinite;
  }
}

@keyframes setun-file-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
</style>
