<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { DoneSound } from "$lib/server/db/schema";
import { effectiveDoneSound, getDoneSound } from "$lib/state/done-sound.svelte";

/**
 * Whether this device chimes when an answer is done (PRD §20).
 *
 * Always offered — unlike the thinking switch, the classroom only sets the
 * default here, so the pupil's switch always decides something. It shows what
 * will actually happen on this device, whichever of the two decided it.
 *
 * A device setting like the theme: stored in this browser, never sent to the
 * server, never recorded against the pupil (§16).
 *
 * The type import is erased at compile time.
 */
interface Props {
  /** The classroom's default, which applies until the pupil chooses. */
  classroomDefault: DoneSound;
}

let { classroomDefault }: Props = $props();

const doneSound = getDoneSound();
const on = $derived(effectiveDoneSound(classroomDefault, doneSound.preference));
</script>

<button
  type="button"
  role="switch"
  aria-checked={on}
  onclick={() => doneSound.toggle(classroomDefault)}
  title={m.chat_done_sound_help()}
  class="flex w-full items-center justify-between gap-2 rounded-lg border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
  <span>{m.chat_done_sound_label()}</span>
  <span
    aria-hidden="true"
    class={[
      "relative h-4 w-7 shrink-0 rounded-full transition-colors motion-reduce:transition-none",
      on ? "bg-primary" : "bg-border",
    ]}
  >
    <span
      class={[
        "absolute top-0.5 size-3 rounded-full bg-background transition-all motion-reduce:transition-none",
        on ? "left-3.5" : "left-0.5",
      ]}
    ></span>
  </span>
</button>
