<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";

/**
 * Offering library skills to a class, or to one pupil (PRD §12).
 *
 * "Enablement is per classroom and per student — a skill can be offered to a
 * whole class or to individual students." Both live on one row here, because an
 * educator deciding between them is making one decision, not two.
 *
 * A skill switched off in the library is shown greyed rather than hidden: it is
 * the same list an educator just came from, and a missing row reads as a bug.
 */

interface SkillRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  classWide: boolean;
  studentIds: string[];
}

interface StudentRow {
  id: string;
  label: string;
}

interface Props {
  skills: SkillRow[];
  students: StudentRow[];
}

let { skills, students }: Props = $props();

/** Which pupil the per-pupil offer targets, per skill row. */
let targets = $state<Record<string, string>>({});

const button =
  "h-8 shrink-0 rounded-md border border-input px-3 text-xs font-medium text-foreground hover:bg-secondary";
const field = "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_skill_grants_title()}</h2>

  {#if skills.length === 0}
    <p class="text-xs text-muted-foreground">{m.educator_skill_library_empty()}</p>
  {/if}

  <ul class="flex flex-col gap-1">
    {#each skills as skill (skill.id)}
      <li class="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="flex items-center gap-2">
              <span class="truncate text-sm text-foreground">{skill.name}</span>
              {#if !skill.enabled}
                <span
                  class="rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground"
                >
                  {m.educator_skill_disabled_badge()}
                </span>
              {/if}
            </span>
            <span class="truncate text-xs text-muted-foreground">{skill.description}</span>
          </div>

          <form
            method="POST"
            action={skill.classWide ? "?/revokeSkill" : "?/grantSkill"}
            use:enhance
          >
            <input type="hidden" name="skillId" value={skill.id}>
            <button
              type="submit"
              disabled={!skill.enabled}
              class={[
  button,
  { "bg-primary text-primary-foreground hover:bg-primary/90": skill.classWide },
  "disabled:opacity-50",
]}
            >
              {skill.classWide ? m.educator_skill_grant_remove() : m.educator_skill_grant_class()}
            </button>
          </form>
        </div>

        {#if students.length > 0}
          <div class="flex flex-wrap items-center gap-2">
            <form method="POST" action="?/grantSkill" use:enhance class="flex items-center gap-2">
              <input type="hidden" name="skillId" value={skill.id}>
              <label class="sr-only" for="grant-{skill.id}">
                {m.educator_skill_grant_student_label()}
              </label>
              <select
                id="grant-{skill.id}"
                name="studentId"
                bind:value={targets[skill.id]}
                class={field}
              >
                {#each students as student (student.id)}
                  <option value={student.id}>{student.label}</option>
                {/each}
              </select>
              <button type="submit" disabled={!skill.enabled} class="{button} disabled:opacity-50">
                {m.educator_skill_grant_add()}
              </button>
            </form>

            {#each skill.studentIds as studentId (studentId)}
              <form method="POST" action="?/revokeSkill" use:enhance>
                <input type="hidden" name="skillId" value={skill.id}>
                <input type="hidden" name="studentId" value={studentId}>
                <button type="submit" class="{button} border-primary text-primary">
                  {students.find((student) => student.id === studentId)?.label ?? studentId}
                  <span aria-hidden="true"> ×</span>
                  <span class="sr-only">{m.educator_skill_grant_remove()}</span>
                </button>
              </form>
            {/each}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</section>
