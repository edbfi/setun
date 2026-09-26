<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { SetupClassroomSchema } from "$lib/server/setup/schemas";
import { setupFieldError } from "./labels";

/**
 * Step 4 — the first classroom (PRD §8, §16).
 *
 * Four questions, not thirty. "A classroom is the unit of configuration" and it
 * carries some thirty settings, every one of which has an Appendix A default and
 * a panel page that edits it. What is asked here is only what an educator would
 * regret discovering later: the room's name, its timezone, the language its
 * pupils see, and how long a session lasts.
 *
 * The alias from step 3 is allowlisted for the class as part of saving it — a
 * classroom with no allowlisted model refuses every request, which is correct
 * behaviour and a baffling first lesson.
 *
 * When that alias carries no data processing agreement, §16's confirmation is
 * required rather than implied: "the decision is made deliberately, per
 * classroom, by the person accountable for it". The server refuses the grant
 * without the acknowledgement, so this dialog is not something the client can
 * skip past.
 */

type ClassroomData = v.InferOutput<typeof SetupClassroomSchema>;

interface Props {
  data: SuperValidated<ClassroomData>;
  alias: { name: string; dataProtection: boolean } | null;
}

let { data, alias }: Props = $props();

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, { id: "setup-classroom" });

const field = "h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.setup_classroom_title()}</h2>
  <p class="text-sm text-muted-foreground">{m.setup_classroom_intro()}</p>

  <form method="POST" action="?/classroom" use:enhance class="flex flex-col gap-3">
    {#if setupFieldError($errors._errors)}
      <p class="text-sm text-destructive" role="alert">{setupFieldError($errors._errors)}</p>
    {/if}

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_classroom_name_label()}</span>
      <input name="name" type="text" bind:value={$form.name} class={field}>
      <FieldError message={$errors.name} />
    </label>

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_timezone_label()}</span>
      <input name="timezone" type="text" bind:value={$form.timezone} class={field}>
      <FieldError message={$errors.timezone} />
    </label>

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_language_title()}</span>
      <select name="interfaceLanguage" bind:value={$form.interfaceLanguage} class={field}>
        <option value="da">{m.educator_language_da()}</option>
        <option value="en">{m.educator_language_en()}</option>
      </select>
    </label>

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">
        {m.educator_session_policy_label()}
      </span>
      <select name="sessionPolicy" bind:value={$form.sessionPolicy} class={field}>
        <option value="sliding">{m.educator_session_sliding()}</option>
        <option value="per-lesson">{m.educator_session_per_lesson()}</option>
      </select>
    </label>

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_session_days_label()}</span>
      <input
        name="sessionSlidingDays"
        type="number"
        min="1"
        max="365"
        bind:value={$form.sessionSlidingDays}
        class={field}
      >
      <FieldError message={$errors.sessionSlidingDays} />
    </label>

    {#if alias}
      <p class="text-sm text-muted-foreground">
        {m.setup_classroom_alias_note({ alias: alias.name })}
      </p>

      {#if !alias.dataProtection}
        <div class="flex flex-col gap-2 rounded-md border border-destructive/40 p-4">
          <h3 class="text-sm font-medium text-foreground">
            {m.setup_classroom_no_dpa_title()}
          </h3>
          <p class="text-sm text-muted-foreground">{m.setup_classroom_no_dpa_body()}</p>
          <label class="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="confirmNoDpa"
              bind:checked={$form.confirmNoDpa}
              class="mt-1"
            >
            {m.setup_classroom_no_dpa_confirm()}
          </label>
          {#if setupFieldError($errors.confirmNoDpa)}
            <p class="text-sm text-destructive" role="alert">
              {setupFieldError($errors.confirmNoDpa)}
            </p>
          {/if}
        </div>
      {/if}
    {/if}

    <div class="flex flex-wrap gap-2">
      <a
        href="/setup?step=alias"
        class="flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
      >
        {m.setup_back()}
      </a>
      <button
        type="submit"
        disabled={$submitting}
        class="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {m.setup_classroom_submit()}
      </button>
    </div>
  </form>
</section>
