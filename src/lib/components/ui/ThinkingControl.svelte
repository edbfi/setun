<script lang="ts">
import * as m from "$lib/paraglide/messages";
import { getThinking } from "$lib/state/thinking.svelte";

/**
 * Whether to show what the model works out before it answers (PRD §20).
 *
 * Two values, so a switch rather than the theme control's three-way radio group.
 * Rendered only where the classroom left the choice to the pupil — a control
 * that decides nothing is a promise the interface does not keep.
 *
 * A device setting like the theme: stored in this browser, never sent to the
 * server, never recorded against the pupil (§16).
 */
const thinking = getThinking();
</script>

<button
  type="button"
  role="switch"
  aria-checked={thinking.shown}
  onclick={() => thinking.toggle()}
  title={m.chat_thinking_toggle_help()}
  class="flex w-full items-center justify-between gap-2 rounded-lg border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
  <span>{m.chat_thinking_toggle_label()}</span>
  <span
    aria-hidden="true"
    class={[
      "relative h-4 w-7 shrink-0 rounded-full transition-colors",
      thinking.shown ? "bg-primary" : "bg-border",
    ]}
  >
    <span
      class={[
        "absolute top-0.5 size-3 rounded-full bg-background transition-all",
        thinking.shown ? "left-3.5" : "left-0.5",
      ]}
    ></span>
  </span>
</button>
