<script lang="ts">
import { effectiveArtifactKey } from "$lib/artifacts/identity";
import * as m from "$lib/paraglide/messages";
import type { ArtifactView } from "$lib/state/artifacts.svelte";
import ArtifactTrit from "./ArtifactTrit.svelte";

/**
 * Everything this conversation built, in one list (PRD §13, §16).
 *
 * Discovery used to be a `<select>` in the panel's header — a control that shows
 * one name at a time, says nothing about what state anything is in, and is the
 * last place a pupil looks. A lesson produces a handful of things and the pupil
 * moves between them constantly, so the list is a surface of its own: what it
 * is called, what it is, and whether it ran.
 *
 * Creations outlive conversations, so the portfolio is one link away rather than
 * folded in here — this list is "what we made in this conversation" (§16).
 */
interface Props {
  items: readonly ArtifactView[];
  openId: string | null;
  onselect: (artifactId: string) => void;
}

let { items, openId, onselect }: Props = $props();
</script>

<div class="flex h-full min-h-0 flex-col">
  <ul class="min-h-0 flex-1 overflow-y-auto p-2">
    {#each items as item (item.id)}
      {@const title = item.title ?? m.artifact_untitled({ language: item.language })}
      {@const key =
        item.key ?? effectiveArtifactKey({ language: item.language, id: item.id, key: null })}
      <li>
        <button
          type="button"
          onclick={() => onselect(item.id)}
          aria-current={openId === item.id ? "true" : undefined}
          data-artifact-index-row={item.id}
          class={[
            "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            "motion-safe:transition-colors",
            openId === item.id
              ? "bg-primary/10 text-foreground"
              : "text-foreground hover:bg-secondary",
          ]}
        >
          <ArtifactTrit status={item.latest.buildStatus ?? null} />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{title}</span>
            <!-- Identity is always the mono face, so code-things read as code-things. -->
            <span class="block truncate font-mono text-xs tabular-nums text-muted-foreground">
              {m.artifact_id_label()}={key}
              · {item.language} · v{item.latest.revision}
            </span>
          </span>
        </button>
      </li>
    {/each}
  </ul>

  <div class="shrink-0 border-t border-border px-3 py-2">
    <a
      href="/creations"
      class="inline-flex min-h-9 items-center rounded-md text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {m.artifact_index_portfolio()}
    </a>
  </div>
</div>
