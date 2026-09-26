<script lang="ts">
import { enhance } from "$app/forms";
import { classroomStateLabel } from "$lib/classroom/state-label";
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { AvailabilityStatus } from "$lib/server/classroom/schedule";

/**
 * Open now and Lock (PRD §8, §17).
 *
 * "The educator has two prominent controls: Open now, with duration options
 * including until the end of the current scheduled window, and Lock classroom,
 * which takes effect immediately."
 *
 * The strip carries the room's state as colour as well as words, so an educator
 * crossing the room can read it from the projector without stopping to parse a
 * sentence — the one place in this dense panel that spends any visual weight.
 *
 * Trivial forms, so plain progressively-enhanced actions rather than Superforms
 * (§5). They work with JavaScript off, which matters on a school machine.
 */

interface Props {
  availability: AvailabilityStatus;
  timezone: string;
}

let { availability, timezone }: Props = $props();

const label = $derived(classroomStateLabel(availability));

/** Formatting only; the instant was resolved on the server via `date-fns-tz` (§5). */
const until = $derived.by(() => {
  if (!availability.opensUntil) return null;
  return new Intl.DateTimeFormat(getLocale(), {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(new Date(availability.opensUntil));
});

const button = "h-9 rounded-md px-3 text-sm font-medium disabled:opacity-60";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_availability_title()}</h2>

  <div
    class="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5"
    class:border-destructive={!availability.open}
    class:bg-destructive={!availability.open}
    class:text-destructive-foreground={!availability.open}
    class:border-border={availability.open}
    class:bg-secondary={availability.open}
    class:text-secondary-foreground={availability.open}
  >
    <span class="text-sm font-semibold">{label}</span>
    {#if until}
      <span class="text-xs opacity-80">{m.classroom_open_until({ when: until })}</span>
    {/if}
  </div>

  <div class="flex flex-wrap items-end gap-2">
    <form method="POST" action="?/setState" use:enhance class="flex items-end gap-2">
      <input type="hidden" name="state" value="open">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_open_duration_label()}</span>
        <select
          name="duration"
          class="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        >
          <option value="30">{m.educator_open_duration_30()}</option>
          <option value="60">{m.educator_open_duration_60()}</option>
          <option value="120">{m.educator_open_duration_120()}</option>
          <option value="window">{m.educator_open_duration_window()}</option>
          <option value="indefinite">{m.educator_open_duration_indefinite()}</option>
        </select>
      </label>
      <button type="submit" class="{button} bg-primary text-primary-foreground hover:bg-primary/90">
        {m.educator_open_now()}
      </button>
    </form>

    <form method="POST" action="?/setState" use:enhance>
      <input type="hidden" name="state" value="locked">
      <button
        type="submit"
        class="{button} bg-destructive text-destructive-foreground hover:bg-destructive/90"
      >
        {m.educator_lock_classroom()}
      </button>
    </form>

    <form method="POST" action="?/setState" use:enhance>
      <input type="hidden" name="state" value="scheduled">
      <button type="submit" class="{button} border border-input text-foreground hover:bg-secondary">
        {m.educator_follow_schedule()}
      </button>
    </form>
  </div>
</section>
