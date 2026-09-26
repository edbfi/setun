<script lang="ts">
import type { ArtifactLanguage } from "$lib/artifacts/types";
import ArtifactTrit from "$lib/components/artifacts/ArtifactTrit.svelte";
import * as m from "$lib/paraglide/messages";

/**
 * An artifact that is still arriving (PRD §13, §20).
 *
 * `ArtifactCard`'s chrome without its content: while a turn streams there are no
 * refs yet, so there is nothing to open, nothing to preview and no revision to
 * name. What it does say is that something is being built and what it is called,
 * which is the whole difference between watching a page appear and watching
 * `<!doctype html>` scroll past.
 *
 * No `data-artifact-card`: that attribute means "this opens an artifact", and
 * the end-to-end suite reads it as such.
 */
interface Props {
  language: ArtifactLanguage;
  /** The `id=` the model wrote, or null when it wrote none or wrote a non-slug. */
  artifactKey: string | null;
  title: string | null;
  /** True while the fence is still open, which is the one still being written. */
  pending?: boolean;
  /**
   * How many lines of the file have arrived (§20).
   *
   * A long artifact takes a minute to write, and "Building…" alone for the whole
   * of it looks stuck. A count that climbs is the cheapest honest sign that work
   * is happening.
   */
  lines?: number;
  /** Which file of the project is arriving, when the fence named one. */
  path?: string | null;
}

let { language, artifactKey, title, pending = false, lines = 0, path = null }: Props = $props();

const name = $derived(title ?? m.artifact_untitled({ language }));
</script>

<div
  class="my-2 flex items-center gap-3 rounded-xl border border-dashed border-border bg-card px-3 py-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
>
  <!-- Nobody has run it: the middle slot, which is what `null` means. -->
  <ArtifactTrit status={null} />

  <div class="min-w-0 flex-1">
    <p class="truncate text-sm font-medium text-card-foreground">{name}</p>
    <!-- Identity is always the mono face, so code-things read as code-things. -->
    <p class="truncate font-mono text-xs tabular-nums text-muted-foreground">
      {#if artifactKey}
        {m.artifact_id_label()}={artifactKey}
        · {language}
      {:else}
        {language}
      {/if}
    </p>
    {#if pending}
      <p class="truncate text-xs text-muted-foreground">
        {#if path && artifactKey}
          <!-- A project's own file, named: "Building Tidslinje…" says nothing
               about which of five files is arriving (§13). -->
          {m.artifact_card_writing({ path })}
        {:else}
          {m.artifact_card_building({ title: name })}
        {/if}
        {#if lines > 0}
          <span class="tabular-nums">· {m.artifact_card_lines({ lines })}</span>
        {/if}
      </p>
    {/if}
  </div>
</div>
