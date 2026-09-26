<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { AliasSchema } from "$lib/server/classroom/schemas";
import { setupFieldError } from "./labels";

/**
 * Step 3 — the first model alias (PRD §9, §10, §16).
 *
 * "Setun maintains its own model alias table — friendly names such as Fast,
 * Balanced, Powerful, mapped to concrete CPA model identifiers… Students only
 * ever see the friendly name."
 *
 * There is no utility-alias control here, and that is deliberate: on a fresh
 * installation there is exactly one alias, so it is the one internal work runs
 * on, and asking the question would be offering a choice with one answer. The
 * note says what the server does.
 *
 * The data-protection flag is a plain checkbox here and carries no
 * confirmation — recording what an alias *is* costs nothing. The §16
 * confirmation belongs to the step that enables it for a class, because that is
 * the decision §16 asks to be made deliberately and per classroom.
 */

type AliasData = v.InferOutput<typeof AliasSchema>;

interface Props {
  data: SuperValidated<AliasData>;
}

let { data }: Props = $props();

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, { id: "setup-alias" });

const field = "h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground";
const check = "flex items-center gap-2 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.setup_alias_title()}</h2>
  <p class="text-sm text-muted-foreground">{m.setup_alias_intro()}</p>

  <form method="POST" action="?/alias" use:enhance class="flex flex-col gap-3">
    {#if setupFieldError($errors._errors)}
      <p class="text-sm text-destructive" role="alert">{setupFieldError($errors._errors)}</p>
    {/if}

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_alias_name_label()}</span>
      <input name="name" type="text" bind:value={$form.name} class={field}>
      <FieldError message={$errors.name} />
    </label>

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_alias_gateway_label()}</span>
      <input name="gatewayModelId" type="text" bind:value={$form.gatewayModelId} class={field}>
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
        <input type="checkbox" name="available" bind:checked={$form.available}>
        {m.educator_alias_available_label()}
      </label>
      <label class={check}>
        <input type="checkbox" name="dataProtection" bind:checked={$form.dataProtection}>
        {m.educator_alias_dpa_label()}
      </label>
      <label class={check}>
        <input type="checkbox" name="supportsImageInput" bind:checked={$form.supportsImageInput}>
        {m.educator_alias_image_input_label()}
      </label>
      <label class={check}>
        <input
          type="checkbox"
          name="supportsImageGeneration"
          bind:checked={$form.supportsImageGeneration}
        >
        {m.educator_alias_image_generation_label()}
      </label>
    </div>

    <p class="text-xs text-muted-foreground">{m.setup_alias_utility_note()}</p>

    <div class="flex flex-wrap gap-2">
      <a
        href="/setup?step=gateway"
        class="flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
      >
        {m.setup_back()}
      </a>
      <button
        type="submit"
        disabled={$submitting}
        class="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {m.setup_alias_submit()}
      </button>
    </div>
  </form>
</section>
