<script lang="ts">
import type { StreamingDisplay } from "$lib/artifacts/segments";
import ArtifactTrit from "$lib/components/artifacts/ArtifactTrit.svelte";
import * as m from "$lib/paraglide/messages";
import ArtifactFileRows, { type FileRow } from "./ArtifactFileRows.svelte";

/**
 * A write that is still arriving (PRD §13, §20).
 *
 * `ArtifactCard`'s chrome without its content: while a turn streams there are no
 * refs yet, so there is nothing to open and no revision to name. What it does
 * say is what is being built, which files, and whether each is done — the whole
 * difference between watching a page appear and watching `<!doctype html>`
 * scroll past.
 *
 * One card per write, not per fence: a project's entry, data and stylesheet
 * under one id are one revision, and showing three cards that collapse into one
 * when the turn settles reads as the transcript jumping.
 *
 * No `data-artifact-card`: that attribute means "this opens an artifact", and
 * the end-to-end suite reads it as such.
 */
interface Props {
  write: Extract<StreamingDisplay, { kind: "write" }>;
  /**
   * The name the conversation already knows this id by (§13).
   *
   * A revision's fences carry no title — the artifact has one — so without this
   * a pupil revising "Tidslinje" would watch "Untitled css" being written.
   */
  knownTitle?: string | null;
}

let { write, knownTitle = null }: Props = $props();

const tag = $derived(write.language ?? write.fileKind);

/** Rows only where there are paths to show: a single-file page has none. */
const rows = $derived<FileRow[]>(
  write.key
    ? write.files.flatMap((file) =>
        file.path
          ? [
              {
                path: file.path,
                state: file.deleted ? "deleted" : file.state,
                lines: file.lines,
              },
            ]
          : [],
      )
    : [],
);

const name = $derived(
  write.title ??
    knownTitle ??
    (rows.length === 1 ? rows[0].path : m.artifact_untitled({ language: tag })),
);

/** For a write with no file rows, its single line count carries the progress. */
const lines = $derived(rows.length === 0 ? (write.files.at(-1)?.lines ?? 0) : 0);
</script>

<div
  class="my-2 rounded-xl border border-dashed border-border bg-card px-3 py-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
  data-artifact-write={write.writing ? "writing" : "written"}
>
  <div class="flex items-center gap-3">
    <!-- Nobody has run it: the middle slot, which is what `null` means. -->
    <ArtifactTrit status={null} />

    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium text-card-foreground">{name}</p>
      <!-- Identity is always the mono face, so code-things read as code-things. -->
      <p class="truncate font-mono text-xs tabular-nums text-muted-foreground">
        {#if write.key}
          {m.artifact_id_label()}={write.key}
          · {tag}
        {:else}
          {tag}
        {/if}
      </p>
    </div>

    <span class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {#if write.writing}
        <span class="write-pulse size-1.5 rounded-full bg-primary" aria-hidden="true"></span>
        <span>{m.artifact_write_writing()}</span>
        {#if lines > 1}
          <span class="tabular-nums">· {m.artifact_file_lines({ lines })}</span>
        {/if}
      {:else}
        {m.artifact_write_written()}
      {/if}
    </span>
  </div>

  {#if rows.length > 0}
    <ArtifactFileRows files={rows} />
  {/if}
</div>

<style>
@media (prefers-reduced-motion: no-preference) {
  .write-pulse {
    animation: setun-write-pulse 1.4s ease-in-out infinite;
  }
}

@keyframes setun-write-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
</style>
