<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import { enhance as formEnhance } from "$app/forms";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { ClassroomPolicySchema } from "$lib/server/classroom/schemas";

/**
 * Instructions, language and session policy (PRD §7, §8, §10).
 *
 * The classroom instructions field is the educator's steering instrument — "the
 * educator's instruments are the layered system prompt, the model allowlist, and
 * classroom availability — steering, not surveillance" (§16). It says plainly
 * that pupils never see it, because an educator writing here should know which
 * of the two it is.
 *
 * Force-logout is a separate form: it takes effect immediately and has nothing
 * to save alongside it (§7, §21).
 */

type PolicyData = v.InferOutput<typeof ClassroomPolicySchema>;

interface Props {
  data: SuperValidated<PolicyData>;
  forceLoggedOut?: number | null;
}

let { data, forceLoggedOut = null }: Props = $props();

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, {
  id: "policy",
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

const field = "rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_instructions_title()}</h2>

  <form method="POST" action="?/savePolicy" use:enhance class="flex flex-col gap-4">
    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">
        {m.educator_classroom_instructions_label()}
      </span>
      <textarea
        name="classroomInstructions"
        rows="5"
        bind:value={$form.classroomInstructions}
        class={field}
      ></textarea>
      <span class="text-xs text-muted-foreground">
        {m.educator_classroom_instructions_help()}
      </span>
      <FieldError message={$errors.classroomInstructions} />
    </label>

    <div class="grid gap-3 sm:grid-cols-2">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_interface_language_label()}</span>
        <select name="interfaceLanguage" bind:value={$form.interfaceLanguage} class="h-9 {field}">
          <option value="da">{m.educator_language_da()}</option>
          <option value="en">{m.educator_language_en()}</option>
        </select>
      </label>

      <!--
        Whether pupils may watch the model reason (§20).
        `student` is the default and leaves it to the pupil's own device
        setting; the other two decide for the class, and `hidden` is enforced
        server-side rather than by hiding a control (§21).
      -->
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">
          {m.educator_thinking_visibility_label()}
        </span>
        <select name="thinkingVisibility" bind:value={$form.thinkingVisibility} class="h-9 {field}">
          <option value="student">{m.educator_thinking_student()}</option>
          <option value="shown">{m.educator_thinking_shown()}</option>
          <option value="hidden">{m.educator_thinking_hidden()}</option>
        </select>
        <span class="text-xs text-muted-foreground">{m.educator_thinking_visibility_help()}</span>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_session_policy_label()}</span>
        <select name="sessionPolicy" bind:value={$form.sessionPolicy} class="h-9 {field}">
          <option value="sliding">{m.educator_session_sliding()}</option>
          <option value="per-lesson">{m.educator_session_per_lesson()}</option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_session_days_label()}</span>
        <input
          name="sessionSlidingDays"
          type="number"
          bind:value={$form.sessionSlidingDays}
          class="h-9 {field}"
        >
        <FieldError message={$errors.sessionSlidingDays} />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_retention_days_label()}</span>
        <input
          name="conversationRetentionDays"
          type="number"
          bind:value={$form.conversationRetentionDays}
          class="h-9 {field}"
        >
        <FieldError message={$errors.conversationRetentionDays} />
      </label>

      <!--
        Creations are a portfolio and outlive the conversations that produced
        them (§16), so this one may be absent altogether: an empty field keeps
        them until the pupil deletes them, which is the default. Without a
        control the column existed and no educator could reach it.
      -->
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">
          {m.educator_creation_retention_label()}
        </span>
        <input
          name="creationRetentionDays"
          type="number"
          bind:value={$form.creationRetentionDays}
          class="h-9 {field}"
        >
        <span class="text-xs text-muted-foreground">{m.educator_creation_retention_hint()}</span>
        <FieldError message={$errors.creationRetentionDays} />
      </label>
    </div>

    <button
      type="submit"
      disabled={$submitting}
      class="h-9 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
    >
      {m.educator_save()}
    </button>
  </form>
</section>

<section class="flex flex-col gap-2">
  <h2 class="text-sm font-medium text-foreground">{m.educator_sessions_title()}</h2>

  <form method="POST" action="?/forceLogout" use:formEnhance class="flex items-center gap-3">
    <button
      type="submit"
      class="h-9 rounded-md border border-destructive px-3 text-sm font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground"
    >
      {m.educator_force_logout()}
    </button>
    {#if forceLoggedOut !== null}
      <span class="text-xs text-muted-foreground" role="status">
        {m.educator_force_logout_done({ count: forceLoggedOut })}
      </span>
    {/if}
  </form>
</section>
