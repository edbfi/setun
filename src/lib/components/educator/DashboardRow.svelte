<script lang="ts">
import { enhance } from "$app/forms";
import { classroomStateLabel } from "$lib/classroom/state-label";
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { ClassroomOverview } from "$lib/server/classroom/overview";

/**
 * One classroom on the dashboard (PRD §8, §17).
 *
 * "Classroom state, active students… current window, usage against budgets and
 * caps, and a one-click lock" — a single line an educator reads in a glance,
 * with the lock beside it so ending a lesson never needs a navigation.
 *
 * State is colour as well as words, because this is the one thing in the panel
 * that gets read across a room.
 */

interface Props {
  overview: ClassroomOverview;
}

let { overview }: Props = $props();

const numbers = $derived(new Intl.NumberFormat(getLocale()));

/** Formatting only; the instant was resolved on the server via `date-fns-tz` (§5). */
const clock = $derived(
  new Intl.DateTimeFormat(getLocale(), {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: overview.timezone,
  }),
);

const stateLabel = $derived(classroomStateLabel(overview.availability));

const window = $derived.by(() => {
  if (overview.availability.open && overview.availability.opensUntil) {
    return m.classroom_open_until({
      when: clock.format(new Date(overview.availability.opensUntil)),
    });
  }
  if (!overview.availability.open && overview.availability.nextOpeningAt) {
    return m.educator_next_opening({
      when: clock.format(new Date(overview.availability.nextOpeningAt)),
    });
  }
  return null;
});

const percent = $derived(
  overview.capTokens > 0
    ? Math.min(100, Math.round((overview.usedTokens / overview.capTokens) * 100))
    : 0,
);
</script>

<div
  class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border px-3 py-2.5"
>
  <span
    class="size-2 shrink-0 rounded-full"
    class:bg-primary={overview.availability.open}
    class:bg-destructive={!overview.availability.open}
    aria-hidden="true"
  ></span>

  <a
    href="/educator/classrooms/{overview.id}"
    class="text-sm font-medium text-foreground underline-offset-2 hover:underline"
  >
    {overview.name}
  </a>

  <span class="text-xs text-muted-foreground">{stateLabel}</span>
  {#if window}
    <span class="text-xs text-muted-foreground">{window}</span>
  {/if}

  <span class="text-xs text-muted-foreground tabular-nums">
    {m.educator_active_of({
  active: numbers.format(overview.activeStudents),
  total: numbers.format(overview.studentCount),
})}
  </span>

  <span
    class="text-xs tabular-nums"
    class:text-destructive={overview.capExhausted}
    class:text-muted-foreground={!overview.capExhausted}
  >
    {m.educator_cap_used({ percent: numbers.format(percent) })}
  </span>

  <form method="POST" action="?/setState" use:enhance class="ms-auto">
    <input type="hidden" name="classroomId" value={overview.id}>
    <input type="hidden" name="state" value={overview.state === "locked" ? "scheduled" : "locked"}>
    <button
      type="submit"
      class="h-8 rounded-md px-2.5 text-xs font-medium"
      class:bg-destructive={overview.state !== "locked"}
      class:text-destructive-foreground={overview.state !== "locked"}
      class:border={overview.state === "locked"}
      class:border-input={overview.state === "locked"}
      class:text-foreground={overview.state === "locked"}
    >
      {overview.state === "locked" ? m.educator_follow_schedule() : m.educator_lock_classroom()}
    </button>
  </form>
</div>
