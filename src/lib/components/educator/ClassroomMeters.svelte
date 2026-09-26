<script lang="ts">
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { ClassroomOverview } from "$lib/server/classroom/overview";

/**
 * Who is here, and how much of the day's cap is gone (PRD §16, §17).
 *
 * Three counters and a bar. Nothing on this panel shows what anybody wrote —
 * "educators have no interface for reading student conversations" (§16) — so
 * what an educator gets is presence and consumption, which is what they act on.
 *
 * The cost is display-only and absent unless an alias used today carries a
 * price; enforcement is denominated in tokens and never reads one (§10).
 */

interface Props {
  overview: ClassroomOverview;
}

let { overview }: Props = $props();

const numbers = $derived(new Intl.NumberFormat(getLocale()));
const money = $derived(
  new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
);

const percent = $derived(
  overview.capTokens > 0
    ? Math.min(100, Math.round((overview.usedTokens / overview.capTokens) * 100))
    : 0,
);

const cost = $derived(
  overview.costUsd === null || overview.costDkk === null
    ? null
    : m.allowance_cost({
        usd: money.format(overview.costUsd),
        dkk: money.format(overview.costDkk),
      }),
);
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_activity_title()}</h2>

  <dl class="grid grid-cols-2 gap-3 sm:grid-cols-3">
    <div class="rounded-md border border-border px-3 py-2">
      <dt class="text-xs text-muted-foreground">{m.educator_active_students()}</dt>
      <dd class="text-lg font-semibold text-foreground tabular-nums">
        {numbers.format(overview.activeStudents)}
      </dd>
    </div>
    <div class="rounded-md border border-border px-3 py-2">
      <dt class="text-xs text-muted-foreground">{m.educator_roster_title()}</dt>
      <dd class="text-lg font-semibold text-foreground tabular-nums">
        {numbers.format(overview.studentCount)}
      </dd>
    </div>
    <div class="rounded-md border border-border px-3 py-2">
      <dt class="text-xs text-muted-foreground">{m.educator_classroom_cap_label()}</dt>
      <dd
        class="text-lg font-semibold tabular-nums"
        class:text-destructive={overview.capExhausted}
        class:text-foreground={!overview.capExhausted}
      >
        {numbers.format(percent)}%
      </dd>
    </div>
  </dl>

  <div class="flex flex-col gap-1">
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        class="h-full rounded-full"
        class:bg-destructive={overview.capExhausted}
        class:bg-primary={!overview.capExhausted}
        style="width: {percent}%"
      ></div>
    </div>
    <p class="text-xs text-muted-foreground">
      {m.allowance_used({
  used: numbers.format(overview.usedTokens),
  limit: numbers.format(overview.capTokens),
})}
      {#if cost}
        · {cost}
      {/if}
    </p>
  </div>
</section>
