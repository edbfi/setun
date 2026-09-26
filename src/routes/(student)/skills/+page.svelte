<script lang="ts">
import { enhance as formEnhance } from "$app/forms";
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import SkillForm from "$lib/components/student/SkillForm.svelte";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * A pupil's own skills (PRD §12, §20).
 *
 * "Writing a skill, observing how the model's behaviour changes, and iterating
 * is among the better available lessons in how these systems work." So the page
 * is a writing surface first: one form at the top, the pupil's own skills below
 * it, and editing loads a skill back into the same form rather than opening a
 * second one — the loop is write, try, change.
 *
 * Under pre-approval each saved version says plainly that it is waiting. The
 * form is hidden where the classroom has switched authoring off, and the server
 * refuses regardless — hiding a control is never access control (§8, §21).
 */
let { data }: PageProps = $props();

/** The skill being edited, or null while the form writes a new one. */
let editing = $state<string | null>(null);

/**
 * Load a skill back into the form.
 *
 * The form is remounted on the key below, so it takes these as its initial
 * values rather than needing to be told to update them.
 */
let seed = $state<{ name: string; description: string; body: string } | null>(null);

function edit(skill: { id: string; name: string; description: string; body: string }) {
  editing = skill.id;
  seed = { name: skill.name, description: skill.description, body: skill.body };
}

function cancel() {
  editing = null;
  seed = null;
}

/** The form's starting values: a skill being edited, or an empty draft. */
const formData = $derived(seed ? { ...data.form, data: seed } : data.form);

const button =
  "h-9 rounded-md border border-input px-3 text-xs font-medium text-foreground hover:bg-secondary";
</script>

<svelte:head><title>{m.student_skills_title()} · {m.app_name()}</title></svelte:head>

<div class="flex min-h-svh flex-col bg-background">
  <header class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
    <div class="flex min-w-0 items-center gap-2">
      <SetunMark size={20} class="shrink-0 text-primary" />
      <span class="truncate text-sm font-medium text-foreground">{m.student_skills_title()}</span>
    </div>
    <a href="/chat" class="shrink-0 text-xs text-muted-foreground hover:text-foreground">
      {m.student_skill_back()}
    </a>
  </header>

  <div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-3">
    <p class="text-sm text-muted-foreground">{m.student_skills_intro()}</p>

    {#if data.policy === "disabled"}
      <p class="rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
        {m.student_skills_disabled_notice()}
      </p>
    {:else}
      {#key editing}
        <SkillForm
          data={formData}
          editingId={editing}
          needsApproval={data.policy === "pre-approval"}
          oncancel={cancel}
          onsaved={cancel}
        />
      {/key}
    {/if}

    <section class="flex flex-col gap-2">
      {#if data.skills.length === 0}
        <p class="text-sm text-muted-foreground">{m.student_skills_empty()}</p>
      {/if}

      <ul class="flex flex-col gap-2">
        {#each data.skills as skill (skill.id)}
          <li class="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="truncate text-sm font-medium text-foreground">{skill.name}</span>
                <span class="truncate text-xs text-muted-foreground">{skill.description}</span>
              </div>
              <span class="shrink-0 text-xs">
                {#if skill.approvalState === "pending"}
                  <span class="text-primary">{m.student_skill_pending_notice()}</span>
                {:else if skill.approvalState === "rejected"}
                  <span class="text-destructive">{m.student_skill_rejected_notice()}</span>
                {:else}
                  <span class="text-muted-foreground">
                    {skill.enabled ? m.student_skill_on() : m.student_skill_off()}
                  </span>
                {/if}
              </span>
            </div>

            {#if data.policy !== "disabled"}
              <div class="flex flex-wrap gap-2">
                <button type="button" class={button} onclick={() => edit(skill)}>
                  {m.student_skill_edit()}
                </button>

                <form method="POST" action="?/setEnabled" use:formEnhance>
                  <input type="hidden" name="skillId" value={skill.id}>
                  <input type="hidden" name="enabled" value={skill.enabled ? "false" : "true"}>
                  <button type="submit" class={button}>
                    {skill.enabled ? m.student_skill_off() : m.student_skill_on()}
                  </button>
                </form>

                <form method="POST" action="?/delete" use:formEnhance>
                  <input type="hidden" name="skillId" value={skill.id}>
                  <button
                    type="submit"
                    class="h-9 rounded-md border border-destructive px-3 text-xs font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground"
                  >
                    {m.student_skill_delete()}
                  </button>
                </form>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  </div>
</div>
