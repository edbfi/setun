<script lang="ts">
import {
  PLACEHOLDER_INTERVAL_MS,
  PLACEHOLDER_STATUSES,
  placeholderIndex,
} from "$lib/chat/thinking-status";
import { turnNoticeText } from "$lib/chat/turn-notices";
import { stageLabel, streamingPartSegments, turnStage } from "$lib/chat/turn-stage";
import * as m from "$lib/paraglide/messages";
import type { StreamingTurn } from "$lib/state/streaming-turn.svelte";
import MessageParts from "./MessageParts.svelte";

/**
 * The turn currently streaming (PRD §10, §11, §20).
 *
 * The same shape a settled answer has, deliberately: this used to be a bordered
 * card, so the answer visibly changed container the instant it finished and the
 * whole column reflowed under the pupil's eyes. What marks it as live is the
 * caret at the end of the text, and the activity row under it.
 *
 * The activity row is there for the whole of the turn, not only before the
 * first word: "when is it done?" is the question a classroom asks, and a turn
 * that has written a paragraph and is now quietly running a tool looked frozen.
 * It names the stage — thinking, running a tool, writing a file, writing the
 * answer, waiting on the pupil — and counts the seconds.
 *
 * Prose stays plain preformatted text until the turn settles and the message
 * joins the list: re-parsing and re-highlighting a growing message on every
 * delta is the work that drops frames on the target hardware (§20).
 *
 * The permission prompt and the elicitation form are rendered by the page rather
 * than here, because they are the turn's only interactive parts and the page
 * owns the endpoint they answer to.
 */
interface Props {
  turn: StreamingTurn;
  /** Whether the model's reasoning is rendered, once policy and preference agree (§20). */
  showThinking?: boolean;
  /** Injectable clock, so the elapsed figure is testable without waiting (§22). */
  now?: () => number;
  /** Passed through to the transcript's cards, so a revision names what it revises. */
  resolveArtifact?: (key: string) => { readonly id: string; readonly title: string | null } | null;
}

let { turn, showThinking = true, now = Date.now, resolveArtifact }: Props = $props();

const noticeText = $derived(turn.notice ? turnNoticeText(turn.notice) : null);

/**
 * Whether the placeholder is what the pupil is looking at.
 *
 * A reasoning model can spend forty seconds before its first word. With the
 * thinking block shown that wait is filled by the reasoning itself; with it
 * hidden — or before the first summary arrives — there is nothing on screen at
 * all, and the placeholder is the whole of the feedback (§20).
 */
const waiting = $derived(
  turn.streaming && !turn.hasVisibleOutput && !(showThinking && turn.thinking.length > 0),
);

// The clock is read once to seed the tick; the interval below is what
// keeps it moving, so the "referenced locally" note does not apply.
// svelte-ignore state_referenced_locally
let tick = $state(now());

/**
 * One tick a second, and only while the turn is running.
 *
 * A timer that keeps running under a settled answer is work a dual-core
 * Chromebook does for nothing (§20).
 */
$effect(() => {
  if (!turn.streaming) return;

  const timer = setInterval(() => {
    tick = now();
  }, 1_000);
  return () => clearInterval(timer);
});

const elapsedMs = $derived(turn.startedAt === null ? 0 : Math.max(0, tick - turn.startedAt));
const status = $derived(PLACEHOLDER_STATUSES[placeholderIndex(elapsedMs, PLACEHOLDER_INTERVAL_MS)]);
const seconds = $derived(Math.round(elapsedMs / 1000));

/** The one streaming scan per delta, shared with the transcript below (§20). */
const segments = $derived(streamingPartSegments(turn.parts));

const stage = $derived(
  turnStage({
    parts: turn.parts,
    lastSegments: segments.get(turn.parts.length - 1),
    waiting: turn.waiting,
  }),
);

/**
 * What the row says. Before anything arrives — or while the reasoning is hidden
 * and nothing else has — the rotating placeholder, which says time is passing
 * without claiming to know more.
 */
const label = $derived(waiting || stage.kind === "starting" ? null : stageLabel(stage));
</script>

{#if turn.streaming || !turn.isEmpty || noticeText}
  <article
    class="flex flex-col items-start gap-1.5"
    data-role="assistant"
    data-streaming={turn.streaming}
  >
    <div class="w-full text-[0.9375rem] leading-[1.65] text-foreground">
      {#if !turn.isEmpty}
        <div class={turn.streaming ? "streaming-caret" : ""}>
          <MessageParts
            parts={turn.parts}
            streamingSegments={segments}
            {resolveArtifact}
            streaming
            {showThinking}
            thinkingStartedAt={turn.thinkingStartedAt}
            thinkingSettledAt={turn.thinkingSettledAt}
            thinkingTimings={turn.thinkingTimings}
          />
        </div>
      {/if}

      {#if turn.streaming}
        <!--
          The activity row, for the whole of the turn. The stage is a polite
          live region: it changes when the turn moves on, not every second, so
          a screen reader hears "Writing index.html…" once. The seconds and the
          rotating placeholder are for the eye only — a status that rewrites
          itself every second under a screen reader is a stream of
          interruptions.
        -->
        <p
          class="mt-1 flex items-center gap-2 text-sm text-muted-foreground"
          data-turn-stage={stage.kind}
        >
          <span
            class="thinking-pulse size-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          ></span>
          {#if label}
            <span class="min-w-0 truncate" role="status" aria-live="polite">{label}</span>
          {:else}
            <span class="sr-only" role="status">{m.chat_thinking()}</span>
            <span class="min-w-0 truncate" aria-hidden="true">{status()}</span>
          {/if}
          {#if seconds >= 1}
            <span class="shrink-0 text-xs tabular-nums opacity-70" aria-hidden="true">
              {m.chat_status_elapsed({ seconds })}
            </span>
          {/if}
        </p>
      {/if}

      {#if noticeText}
        <p class="mt-2 text-xs text-muted-foreground">{noticeText}</p>
      {/if}
    </div>
  </article>
{/if}

<style>
/*
   * The caret rides the last line of prose, where the pupil is already looking.
   *
   * Only the last *paragraph*: a turn that ends on a write card or an image has
   * no line to ride, and the caret used to stand alone under it as a stray
   * block. The activity row below says the turn is live in every case now, so
   * the caret need not.
   */
.streaming-caret > :global(p:last-child)::after {
  content: "";
  display: inline-block;
  vertical-align: text-bottom;
  inline-size: 0.45em;
  block-size: 1.05em;
  margin-inline-start: 0.15em;
  background: oklch(var(--primary));
  border-radius: 1px;
}

@media (prefers-reduced-motion: no-preference) {
  .streaming-caret > :global(p:last-child)::after {
    animation: setun-caret 1.1s steps(1, end) infinite;
  }

  .thinking-pulse {
    animation: setun-pulse 1.4s ease-in-out infinite;
  }
}

@keyframes setun-caret {
  0%,
  55% {
    opacity: 1;
  }
  56%,
  100% {
    opacity: 0.15;
  }
}

@keyframes setun-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}
</style>
