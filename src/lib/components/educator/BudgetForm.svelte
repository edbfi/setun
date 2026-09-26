<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import { enhance as formEnhance } from "$app/forms";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { BudgetsSchema } from "$lib/server/classroom/schemas";

/**
 * The three budget layers and the presets that fill them (PRD §10, Appendix A).
 *
 * "Selecting a preset fills all five fields; fields remain individually editable
 * afterwards." So a preset is a submit that writes values and reloads — not a
 * mode the classroom is left in, and not a client-side fill that could disagree
 * with what the server stored.
 *
 * Figures are tokens throughout, because tokens are what the gateway reports and
 * what enforcement is denominated in. The exchange rate sits here too: it is the
 * only display-only number on this form, and it belongs next to what it prices
 * (§10).
 */

type BudgetsData = v.InferOutput<typeof BudgetsSchema>;

interface Props {
  data: SuperValidated<BudgetsData>;
  /**
   * The preset the classroom's budgets currently match, or null for a custom
   * mix. Derived server-side (a preset is never a stored mode), so the picker
   * shows the real state instead of always defaulting to the first option.
   */
  activePreset?: "cautious" | "standard" | "generous" | null;
}

let { data, activePreset = null }: Props = $props();

// The picker's own selection. Seeded from the current budgets so it reflects
// reality on load; "custom" when the values match no preset. The seed is the
// initial prop by design — the page reloads on save, remounting with the fresh
// value — so the "referenced locally" note does not apply.
// svelte-ignore state_referenced_locally
let selectedPreset = $state<string>(activePreset ?? "custom");

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, {
  id: "budgets",
  /**
   * An edit form, so it must not reset (PRD §8).
   *
   * Superforms resets to the data it was initialised with after a successful
   * submit unless told otherwise, which on a settings form means the teacher
   * types a new value, presses Save, and watches the field snap back to the old
   * one. The write had in fact succeeded; only the screen disagreed, and the
   * natural reading is that saving does not work.
   */
  resetForm: false,
});

const PRESETS = [
  { value: "cautious", label: m.educator_preset_cautious },
  { value: "standard", label: m.educator_preset_standard },
  { value: "generous", label: m.educator_preset_generous },
] as const;

const field = "h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_budgets_title()}</h2>

  <form method="POST" action="?/applyPreset" use:formEnhance class="flex flex-wrap items-end gap-2">
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_preset_label()}</span>
      <select name="preset" bind:value={selectedPreset} class={field}>
        <!--
          "Custom" is shown, never submitted: it is disabled, so a teacher whose
          budgets match no preset cannot re-apply "custom" over their values. The
          three presets remain the only submittable options.
        -->
        {#if selectedPreset === "custom"}
          <option value="custom" disabled>{m.educator_preset_custom()}</option>
        {/if}
        {#each PRESETS as preset (preset.value)}
          <option value={preset.value}>{preset.label()}</option>
        {/each}
      </select>
    </label>
    <button
      type="submit"
      disabled={selectedPreset === "custom"}
      class="h-9 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {m.educator_apply_preset()}
    </button>
  </form>

  <form method="POST" action="?/saveBudgets" use:enhance class="flex flex-col gap-4">
    <!--
      The two layers say different things, so they are two fieldsets rather than
      one grid of five numbers. The first three pause and ask; the last two are
      firm. A teacher who cannot tell them apart cannot set either well (§10).
    -->
    <fieldset class="flex flex-col gap-2">
      <legend class="text-xs font-medium text-foreground">
        {m.educator_budget_checkpoints_title()}
      </legend>
      <p class="text-xs text-muted-foreground">{m.educator_budget_checkpoints_help()}</p>

      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_per_turn_steps_label()}</span>
          <input
            name="perTurnStepCap"
            type="number"
            bind:value={$form.perTurnStepCap}
            class={field}
          >
          <FieldError message={$errors.perTurnStepCap} />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_per_turn_seconds_label()}</span>
          <input
            name="perTurnWallClockSeconds"
            type="number"
            bind:value={$form.perTurnWallClockSeconds}
            class={field}
          >
          <FieldError message={$errors.perTurnWallClockSeconds} />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_per_turn_tokens_label()}</span>
          <input
            name="perTurnTokenCap"
            type="number"
            bind:value={$form.perTurnTokenCap}
            class={field}
          >
          <FieldError message={$errors.perTurnTokenCap} />
        </label>
      </div>
    </fieldset>

    <fieldset class="flex flex-col gap-2">
      <legend class="text-xs font-medium text-foreground">
        {m.educator_budget_daily_title()}
      </legend>
      <p class="text-xs text-muted-foreground">{m.educator_budget_daily_help()}</p>

      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_student_daily_label()}</span>
          <input
            name="perStudentDailyTokens"
            type="number"
            bind:value={$form.perStudentDailyTokens}
            class={field}
          >
          <FieldError message={$errors.perStudentDailyTokens} />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_classroom_daily_label()}</span>
          <input
            name="perClassroomDailyTokens"
            type="number"
            bind:value={$form.perClassroomDailyTokens}
            class={field}
          >
          <FieldError message={$errors.perClassroomDailyTokens} />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_exchange_rate_label()}</span>
          <input
            name="costExchangeRate"
            type="number"
            step="0.01"
            bind:value={$form.costExchangeRate}
            class={field}
          >
          <FieldError message={$errors.costExchangeRate} />
        </label>
      </div>
    </fieldset>

    <div>
      <button
        type="submit"
        disabled={$submitting}
        class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {m.educator_save()}
      </button>
    </div>
  </form>
</section>
