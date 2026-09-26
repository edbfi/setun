<script lang="ts">
import ArtifactTrit from "$lib/components/artifacts/ArtifactTrit.svelte";
import * as m from "$lib/paraglide/messages";
import type { MessageArtifactRef } from "$lib/state/conversation.svelte";

/**
 * An artifact where its block was written (PRD §13, §20).
 *
 * The transcript used to render an artifact as a fenced code block: a screenful
 * of markup between two sentences, which is what a fence means to a markdown
 * renderer and not what it means here. An artifact is a live document with a
 * surface of its own, so the transcript shows what was built and one control
 * that opens it.
 *
 * The whole card is that control rather than a button parked on its end: a
 * pupil taps the thing, not a word beside the thing. It also says when it is the
 * one currently on screen, which is what turns a column of similar cards into a
 * way of moving between builds.
 *
 * The identity — id, language, revision — is set in the mono face, everywhere
 * and always, so code-things read as code-things across the interface.
 */
interface Props {
  artifact: MessageArtifactRef;
  /** True while this is the artifact the build surface is showing. */
  active?: boolean;
  onopen?: (artifactId: string) => void;
}

let { artifact, active = false, onopen }: Props = $props();

const title = $derived(artifact.title ?? m.artifact_untitled({ language: artifact.language }));

/** Only where there is more than one: "1 file" is noise on every card. */
const files = $derived(
  (artifact.fileCount ?? 1) > 1
    ? ` · ${m.artifact_files_count({ count: artifact.fileCount ?? 0 })}`
    : "",
);

const changes = $derived(
  [
    (artifact.added ?? 0) > 0 ? m.artifact_history_added({ count: artifact.added ?? 0 }) : "",
    (artifact.modified ?? 0) > 0
      ? m.artifact_history_modified({ count: artifact.modified ?? 0 })
      : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · "),
);
</script>

<button
  type="button"
  onclick={() => onopen?.(artifact.artifactId)}
  aria-label={m.artifact_card_label({ title })}
  aria-current={active ? "true" : undefined}
  data-artifact-card={artifact.artifactId}
  class={[
  "group/card my-2 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200",
  active
    ? "border-primary/40 bg-primary/5"
    : "border-border bg-card hover:border-primary/30 hover:bg-secondary",
]}
>
  <ArtifactTrit status={artifact.buildStatus ?? null} />

  <span class="min-w-0 flex-1">
    <span class="block truncate text-sm font-medium text-card-foreground">{title}</span>
    <span class="block truncate font-mono text-xs tabular-nums text-muted-foreground">
      {m.artifact_id_label()}={artifact.key}
      · {artifact.language} · v{artifact.revision}{files}
    </span>
    {#if changes}
      <!--
        What this revision *did*, which is what makes a project legible: a
        message that changed one file of five should read as one change (§13).
      -->
      <span class="block truncate text-xs text-muted-foreground">{changes}</span>
    {/if}
  </span>

  <span
    aria-hidden="true"
    class={[
  "shrink-0 text-xs font-medium",
  active ? "text-primary" : "text-muted-foreground group-hover/card:text-foreground",
]}
  >
    {active ? m.artifact_showing() : m.artifact_open()}
  </span>
</button>
