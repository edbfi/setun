<script lang="ts">
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { ClassroomStatus } from "$lib/server/classroom/status";

/**
 * The closed-classroom screen (PRD §8).
 *
 * "When access is unavailable, students see a plain, friendly status screen with
 * the next scheduled opening — never a raw authorisation error, never any
 * infrastructure detail."
 *
 * The next opening is the only thing a pupil actually wants to know here, so it
 * is the one loud element on the page; everything else is quiet around it. The
 * instant is formatted in the *classroom's* timezone, not the device's — a
 * school Chromebook set to the wrong zone would otherwise name the wrong lesson.
 */

interface Props {
  status: ClassroomStatus;
}

let { status }: Props = $props();

const reason = $derived(
  status.reason === "explicit-lock" ? m.classroom_closed_locked() : m.classroom_closed_outside(),
);

/**
 * Formatted with `Intl` in the classroom's zone.
 *
 * Formatting, not arithmetic: every instant here was already resolved on the
 * server through `date-fns-tz` (§5). Weekday and time both, because "09:00"
 * alone does not say whether that is today or Monday.
 */
const nextOpening = $derived.by(() => {
  if (!status.nextOpeningAt) return null;

  return new Intl.DateTimeFormat(getLocale(), {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    // A 24-hour clock in both locales: Danish schools write lesson times that
    // way, and "09" is unambiguous where "09 AM" invites a second reading.
    hourCycle: "h23",
    timeZone: status.timezone,
  }).format(new Date(status.nextOpeningAt));
});
</script>

<section
  class="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-16 text-center"
  role="status"
>
  <SetunMark size={32} class="text-muted-foreground" />

  <div class="flex flex-col gap-1.5">
    <h1 class="text-base font-semibold text-foreground">{m.classroom_closed_title()}</h1>
    <p class="text-sm text-muted-foreground">{reason}</p>
  </div>

  {#if nextOpening}
    <!--
      The signature element: the answer to the pupil's only question, set at a
      size nothing else on this screen competes with.
    -->
    <div class="flex flex-col items-center gap-1">
      <span class="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {m.classroom_next_opening_label()}
      </span>
      <p class="text-xl font-semibold text-foreground sm:text-2xl">
        {m.classroom_next_opening({ when: nextOpening })}
      </p>
    </div>
  {:else}
    <p class="text-sm text-muted-foreground">{m.classroom_no_next_opening()}</p>
  {/if}

  <p class="max-w-xs text-xs text-muted-foreground">{m.classroom_closed_meanwhile()}</p>
</section>
