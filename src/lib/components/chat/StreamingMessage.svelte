<script lang="ts">
import {
  PLACEHOLDER_INTERVAL_MS,
  PLACEHOLDER_STATUSES,
  placeholderIndex,
} from "$lib/chat/thinking-status";
import { turnNoticeText } from "$lib/chat/turn-notices";
import * as m from "$lib/paraglide/messages";
import type { StreamingTurn } from "$lib/state/streaming-turn.svelte";
import MessageParts from "./MessageParts.svelte";

/**
 * The turn currently streaming (PRD §10, §11, §20).
 *
 * The same shape a settled answer has, deliberately: this used to be a bordered
 * card, so the answer visibly changed container the instant it finished and the
 * whole column reflowed under the pupil's eyes. What marks it as live is the
 * caret at the end of the text and nothing else.
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
}

let { turn, showThinking = true, now = Date.now }: Props = $props();

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
 * One tick every few seconds, and only while the placeholder is on screen.
 *
 * A timer that keeps running under a settled answer is work a dual-core
 * Chromebook does for nothing (§20).
 */
$effect(() => {
  if (!waiting) return;

  const timer = setInterval(() => {
    tick = now();
  }, 1_000);
  return () => clearInterval(timer);
});

const elapsedMs = $derived(turn.startedAt === null ? 0 : Math.max(0, tick - turn.startedAt));
const status = $derived(PLACEHOLDER_STATUSES[placeholderIndex(elapsedMs, PLACEHOLDER_INTERVAL_MS)]);
const seconds = $derived(Math.round(elapsedMs / 1000));
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
            streaming
            {showThinking}
            thinkingStartedAt={turn.thinkingStartedAt}
            thinkingSettledAt={turn.thinkingSettledAt}
            thinkingTimings={turn.thinkingTimings}
          />
        </div>
      {/if}

      {#if waiting}
        <!--
          One static label for assistive technology and a rotating line for the
          eye. A status that rewrites itself every four seconds under a screen
          reader is a stream of interruptions; a line that never changes for
          forty seconds reads as a stall.
        -->
        <p class="flex items-center gap-2 text-muted-foreground">
          <span
            class="thinking-pulse size-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          ></span>
          <span class="sr-only" role="status">{m.chat_thinking()}</span>
          <span aria-hidden="true">{status()}</span>
          {#if seconds >= PLACEHOLDER_INTERVAL_MS / 1000}
            <span class="text-xs opacity-70" aria-hidden="true">
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
   * The one thing that says an answer is still arriving. A block on the last
   * line rather than a spinner somewhere else: it is where the pupil is already
   * looking.
   *
   * The last *paragraph*, not the last child of any kind. A turn can end on an
   * artifact stub or a generated image, and hanging the caret off those put it
   * inside the card — or, on a replaced element, nowhere at all, because an
   * `<img>` has no `::after`. So the second rule catches exactly that case and
   * stands the caret after the content instead, which is the only place left
   * for it once there is no line to ride.
   */
.streaming-caret > :global(p:last-child)::after,
.streaming-caret:not(:has(> :global(p:last-child)))::after {
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
  .streaming-caret > :global(p:last-child)::after,
  .streaming-caret:not(:has(> :global(p:last-child)))::after {
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
