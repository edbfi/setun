<script lang="ts">
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { AllowanceStatus } from "$lib/server/classroom/status";

/**
 * The student's own allowance, with the approximate cost (PRD §10, §18).
 *
 * "Students see their own allowance and consumption on the dashboard" and the
 * approximate cost "where prices are configured". Everything here is display:
 * the figures the server enforces are tokens, and a missing price changes
 * nothing about enforcement (§10).
 *
 * A hairline track rather than a percentage badge — this sits above a composer
 * a pupil is trying to type in, and it should be readable at a glance without
 * asking for attention.
 */

interface Props {
  allowance: AllowanceStatus;
  /** Rendered as a compact strip inside the chat chrome, or a block on a page. */
  compact?: boolean;
}

let { allowance, compact = false }: Props = $props();

const numbers = $derived(new Intl.NumberFormat(getLocale()));
const money = $derived(
  new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
);

const fraction = $derived(
  allowance.limitTokens > 0 ? Math.min(1, allowance.usedTokens / allowance.limitTokens) : 0,
);

const cost = $derived(
  allowance.costUsd === null || allowance.costDkk === null
    ? null
    : m.allowance_cost({
        usd: money.format(allowance.costUsd),
        dkk: money.format(allowance.costDkk),
      }),
);
</script>

<div class={compact ? "flex flex-col gap-1" : "flex flex-col gap-2"}>
  <div class="flex items-baseline justify-between gap-3">
    {#if !compact}
      <span class="text-sm font-medium text-foreground">{m.allowance_title()}</span>
    {/if}
    <!-- `min-w-0` first: a flex item defaults to `min-width: auto` and refuses
         to shrink below its own nowrap width, so `truncate` never clips. -->
    <span class="min-w-0 truncate whitespace-nowrap text-xs text-muted-foreground">
      {m.allowance_used({
  used: numbers.format(allowance.usedTokens),
  limit: numbers.format(allowance.limitTokens),
})}
    </span>
  </div>

  <div
    class="h-1 w-full overflow-hidden rounded-full bg-secondary"
    role="progressbar"
    aria-label={m.allowance_title()}
    aria-valuenow={allowance.usedTokens}
    aria-valuemin={0}
    aria-valuemax={allowance.limitTokens}
  >
    <div
      class="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
      class:bg-primary={!allowance.exhausted}
      class:bg-destructive={allowance.exhausted}
      style:width="{fraction * 100}%"
    ></div>
  </div>

  {#if cost || !compact}
    <div class="flex items-baseline justify-between gap-3 text-[0.6875rem] text-muted-foreground">
      <span>{cost ?? ""}</span>
      {#if !compact}
        <span>{m.allowance_resets()}</span>
      {/if}
    </div>
  {/if}
</div>
