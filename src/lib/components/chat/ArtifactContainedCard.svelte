<script lang="ts">
import type { ArtifactFence } from "$lib/artifacts/detect";
import ArtifactTrit from "$lib/components/artifacts/ArtifactTrit.svelte";
import * as m from "$lib/paraglide/messages";
import MarkdownMessage from "./MarkdownMessage.svelte";

/**
 * An artifact write the transcript has no revision for (PRD §13, §20).
 *
 * The cards come from the database and the blocks from the text. Where a block
 * has no revision behind it — the model restated a file without changing it, a
 * write was over the caps, the turn stopped before the file was finished — the
 * transcript used to render the fence as written: a screenful of code between
 * two sentences, which is exactly what a pupil reported as "the code escaped".
 *
 * So the block stays a card. It never names a revision the database does not
 * have; it says why there is none, opens the artifact its id names when the
 * conversation holds one, and keeps the source one click away rather than on
 * screen.
 */
interface Props {
  fence: Pick<ArtifactFence, "language" | "kind" | "key" | "title" | "path">;
  /** The block as written, fences included. Rendered only when expanded. */
  raw: string;
  /** Why there is no revision: the artifact exists but this write added none, nothing was recorded, or the turn cut it short. */
  reason: "existing" | "unsaved" | "incomplete";
  /** Every path the write states, so a project write can say which files. */
  files?: readonly string[];
  /** The artifact the fence's id names, when the conversation holds one. */
  artifactId?: string | null;
  active?: boolean;
  onopen?: (artifactId: string) => void;
}

let { fence, raw, reason, files = [], artifactId = null, active = false, onopen }: Props = $props();

const title = $derived(
  fence.title ?? m.artifact_untitled({ language: fence.language ?? fence.kind }),
);

const identity = $derived(
  [
    fence.key ? `${m.artifact_id_label()}=${fence.key}` : null,
    fence.language ?? fence.kind,
    files.length > 1 ? m.artifact_files_count({ count: files.length }) : (fence.path ?? files[0]),
  ]
    .filter(Boolean)
    .join(" · "),
);

const status = $derived(
  reason === "existing"
    ? m.artifact_contained_existing()
    : reason === "incomplete"
      ? m.artifact_contained_incomplete()
      : m.artifact_contained_unsaved(),
);

/** Whether the source is expanded; it is only rendered once it is. */
let expanded = $state(false);
</script>

<div
  class="my-2 rounded-xl border border-border bg-card motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
  data-artifact-contained={reason}
>
  <div class="flex items-center gap-3 px-3 py-2.5">
    <ArtifactTrit status={null} />

    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium text-card-foreground">{title}</p>
      <p class="truncate font-mono text-xs tabular-nums text-muted-foreground">{identity}</p>
      <p class="truncate text-xs text-muted-foreground">{status}</p>
    </div>

    <!-- Open only means something when there is a thing to open. -->
    {#if artifactId !== null && reason !== "incomplete"}
      <button
        type="button"
        onclick={() => onopen?.(artifactId)}
        aria-label={m.artifact_card_label({ title })}
        aria-current={active ? "true" : undefined}
        class={[
          "shrink-0 rounded-md px-2 py-1 text-xs font-medium",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active
            ? "text-primary"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        ]}
      >
        {active ? m.artifact_showing() : m.artifact_open()}
      </button>
    {/if}
  </div>

  <!--
    The source, one click away and never on screen by default. Native, so it
    opens without JavaScript and is already a disclosure to a screen reader; the
    body is only rendered once opened, so a long file costs nothing until asked.
  -->
  <details class="border-t border-border text-xs" bind:open={expanded}>
    <summary
      class="cursor-pointer px-3 py-1.5 text-muted-foreground marker:text-muted-foreground hover:text-foreground"
    >
      {m.artifact_contained_show_code()}
    </summary>
    {#if expanded}
      <div class="max-h-96 overflow-auto px-3 pb-2">
        <MarkdownMessage text={raw} />
      </div>
    {/if}
  </details>
</div>
