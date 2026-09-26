<script lang="ts">
import type { BuildStatus } from "$lib/artifacts/types";
import * as m from "$lib/paraglide/messages";
import type { ArtifactWorkspace } from "$lib/state/artifacts.svelte";
import ArtifactTrit from "./ArtifactTrit.svelte";

/**
 * What just happened, at the foot of the build pane (PRD §13, §20).
 *
 * One strip carries the whole outcome of a run: the trit, one sentence, what the
 * artifact printed, and the compiler's own words when there are any. It sits
 * below the preview rather than above it because that is the reading order of
 * the thing — you look at the page, then at whether it worked.
 *
 * Everything generated is rendered as text and never as markup, at both hops
 * (§13, §21).
 */
interface Props {
  workspace: ArtifactWorkspace;
  /**
   * The pupil asking the model to fix what went wrong; the page pre-fills the
   * composer. The status travels with it: "it did not run" and "it ran, then
   * stopped" are different sentences, and the wrong one contradicts the note the
   * model is given beside it.
   */
  onaskforhelp?: (status: BuildStatus) => void;
}

let { workspace, onaskforhelp }: Props = $props();

let consoleOpen = $state(false);

/**
 * What the trit shows: this run's outcome if there is one, else what is stored.
 *
 * `threw` is checked before the `running → ok` mapping below: a page that
 * mounted and then threw stays "running" — it is still on screen — and the
 * outcome is the only thing that knows it broke afterwards.
 */
const runStatus = $derived(
  workspace.status === "failed"
    ? ("failed" as const)
    : workspace.outcome?.status === "threw"
      ? ("threw" as const)
      : workspace.status === "running"
        ? ("ok" as const)
        : (workspace.open?.latest.buildStatus ?? null),
);

/**
 * The compiler's or the browser's own words — this run's, or the stored ones.
 *
 * Reopening a failed artifact resets the run, so `workspace.error` is empty
 * while the failure itself is still on record against the version. Without the
 * fallback the pupil got the trit and one sentence, and the thing they can
 * actually act on — the message, and the button that hands it back to the model
 * — was missing from the one place it belongs.
 *
 * Only while there is no run at all, which is what `running` says and `status`
 * does not: `show` sets the source going before the frame has reported anything,
 * and an html or svg artifact never reports `compiling` — the sandbox stages it
 * directly — so `idle` covers the whole of a static artifact's load. Gating on
 * the status left the previous failure on screen underneath it.
 *
 * A null `running` is the case this fallback exists for: the artifact is open
 * with no frame mounted, so the stored record is the only account of it there
 * is. Once something is running, that run's own words are the ones to show.
 */
const diagnostic = $derived(
  workspace.error ??
    (workspace.running === null &&
    workspace.outcome === null &&
    (runStatus === "failed" || runStatus === "threw")
      ? (workspace.open?.latest.buildMessage ?? null)
      : null),
);

/** What the pupil is asking about: this run's verdict, else the stored one. */
const diagnosticStatus = $derived(
  workspace.outcome?.status ?? workspace.open?.latest.buildStatus ?? "failed",
);
</script>

<div class="shrink-0 border-t border-border">
  <div class="flex items-center gap-2 px-3 py-1.5 text-xs">
    <ArtifactTrit status={runStatus} />
    <span class="min-w-0 truncate text-muted-foreground" role="status">
      {#if workspace.saveFailed}
        {m.artifact_save_failed()}
      {:else if workspace.dirty}
        {m.artifact_status_unsaved()}
      {:else if workspace.status === "compiling"}
        {m.artifact_status_compiling()}
      {:else if workspace.status === "failed"}
        {m.artifact_status_failed()}
      {:else if workspace.outcome?.status === "threw"}
        {m.artifact_status_threw()}
      {:else if workspace.status === "running"}
        {m.artifact_status_ready()}
      {:else if runStatus === null}
        {m.artifact_status_not_run()}
      {:else if runStatus === "threw"}
        {m.artifact_status_threw()}
      {:else if runStatus === "failed"}
        {m.artifact_status_failed()}
      {:else}
        {m.artifact_status_ran()}
      {/if}
    </span>

    {#if workspace.consoleLines.length > 0}
      <button
        type="button"
        onclick={() => (consoleOpen = !consoleOpen)}
        aria-expanded={consoleOpen}
        class="ml-auto min-h-8 shrink-0 rounded-md border border-input px-2 font-mono text-xs tabular-nums text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {m.artifact_console_label({ count: workspace.consoleLines.length })}
      </button>
    {/if}
  </div>

  {#if workspace.editedByStudent}
    <!-- What happens next to the edit the pupil just made (§13). -->
    <p class="border-t border-border px-3 py-1 text-xs text-muted-foreground">
      {m.artifact_edit_carried()}
    </p>
  {/if}

  {#if consoleOpen && workspace.consoleLines.length > 0}
    <!-- What the artifact printed. Text, never markup, at both hops (§13, §21). -->
    <div class="border-t border-border">
      <pre
        role="log"
        class="max-h-32 overflow-auto bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-foreground"
      >{workspace.consoleLines
  .map((line) => `${line.level === "log" ? "" : `${line.level}: `}${line.text}`)
  .join("\n")}</pre>
      {#if workspace.consoleTruncated}
        <!-- A rAF loop with a stray log prints sixty lines a second; the useful
             ones are the newest, so the older ones are gone. -->
        <p class="px-2 py-1 text-xs text-muted-foreground">{m.artifact_console_truncated()}</p>
      {/if}
    </div>
  {/if}

  {#if diagnostic}
    <!-- The compiler's own words. Rendered as text, never as markup (§13, §21). -->
    <div class="flex items-start gap-2 border-t border-border bg-destructive/10 p-2">
      <pre
        class="max-h-24 min-w-0 flex-1 overflow-auto text-xs whitespace-pre-wrap text-foreground"
        role="status"
      >{diagnostic}</pre>
      {#if onaskforhelp}
        <!--
          The one thing a pupil can do about an error they cannot read: hand it
          back with the failure already recorded against the version, so the next
          answer is about this error rather than about "it broke".
        -->
        <button
          type="button"
          onclick={() => onaskforhelp?.(diagnosticStatus)}
          disabled={workspace.pendingBuildReport !== null}
          class="min-h-9 shrink-0 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {m.artifact_ask_fix()}
        </button>
      {/if}
    </div>
  {/if}
</div>
