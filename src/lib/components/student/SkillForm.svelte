<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { SkillSchema } from "$lib/server/classroom/schemas";

/**
 * A pupil writing one skill (PRD §12, §20).
 *
 * The same form writes a new skill and edits an existing one, because §12's
 * lesson is the loop — "writing a skill, observing how the model's behaviour
 * changes, and iterating" — and a separate edit screen breaks the loop into two
 * places.
 *
 * Under pre-approval the notice says so before the pupil presses save, not
 * after: being told afterwards that the work is inactive reads as a failure
 * rather than as the classroom's policy (§12).
 */

type SkillData = v.InferOutput<typeof SkillSchema>;

interface Props {
  data: SuperValidated<SkillData>;
  /** The skill being edited, or null while the form writes a new one. */
  editingId?: string | null;
  /** Set when the classroom requires the educator to approve each version (§12). */
  needsApproval?: boolean;
  oncancel?: () => void;
  onsaved?: () => void;
}

let { data, editingId = null, needsApproval = false, oncancel, onsaved }: Props = $props();

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, {
  id: "skill",
  onResult({ result }) {
    if (result.type === "success") onsaved?.();
  },
});

const field = "rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
</script>

<form method="POST" action="?/save" use:enhance class="flex flex-col gap-3">
  {#if editingId}
    <input type="hidden" name="skillId" value={editingId}>
  {/if}

  <label class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">{m.student_skill_name_label()}</span>
    <input name="name" bind:value={$form.name} class="h-11 {field}">
    <FieldError message={$errors.name} />
  </label>

  <label class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">{m.student_skill_description_label()}</span>
    <input name="description" bind:value={$form.description} class="h-11 {field}">
    <FieldError message={$errors.description} />
  </label>

  <label class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">{m.student_skill_body_label()}</span>
    <textarea name="body" rows="7" bind:value={$form.body} class={field}></textarea>
    <FieldError message={$errors.body} />
  </label>

  <div class="flex gap-2">
    <button
      type="submit"
      disabled={$submitting || !$form.name || !$form.body}
      class="h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
    >
      {m.student_skill_save()}
    </button>
    {#if editingId}
      <button
        type="button"
        onclick={() => oncancel?.()}
        class="h-11 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary"
      >
        {m.student_skill_cancel()}
      </button>
    {/if}
  </div>

  {#if needsApproval}
    <p class="text-xs text-muted-foreground">{m.student_skill_pending_notice()}</p>
  {/if}
</form>
