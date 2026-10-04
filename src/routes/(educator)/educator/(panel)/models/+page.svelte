<script lang="ts">
import { superForm } from "sveltekit-superforms";
import { applyAction, enhance } from "$app/forms";
import { invalidateAll } from "$app/navigation";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * The alias table (PRD §9, §17).
 *
 * The data-protection flag is shown as a badge on every row, not buried in an
 * edit form: §16 asks that the choice be visible wherever aliases appear, and a
 * flag an educator has to open a form to see is not visible.
 *
 * The gateway identifier is editable here and appears nowhere else in the
 * product — students only ever see the friendly name (§9, §21).
 */
let { data, form: actionResult }: PageProps = $props();

/**
 * The refusal that belongs to one row, if the last action produced one.
 *
 * The per-row update and delete forms are plain `use:enhance` — they are not
 * bound to the create form's Superforms instance — so a failure returned for
 * them has nowhere to render unless the row looks for it by id. Without this a
 * rejected save left the typed values in place and said nothing, which reads
 * exactly like a save that worked.
 */
/**
 * Submit a row without emptying it.
 *
 * SvelteKit's default `enhance` calls `form.reset()` on a successful action, and
 * a reset restores every control to its `value` *attribute* — which Svelte never
 * writes for `value={…}`, because it sets the property. So saving a row blanked
 * its name and gateway identifier on screen while the database kept the real
 * values, and `required` then blocked every subsequent save silently: no
 * message, no request, nothing to distinguish it from a save that worked.
 *
 * A row is an editor showing current state, not a blank form to be emptied, so
 * it does not reset. `invalidateAll` re-reads the row from the database, which
 * is what should have been on screen all along.
 */
function submitRow() {
  return async ({ result }: { result: import("$app/forms").ActionResult }) => {
    await applyAction(result);
    if (result.type === "success") await invalidateAll();
  };
}

function rowMessage(aliasId: string): string | null {
  const result = actionResult as { aliasId?: unknown; message?: unknown } | null;
  if (!result || result.aliasId !== aliasId) return null;
  return typeof result.message === "string" ? result.message : null;
}

// Superforms captures the initial page data and then keeps itself in sync by
// subscribing to page updates internally, so the compiler's warning about a
// locally-referenced value does not apply to this API.
// svelte-ignore state_referenced_locally
const {
  form,
  errors,
  enhance: enhanceCreate,
  submitting,
} = superForm(data.form, {
  resetForm: true,
});

const field = "h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground";
const check = "flex items-center gap-2 text-sm text-foreground";
</script>

<svelte:head><title>{m.educator_aliases_title()} · {m.educator_panel_title()}</title></svelte:head>

<div class="flex flex-col gap-8">
  <section class="flex flex-col gap-3">
    <h1 class="text-base font-semibold text-foreground">{m.educator_aliases_title()}</h1>

    <ul class="flex flex-col divide-y divide-border border-y border-border">
      {#each data.aliases as alias (alias.id)}
        {@const refusal = rowMessage(alias.id)}
        <li class="flex flex-col gap-2 py-3">
          {#if refusal}
            <p role="alert" class="text-xs text-destructive">{refusal}</p>
          {/if}
          <form
            method="POST"
            action="?/update"
            use:enhance={submitRow}
            class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
          >
            <input type="hidden" name="aliasId" value={alias.id} />

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">{m.educator_alias_name_label()}</span>
              <input name="name" value={alias.name} class={field} required />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">{m.educator_alias_gateway_label()}</span>
              <input name="gatewayModelId" value={alias.gatewayModelId} class={field} required />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">{m.educator_alias_dialect_label()}</span>
              <select name="dialect" value={alias.dialect} class={field}>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
              </select>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">
                {m.educator_alias_input_price_label()}
              </span>
              <input
                name="inputPricePerMillion"
                inputmode="decimal"
                value={alias.inputPricePerMillion ?? ""}
                class={field}
              />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">
                {m.educator_alias_output_price_label()}
              </span>
              <input
                name="outputPricePerMillion"
                inputmode="decimal"
                value={alias.outputPricePerMillion ?? ""}
                class={field}
              />
            </label>

            <div class="flex items-end gap-2">
              <button
                type="submit"
                class="h-9 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary"
              >
                {m.educator_save()}
              </button>
            </div>

            <div class="flex flex-wrap gap-x-5 gap-y-1.5 sm:col-span-3">
              <label class={check}>
                <input type="checkbox" name="available" checked={alias.available} />
                {m.educator_alias_available_label()}
              </label>
              <label class={check}>
                <input type="checkbox" name="dataProtection" checked={alias.dataProtection} />
                {m.educator_alias_dpa_label()}
              </label>
              <label class={check}>
                <input
                  type="checkbox"
                  name="supportsImageInput"
                  checked={alias.supportsImageInput}
                />
                {m.educator_alias_image_input_label()}
              </label>
              <label class={check}>
                <input
                  type="checkbox"
                  name="supportsImageGeneration"
                  checked={alias.supportsImageGeneration}
                />
                {m.educator_alias_image_generation_label()}
              </label>
              <label class={check}>
                <input type="checkbox" name="isUtility" checked={alias.isUtility} />
                {m.educator_alias_utility_label()}
              </label>
            </div>
          </form>

          <div class="flex items-center gap-3">
            <span
              class="rounded-full px-2 py-0.5 text-[0.6875rem] font-medium"
              class:bg-secondary={alias.dataProtection}
              class:text-secondary-foreground={alias.dataProtection}
              class:bg-destructive={!alias.dataProtection}
              class:text-destructive-foreground={!alias.dataProtection}
            >
              {alias.dataProtection
                ? m.educator_alias_dpa_badge()
                : m.educator_alias_no_dpa_badge()}
            </span>

            <form method="POST" action="?/delete" use:enhance>
              <input type="hidden" name="aliasId" value={alias.id} />
              <button type="submit" class="text-xs text-muted-foreground hover:text-destructive">
                {m.educator_allowlist_disallow()}
              </button>
            </form>
          </div>
        </li>
      {/each}
    </ul>
  </section>

  <section class="flex max-w-lg flex-col gap-3 border-t border-border pt-6">
    <h2 class="text-sm font-medium text-foreground">{m.educator_add_alias()}</h2>

    <form method="POST" action="?/create" use:enhanceCreate class="flex flex-col gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_alias_name_label()}</span>
        <input name="name" bind:value={$form.name} class={field} required />
        <FieldError message={$errors.name} />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_alias_gateway_label()}</span>
        <input name="gatewayModelId" bind:value={$form.gatewayModelId} class={field} required />
        <FieldError message={$errors.gatewayModelId} />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_alias_dialect_label()}</span>
        <select name="dialect" bind:value={$form.dialect} class={field}>
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
        </select>
      </label>

      <div class="flex flex-wrap gap-x-5 gap-y-1.5">
        <label class={check}>
          <input type="checkbox" name="available" bind:checked={$form.available} />
          {m.educator_alias_available_label()}
        </label>
        <label class={check}>
          <input type="checkbox" name="dataProtection" bind:checked={$form.dataProtection} />
          {m.educator_alias_dpa_label()}
        </label>
      </div>

      <button
        type="submit"
        disabled={$submitting}
        class="h-9 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {m.educator_add_alias()}
      </button>
    </form>
  </section>
</div>
