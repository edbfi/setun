<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { TemporaryWindowsSchema } from "$lib/server/classroom/schemas";

/**
 * One-off windows, "for homework or a substituted lesson" (PRD §8).
 *
 * Absolute instants rather than a local recurrence, matching how they are
 * stored: a one-off is pinned to a date, so no DST re-interpretation applies to
 * it and none should be invented here (§5, §8).
 *
 * `datetime-local` gives the browser's own picker, whose value is wall-clock in
 * the *device's* zone. That is what an educator sitting at that device means
 * when they type a time, and the conversion to an instant is the platform's
 * `Date` doing it — not arithmetic of ours.
 */

type TemporaryData = v.InferOutput<typeof TemporaryWindowsSchema>;

interface Props {
  data: SuperValidated<TemporaryData>;
}

let { data }: Props = $props();

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, {
  dataType: "json",
  id: "temporary",
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

const pad = (value: number) => String(value).padStart(2, "0");

/** An epoch instant as the local wall-clock string `datetime-local` expects. */
function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function toEpoch(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function addWindow(): void {
  const hour = 60 * 60 * 1000;
  const start = Math.round(Date.now() / hour) * hour;
  $form.temporaryWindows = [
    ...$form.temporaryWindows,
    { startsAt: start, endsAt: start + hour, note: "" },
  ];
}

function removeWindow(index: number): void {
  $form.temporaryWindows = $form.temporaryWindows.filter((_, position) => position !== index);
}

const field = "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_temporary_title()}</h2>

  <form method="POST" action="?/saveTemporaryWindows" use:enhance class="flex flex-col gap-2">
    {#each $form.temporaryWindows as window, index (index)}
      <div class="flex flex-wrap items-end gap-2">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_start_label()}</span>
          <input
            type="datetime-local"
            class={field}
            value={toLocalInput(window.startsAt)}
            onchange={(event) => {
  window.startsAt = toEpoch(event.currentTarget.value);
}}
          >
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_end_label()}</span>
          <input
            type="datetime-local"
            class={field}
            value={toLocalInput(window.endsAt)}
            onchange={(event) => {
  window.endsAt = toEpoch(event.currentTarget.value);
}}
          >
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_temporary_note_label()}</span>
          <input type="text" class={field} bind:value={window.note}>
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
      <p class="text-xs text-muted-foreground">{m.educator_temporary_empty()}</p>
    {/each}

    {#if $errors.temporaryWindows?._errors}
      <FieldError message={$errors.temporaryWindows._errors} />
    {/if}

    <div class="flex gap-2 pt-1">
      <button
        type="button"
        onclick={addWindow}
        class="h-9 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary"
      >
        {m.educator_add_temporary()}
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
