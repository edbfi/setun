<script lang="ts">
import {
  type ArtifactSegment,
  artifactMessageSegments,
  groupStreamingWrites,
  pairArtifactRefs,
  type StreamingSegment,
} from "$lib/artifacts/segments";
import { toolLabel } from "$lib/chat/tool-labels";
import { turnNoticeText } from "$lib/chat/turn-notices";
import { streamingPartSegments } from "$lib/chat/turn-stage";
import * as m from "$lib/paraglide/messages";
import type { MessagePart } from "$lib/server/db/schema";
import type { MessageArtifactRef } from "$lib/state/conversation.svelte";
import ArtifactCard from "./ArtifactCard.svelte";
import ArtifactContainedCard from "./ArtifactContainedCard.svelte";
import ArtifactStubCard from "./ArtifactStubCard.svelte";
import MarkdownMessage from "./MarkdownMessage.svelte";
import ThinkingBlock from "./ThinkingBlock.svelte";
import ToolAttribution from "./ToolAttribution.svelte";

/**
 * One message's content, in the order it happened (PRD §10, §11, §13, §15).
 *
 * The same component renders a turn as it streams and the same turn after a
 * reload, because both are the ordered `MessagePart[]` the server persists. A
 * separate live view is how the two come to disagree about what happened.
 *
 * Prose is plain preformatted text while the turn streams and markdown once it
 * settles: re-parsing and re-highlighting a growing message on every delta is
 * the work that drops frames on the target hardware (§20). Fence *boundaries*
 * are scanned even while streaming — one split and one regular expression per
 * line — because the alternative is a pupil watching `<!doctype html>` arrive a
 * word at a time where the page they asked for should be (§13).
 *
 * The type import is erased at compile time; no server code enters the bundle.
 */
interface Props {
  parts: readonly MessagePart[];
  /** True while the turn is still arriving, which keeps prose unparsed (§20). */
  streaming?: boolean;
  /** User messages are the pupil's own words and are never parsed as markdown. */
  plain?: boolean;
  /** What the server recorded for this message, in the order the blocks came (§13). */
  artifacts?: readonly MessageArtifactRef[];
  /** Which artifact the build surface is showing, so its card can say so (§13). */
  activeArtifactId?: string | null;
  onopenartifact?: (artifactId: string) => void;
  /**
   * The conversation's artifact a fence's id names, when there is one (§13).
   *
   * A write that restated a file unchanged records no revision, so this message
   * has no ref for it — but the thing it names still exists, and its card can
   * still open it.
   */
  resolveArtifact?: (key: string) => { readonly id: string; readonly title: string | null } | null;
  /**
   * The streaming scan, when the caller already made it (§20).
   *
   * The live message needs the same scan to name its current stage, and one
   * scan per delta is the budget — so it scans once and hands the result down.
   */
  streamingSegments?: ReadonlyMap<number, StreamingSegment[]>;
  /**
   * Whether the model's reasoning is rendered at all (§20).
   *
   * The classroom's policy and the pupil's own switch, already resolved. A part
   * that is not rendered is simply skipped: a persisted summary stays on the
   * message, and turning the switch back on shows it again.
   */
  showThinking?: boolean;
  /**
   * When the reasoning began and settled, for the block's elapsed figure (§20).
   *
   * Only a streaming turn has them: a message read back after a reload is a
   * record of what was said, not of how long it took, so its block simply says
   * "Thoughts".
   */
  thinkingStartedAt?: number | null;
  thinkingSettledAt?: number | null;
  thinkingTimings?: Readonly<Record<number, { startedAt: number; settledAt: number | null }>>;
}

let {
  parts,
  streaming = false,
  plain = false,
  artifacts,
  activeArtifactId = null,
  onopenartifact,
  resolveArtifact,
  streamingSegments,
  showThinking = true,
  thinkingStartedAt = null,
  thinkingSettledAt = null,
  thinkingTimings = {},
}: Props = $props();

/**
 * Group all text parts together, just as the recorder does (§13).
 */
const settledByPart = $derived.by(() => {
  const texts: string[] = [];
  const indexes: number[] = [];
  parts.forEach((part, index) => {
    if (part.type !== "text") return;
    texts.push(part.text);
    indexes.push(index);
  });
  const byIndex = new Map<number, ArtifactSegment[]>();
  artifactMessageSegments(texts).forEach((segments, at) => {
    byIndex.set(indexes[at], segments);
  });
  return byIndex;
});

/**
 * Which recorded revision each card stands for, by card index (§13).
 *
 * The refs come from the database and the blocks from the text. They usually
 * agree, but an identical re-emission appends no revision and a write over the
 * caps records nothing — and a card with no ref used to send the *whole*
 * message back to raw fences, which is how restating one stylesheet put a page
 * of code in the chat. Paired per card now; a card with no ref stays a card.
 */
const pairs = $derived.by(() => {
  const cards = [...settledByPart.values()].flat().filter((segment) => segment.kind === "artifact");
  const paired = pairArtifactRefs(cards, artifacts ?? []);
  return new Map(
    [...cards].sort((a, b) => a.index - b.index).map((card, at) => [card.index, paired[at]]),
  );
});

/**
 * The streaming scan, over the message's text parts as one document (§13, §20).
 *
 * A tool call or a generated image between two deltas starts a new text part,
 * and a fence can span one — so the parts are scanned together rather than each
 * on its own, and the part that opened a fence is the one that shows its stub.
 * Only while streaming: a settled message goes through `artifactSegments`, which
 * is where the refs exist.
 */
const streamingByPart = $derived.by(() => {
  if (!streaming || plain) return new Map<number, StreamingSegment[]>();
  return streamingSegments ?? streamingPartSegments(parts);
});

const results = $derived(
  parts.filter(
    (part): part is Extract<MessagePart, { type: "tool-result" }> => part.type === "tool-result",
  ),
);

/** Which calls already have a result; the rest are still running. */
const settled = $derived(new Set(results.map((part) => part.toolCallId)));
const failed = $derived(
  new Set(results.filter((part) => part.isError).map((part) => part.toolCallId)),
);
</script>

{#each parts as part, index (index)}
  {#if part.type === "text"}
    {#if plain}
      <p class="whitespace-pre-wrap break-words">{part.text}</p>
    {:else if streaming}
      <!--
        Still arriving: prose stays unparsed, and each artifact fence is a stub
        card. There are no refs yet, so nothing here opens anything — the real
        cards arrive with the settled message (§13, §20).
      -->
      {#each groupStreamingWrites(streamingByPart.get(index) ?? []) as segment, at (at)}
        {#if segment.kind === "text"}
          <p class="whitespace-pre-wrap break-words">{segment.text}</p>
        {:else}
          <!--
            One card per write, its files as rows. Every artifact file is in it,
            runnable or not: a revision that re-emits only a stylesheet is still
            a write of the artifact, and its CSS is no more prose than a page's
            markup is (§13).
          -->
          <ArtifactStubCard
            write={segment}
            knownTitle={segment.key ? (resolveArtifact?.(segment.key)?.title ?? null) : null}
          />
        {/if}
      {/each}
    {:else}
      <!--
        The artifacts pulled out of the prose and shown as cards; everything
        between them is ordinary markdown, and `renderMarkdown` stays the only
        producer of `{@html}` in the transcript (§5). A block with no recorded
        revision, or one the turn never finished, is still a card — contained,
        with its source a click away — and never a wall of code (§13, §20).
      -->
      {#each settledByPart.get(index) ?? [] as segment, at (at)}
        {#if segment.kind === "text"}
          <MarkdownMessage text={segment.text} />
        {:else if segment.kind === "unclosed"}
          <ArtifactContainedCard fence={segment.fence} raw={segment.raw} reason="incomplete" />
        {:else}
          {@const ref = pairs.get(segment.index) ?? null}
          {#if ref}
            <ArtifactCard
              artifact={ref}
              active={ref.artifactId === activeArtifactId}
              onopen={onopenartifact}
              files={segment.files}
              deletes={segment.deletes}
            />
          {:else}
            {@const named = segment.artifact.key
              ? (resolveArtifact?.(segment.artifact.key) ?? null)
              : null}
            <ArtifactContainedCard
              fence={{ ...segment.artifact, title: segment.artifact.title ?? named?.title ?? null }}
              raw={segment.raw}
              files={segment.files}
              reason={named ? "existing" : "unsaved"}
              artifactId={named?.id ?? null}
              active={named !== null && named.id === activeArtifactId}
              onopen={onopenartifact}
            />
          {/if}
        {/if}
      {/each}
    {/if}
  {:else if part.type === "thinking"}
    {#if showThinking}
      <!--
        What the model worked out before it answered, collapsed (§20). Live only
        while it is the last thing that has arrived: once prose follows it, the
        reasoning is finished whatever the turn is doing.
      -->
      <ThinkingBlock
        text={part.text}
        live={streaming &&
          index === parts.length - 1 &&
          (thinkingTimings[index]?.settledAt ?? null) === null}
        startedAt={thinkingTimings[index]?.startedAt ?? thinkingStartedAt}
        settledAt={thinkingTimings[index]?.settledAt ?? thinkingSettledAt}
      />
    {/if}
  {:else if part.type === "tool-call"}
    <!--
      One line per tool, with the same attribution device the prompt used, so a
      pupil can see afterwards what ran and who it belonged to (§11).
    -->
    <div class="my-1.5 flex flex-col gap-0.5">
      <ToolAttribution serverLabel={part.serverLabel} />
      <span class="pl-2.5 text-xs text-muted-foreground">
        {#if part.decision === "declined"}
          {m.chat_permission_declined_notice()}
        {:else if !settled.has(part.toolCallId)}
          {m.chat_tool_running({ tool: toolLabel(part.toolName) })}
        {:else if failed.has(part.toolCallId)}
          {m.chat_tool_failed({ tool: toolLabel(part.toolName) })}
        {:else}
          {m.chat_tool_done({ tool: toolLabel(part.toolName) })}
        {/if}
      </span>
    </div>
  {:else if part.type === "generated-image"}
    <!--
      Served by Setun, scoped to its owner. No external image URL ever reaches
      the browser (§15, §21).
    -->
    <img
      src="/api/images/{part.imageId}"
      alt={m.chat_image_alt({ prompt: part.prompt })}
      loading="lazy"
      class="my-1 max-h-80 w-full rounded-md border border-border object-contain"
    >
  {:else if part.type === "artifact-edit"}
    <!--
      The pupil's own current source, carried to the model on this message (§13).
      Shown as a compact reference rather than the code itself: they did not type
      it into the composer, and a wall of markup in the transcript reads as noise.
    -->
    <span
      class="my-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-xs"
    >
      <span class="truncate">
        {m.artifact_edit_part_label({
          title: part.title ?? m.artifact_untitled({ language: part.language }),
        })}
      </span>
    </span>
  {:else if part.type === "context-compacted"}
    <!--
      Where the model's view of the conversation stopped being the whole of it
      (§10). Faint, and above the answer it applies to: the messages are all
      still here for the pupil, but the model no longer reads the start of them
      word for word, and this is why it may not recall something said long ago.
    -->
    <p
      class="mb-2 flex items-center gap-2 text-xs text-muted-foreground"
      data-context-compacted={part.mode}
    >
      <span class="h-px flex-1 bg-border" aria-hidden="true"></span>
      <span class="shrink-0">
        {part.mode === "summarised" ? m.chat_context_summarised() : m.chat_context_omitted()}
      </span>
      <span class="h-px flex-1 bg-border" aria-hidden="true"></span>
    </p>
  {:else if part.type === "turn-notice"}
    <!--
      Why the answer stops here: Stop pressed, a per-turn cap reached, a question
      nobody answered. Persisted as a part rather than held in the live turn, so
      it is still there after a reload — a sentence that simply ends, with nothing
      to say it was cut short, is the thing this replaces (§10, §11).
    -->
    <p class="mt-2 text-xs text-muted-foreground">{turnNoticeText(part.notice)}</p>
  {:else if part.type === "attachment"}
    <span
      class="my-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-xs"
    >
      <span class="truncate">{part.filename}</span>
    </span>
  {/if}
{/each}
