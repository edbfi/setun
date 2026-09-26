<script lang="ts">
import type { Snippet } from "svelte";
import { type ArtifactWorkspace, MAX_FRACTION, MIN_FRACTION } from "$lib/state/artifacts.svelte";
import type { SplitAxis } from "$lib/workspace/axis";
import WorkspaceSplitter from "./WorkspaceSplitter.svelte";

/**
 * The two panes and the divider between them (PRD §13, §20).
 *
 * The conversation and the thing being built are one workspace rather than two
 * screens: the composer is never covered, so a pupil can look at what the model
 * made and ask for a change without first putting it away. That was the whole
 * cost of the overlay this replaces — every question about an artifact began
 * with closing the artifact.
 *
 * One geometry, expressed along whichever axis the viewport allows. Wide enough
 * for two readable columns and the divider is vertical; below that the build
 * surface is a sheet under the conversation and the same divider is its grab
 * handle. `flex-basis` in per cent means one number drives both.
 *
 * The build pane is hidden rather than unmounted while the pupil reads, whenever
 * something is running: an artifact holds state a pupil built up, and tearing
 * the frame down to glance at the conversation throws all of it away (§13).
 */
interface Props {
  workspace: ArtifactWorkspace;
  /** Owned by the page, because the header's switcher draws the same axis. */
  axis: SplitAxis;
  /** Named `chat` rather than `conversation`, which is a variable on the route. */
  chat: Snippet;
  build: Snippet;
}

let { workspace, axis, chat, build }: Props = $props();

const split = $derived(workspace.stage === "both");
const chatHidden = $derived(!workspace.conversationVisible);
const buildHidden = $derived(!workspace.visible);

/**
 * The conversation's share, applied along the current axis.
 *
 * Only while both are on screen: a single pane takes what it is given, and
 * pinning a basis on it would leave the other side's space empty.
 */
const chatStyle = $derived(split ? `flex: 0 0 ${(workspace.fraction * 100).toFixed(2)}%` : "");
</script>

<div class={["flex min-h-0 flex-1", axis === "inline" ? "flex-row" : "flex-col"]}>
  <div
    class={["min-h-0 min-w-0 flex-col", chatHidden ? "hidden" : "flex", split ? "" : "flex-1"]}
    style={chatStyle}
  >
    {@render chat()}
  </div>

  {#if split}
    <WorkspaceSplitter
      {axis}
      fraction={workspace.fraction}
      min={MIN_FRACTION}
      max={MAX_FRACTION}
      onfraction={(value) => workspace.setFraction(value)}
    />
  {/if}

  {#if workspace.mounted}
    <div
      class={[
  "min-h-0 min-w-0 flex-1 flex-col border-border bg-card",
  buildHidden ? "hidden" : "flex",
  axis === "inline" ? "border-l" : "border-t",
]}
      data-workspace-pane="build"
    >
      {@render build()}
    </div>
  {/if}
</div>
