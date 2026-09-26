<script lang="ts">
import { thinkingParagraphHeadline, thinkingParagraphs } from "$lib/chat/thinking-text";
import * as m from "$lib/paraglide/messages";

/**
 * What the model worked out before it answered (PRD §20).
 *
 * Collapsed by default and native: a `<details>` opens with no JavaScript, keeps
 * its state without a store, and is already a disclosure to a screen reader. The
 * answer is what the pupil asked for; the reasoning is there for the pupil who
 * wants to see how it was reached.
 *
 * The body is plain paragraphs and text nodes only. The model wrote this, and a
 * model's output is untrusted — nothing here parses markdown or produces
 * `{@html}` (§21).
 *
 * While the turn is live the summary counts seconds and shows the latest
 * headline, so a pupil watching a long reasoning pass can see it moving. Once
 * the answer starts arriving it settles to "Thoughts" and stops ticking: a timer
 * running under a finished answer is noise.
 */
interface Props {
  text: string;
  /** True while the reasoning is still arriving — not merely while the turn is. */
  live?: boolean;
  /** When the reasoning began, for the elapsed figure. */
  startedAt?: number | null;
  /** When it settled, so a finished block reports how long it took. */
  settledAt?: number | null;
  /** Injectable clock, so the elapsed figure is testable without waiting (§22). */
  now?: () => number;
}

let { text, live = false, startedAt = null, settledAt = null, now = Date.now }: Props = $props();

// The clock is read once to seed the tick; the interval below is what
// keeps it moving, so the "referenced locally" note does not apply.
// svelte-ignore state_referenced_locally
let tick = $state(now());

/**
 * One tick a second, and only while the reasoning is live.
 *
 * The whole point of the elapsed figure is that it moves; the whole point of
 * stopping is that a settled block costs a Chromebook nothing (§20).
 */
$effect(() => {
  if (!live) return;

  const timer = setInterval(() => {
    tick = now();
  }, 1_000);
  return () => clearInterval(timer);
});

const seconds = $derived.by(() => {
  if (startedAt === null) return 0;
  const until = live ? tick : (settledAt ?? tick);
  return Math.max(0, Math.round((until - startedAt) / 1000));
});

const paragraphs = $derived(thinkingParagraphs(text));
const headline = $derived(thinkingParagraphHeadline(paragraphs.at(-1) ?? ""));
</script>

<details class="my-1.5 rounded-md border border-border bg-secondary/40 text-xs">
  <summary
    class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-muted-foreground marker:text-muted-foreground"
  >
    {#if live}
      <span
        class="thinking-pulse size-1.5 shrink-0 rounded-full bg-primary"
        aria-hidden="true"
      ></span>
      <span class="shrink-0">{m.chat_thinking_elapsed({ seconds })}</span>
      {#if headline}
        <!--
          The latest headline, so a collapsed block still says what is going on.
          Hidden from assistive technology: the disclosure already names itself,
          and a line that rewrites itself every few seconds under a screen reader
          is a stream of interruptions.
        -->
        <span class="truncate opacity-70" aria-hidden="true">{headline}</span>
      {/if}
    {:else}
      <span>{seconds > 0 ? m.chat_thoughts_elapsed({ seconds }) : m.chat_thoughts()}</span>
    {/if}
  </summary>

  <div class="flex flex-col gap-1.5 border-t border-border px-2.5 py-2 text-muted-foreground">
    {#each paragraphs as paragraph, index (index)}
      <p class="whitespace-pre-wrap break-words">{paragraph}</p>
    {/each}
  </div>
</details>

<style>
@media (prefers-reduced-motion: no-preference) {
  .thinking-pulse {
    animation: setun-thinking-pulse 1.4s ease-in-out infinite;
  }
}

@keyframes setun-thinking-pulse {
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
