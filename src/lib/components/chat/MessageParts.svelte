<script lang="ts">
import {
  type ArtifactSegment,
  artifactMessageSegments,
  type StreamingSegment,
  streamingMessageSegments,
} from "$lib/artifacts/segments";
import { toolLabel } from "$lib/chat/tool-labels";
import { turnNoticeText } from "$lib/chat/turn-notices";
import * as m from "$lib/paraglide/messages";
import type { MessagePart } from "$lib/server/db/schema";
import type { MessageArtifactRef } from "$lib/state/conversation.svelte";
import ArtifactCard from "./ArtifactCard.svelte";
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
 * Whether the cards can be trusted to name what the blocks are.
 *
 * The refs come from the database and the blocks from the text, and the two are
 * produced by the same `detectArtifacts` — but a message edited on the server, a
 * deleted artifact, or an identical re-emission that appended no revision can
 * leave them out of step. When the count or the languages disagree the fence is
 * rendered as it was written, which is the old behaviour and never wrong.
 */
const aligned = $derived.by(() => {
  const refs = artifacts ?? [];
  const cards = [...settledByPart.values()].flat().filter((segment) => segment.kind === "artifact");
  if (refs.length === 0 || refs.length !== cards.length) return false;
  return cards.every((segment) => {
    // A write whose first fence is a plain file — a revision that changed only
    // the stylesheet — states no language of its own, so there is nothing to
    // compare and the ref's own tag stands (§13).
    if (segment.artifact.language === null) return refs[segment.index] !== undefined;
    return refs[segment.index]?.language === segment.artifact.language;
  });
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
  const byIndex = new Map<number, StreamingSegment[]>();
  if (!streaming || plain) return byIndex;

  const texts: string[] = [];
  const indexes: number[] = [];
  parts.forEach((part, index) => {
    if (part.type !== "text") return;
    texts.push(part.text);
    indexes.push(index);
  });

  streamingMessageSegments(texts).forEach((segments, at) => {
    byIndex.set(indexes[at], segments);
  });

  return byIndex;
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
      {#each streamingByPart.get(index) ?? [] as segment, at (at)}
        {#if segment.kind === "text"}
          <p class="whitespace-pre-wrap break-words">{segment.text}</p>
        {:else if segment.kind === "artifact"}
          <!--
            A write whose first fence is a plain file — a revision that touched
            only the stylesheet — has no language to show a trit for, so it stays
            in the prose rather than becoming a card that names nothing (§13).
          -->
          {#if segment.artifact.language}
            <ArtifactStubCard
              language={segment.artifact.language}
              artifactKey={segment.artifact.key}
              title={segment.artifact.title}
            />
          {/if}
        {:else}
          <ArtifactStubCard
            language={segment.language}
            artifactKey={segment.key}
            title={segment.title}
            lines={segment.lines}
            path={segment.path}
            pending
          />
        {/if}
      {/each}
    {:else if !aligned}
      <MarkdownMessage text={part.text} />
    {:else}
      <!--
        The artifacts pulled out of the prose and shown as cards; everything
        between them is ordinary markdown, and `renderMarkdown` stays the only
        producer of `{@html}` in the transcript (§5).
      -->
      {#each settledByPart.get(index) ?? [] as segment, at (at)}
        {#if segment.kind === "text"}
          <MarkdownMessage text={segment.text} />
        {:else if artifacts?.[segment.index]}
          <ArtifactCard
            artifact={artifacts[segment.index]}
            active={artifacts[segment.index].artifactId === activeArtifactId}
            onopen={onopenartifact}
          />
        {:else}
          <MarkdownMessage text={segment.raw} />
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
        live={streaming && index === parts.length - 1 && (thinkingTimings[index]?.settledAt ?? null) === null}
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
