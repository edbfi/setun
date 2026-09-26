<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { ScheduleSchema } from "$lib/server/classroom/schemas";

/**
 * The weekly schedule (PRD §8, §17).
 *
 * Times are edited as `<input type="time">` and stored as minutes from local
 * midnight — the shape schedule resolution works in, so nothing downstream ever
 * parses a clock string and nothing is tempted into offset arithmetic (§5).
 *
 * `dataType: "json"` because the form is an array; Superforms serialises it, and
 * the schema validates each window server-side regardless of what the client
 * sent (§5).
 */

type ScheduleData = v.InferOutput<typeof ScheduleSchema>;

interface Props {
  data: SuperValidated<ScheduleData>;
}

let { data }: Props = $props();

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, {
  dataType: "json",
  id: "schedule",
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

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Weekday names come from messages; the array is order, not text. */
const weekdayName = (weekday: number) =>
  [
    m.educator_weekday_0,
    m.educator_weekday_1,
    m.educator_weekday_2,
    m.educator_weekday_3,
    m.educator_weekday_4,
    m.educator_weekday_5,
    m.educator_weekday_6,
  ][weekday]();

const pad = (value: number) => String(value).padStart(2, "0");

/** Minutes from local midnight to the `HH:MM` an input wants, and back. */
function toClock(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function toMinutes(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function addWindow(): void {
  $form.weeklySchedule = [
    ...$form.weeklySchedule,
    { weekday: 1, startMinute: 8 * 60, endMinute: 9 * 60 },
  ];
}

function removeWindow(index: number): void {
  $form.weeklySchedule = $form.weeklySchedule.filter((_, position) => position !== index);
}

const field = "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_schedule_title()}</h2>

  <form method="POST" action="?/saveSchedule" use:enhance class="flex flex-col gap-2">
    {#each $form.weeklySchedule as window, index (index)}
      <div class="flex flex-wrap items-end gap-2">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_weekday_label()}</span>
          <select bind:value={window.weekday} class={field}>
            {#each WEEKDAYS as weekday (weekday)}
              <option value={weekday}>{weekdayName(weekday)}</option>
            {/each}
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_start_label()}</span>
          <input
            type="time"
            class={field}
            value={toClock(window.startMinute)}
            onchange={(event) => {
  window.startMinute = toMinutes(event.currentTarget.value);
}}
          >
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_end_label()}</span>
          <input
            type="time"
            class={field}
            value={toClock(window.endMinute)}
            onchange={(event) => {
  window.endMinute = toMinutes(event.currentTarget.value);
}}
          >
        </label>

        <button
          type="button"
          onclick={() => removeWindow(index)}
          class="h-9 px-2 text-xs text-muted-foreground hover:text-destructive"
        >
          {m.educator_remove_window()}
        </button>
      </div>
    {:else}
      <p class="text-xs text-muted-foreground">{m.educator_schedule_empty()}</p>
    {/each}

    {#if $errors.weeklySchedule?._errors}
      <FieldError message={$errors.weeklySchedule._errors} />
    {/if}

    <div class="flex gap-2 pt-1">
      <button
        type="button"
        onclick={addWindow}
        class="h-9 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary"
      >
        {m.educator_add_window()}
      </button>
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
