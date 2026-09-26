<script lang="ts">
import { superForm } from "sveltekit-superforms";
import DashboardRow from "$lib/components/educator/DashboardRow.svelte";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * The panel's dashboard (PRD §9, §17).
 *
 * Rooms first, in the order a lesson needs them — open ones at the top — then
 * the gateway line, then the form that makes a new room. An educator arriving
 * mid-lesson should not have to scroll past a form to reach the lock.
 */
let { data }: PageProps = $props();

// Superforms captures the initial page data and then keeps itself in sync by
// subscribing to page updates internally, so the compiler's warning about a
// locally-referenced value does not apply to this API.
// svelte-ignore state_referenced_locally
const { form, errors, enhance: formEnhance, submitting } = superForm(data.form);
</script>

<svelte:head><title>{m.educator_panel_title()} · {m.app_name()}</title></svelte:head>

<div class="flex max-w-3xl flex-col gap-8">
  <section class="flex flex-col gap-3">
    <h1 class="text-base font-semibold text-foreground">{m.educator_dashboard_title()}</h1>

    {#if data.dashboard.length === 0}
      <p class="text-xs text-muted-foreground">{m.educator_no_classrooms()}</p>
    {:else}
      <ul class="flex flex-col gap-2">
        {#each data.dashboard as overview (overview.id)}
          <li><DashboardRow {overview} /></li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="flex flex-col gap-1.5 border-t border-border pt-6">
    <h2 class="text-sm font-medium text-foreground">{m.educator_gateway_health_title()}</h2>
    <p
      class="text-sm"
      class:text-muted-foreground={data.gateway.reachable}
      class:text-destructive={!data.gateway.reachable}
    >
      {#if data.gateway.reachable}
        {m.educator_gateway_reachable({ count: data.gateway.modelCount })}
      {:else}
        {m.educator_gateway_unreachable()}
      {/if}
    </p>
  </section>

  <section class="flex max-w-lg flex-col gap-3 border-t border-border pt-6">
    <h2 class="text-sm font-medium text-foreground">{m.educator_create_classroom()}</h2>

    <form method="POST" action="?/create" use:formEnhance class="flex flex-col gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_classroom_name_label()}</span>
        <input
          name="name"
          bind:value={$form.name}
          required
          class="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
        >
        <FieldError message={$errors.name} />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_timezone_label()}</span>
        <input
          name="timezone"
          bind:value={$form.timezone}
          class="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
        >
        <FieldError message={$errors.timezone} />
      </label>

      <button
        type="submit"
        disabled={$submitting}
        class="h-9 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {m.educator_create_classroom()}
      </button>
    </form>
  </section>
</div>
