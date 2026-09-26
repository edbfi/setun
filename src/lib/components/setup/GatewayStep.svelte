<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";
import type { GatewayHealth } from "$lib/server/gateway/health";

/**
 * Step 2 — is the gateway answering? (PRD §9, §21.)
 *
 * Two facts and no third: reachable or not, and how many models it offers. No
 * status code, no upstream URL, no provider name — §9 keeps all of that out of
 * the browser, and an educator cannot act on any of it anyway.
 *
 * The step persists nothing, so it has no "done" state to derive. What it has
 * instead is an explicit choice: check again, or carry on knowing that pupils
 * cannot chat until the gateway answers. The server records that choice.
 */

interface Props {
  health: GatewayHealth | null;
}

let { health }: Props = $props();
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.setup_gateway_title()}</h2>
  <p class="text-sm text-muted-foreground">{m.setup_gateway_intro()}</p>

  {#if health?.reachable}
    <p class="rounded-md border border-border bg-secondary/40 p-3 text-sm text-foreground">
      {m.educator_gateway_reachable({ count: health.modelCount })}
    </p>
    <p class="text-sm text-muted-foreground">{m.setup_gateway_ok_note()}</p>
  {:else}
    <p class="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
      {m.educator_gateway_unreachable()}
    </p>
    <p class="text-sm text-muted-foreground">{m.setup_gateway_fail_note()}</p>
  {/if}

  <div class="flex flex-wrap gap-2">
    <a
      href="/setup?step=gateway"
      class="flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
    >
      {m.setup_gateway_retry()}
    </a>

    <form method="POST" action="?/gateway" use:enhance>
      <input type="hidden" name="acknowledged" value="true">
      <button
        type="submit"
        class="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {health?.reachable ? m.setup_continue() : m.setup_gateway_continue()}
      </button>
    </form>
  </div>
</section>
