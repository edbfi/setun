<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";

/**
 * Every skill a pupil in this class has written (PRD §12).
 *
 * "Immediate with oversight (default) — a student's skill works right away, and
 * the panel lists every student skill with view, disable, and delete — or
 * pre-approval required, where new and edited versions sit inactive until the
 * educator approves them."
 *
 * One list serves both policies: under pre-approval the pending rows rise to the
 * top and carry the two approval buttons, and under oversight they simply never
 * appear as pending.
 *
 * The body is rendered as text, never as markup: a pupil wrote it, and §21 puts
 * that in the same category as an upload (§12, §21).
 */

interface StudentSkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  approvalState: "approved" | "pending" | "rejected";
  studentLabel: string;
}

interface Props {
  skills: StudentSkillRow[];
}

let { skills }: Props = $props();

/** Pending first: under pre-approval those are the rows waiting on the educator. */
const ordered = $derived(
  [...skills].sort(
    (a, b) => Number(b.approvalState === "pending") - Number(a.approvalState === "pending"),
  ),
);

let showing = $state<string | null>(null);

const button =
  "h-8 shrink-0 rounded-md border border-input px-3 text-xs font-medium text-foreground hover:bg-secondary";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_student_skills_title()}</h2>

  {#if ordered.length === 0}
    <p class="text-xs text-muted-foreground">{m.educator_student_skills_empty()}</p>
  {/if}

  <ul class="flex flex-col gap-1">
    {#each ordered as skill (skill.id)}
      <li class="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="flex items-center gap-2">
              <span class="truncate text-sm text-foreground">{skill.name}</span>
              <span class="text-xs text-muted-foreground">{skill.studentLabel}</span>
              {#if skill.approvalState === "pending"}
                <span class="rounded bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] text-primary">
                  {m.educator_student_skill_pending()}
                </span>
              {:else if skill.approvalState === "rejected"}
                <span
                  class="rounded bg-destructive/10 px-1.5 py-0.5 text-[0.6875rem] text-destructive"
                >
                  {m.educator_student_skill_rejected()}
                </span>
              {:else if !skill.enabled}
                <span
                  class="rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground"
                >
                  {m.educator_skill_disabled_badge()}
                </span>
              {/if}
            </span>
            <span class="truncate text-xs text-muted-foreground">{skill.description}</span>
          </div>

          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              class={button}
              onclick={() => (showing = showing === skill.id ? null : skill.id)}
            >
              {m.educator_student_skill_view()}
            </button>

            {#if skill.approvalState === "pending"}
              <form method="POST" action="?/setStudentSkillState" use:enhance>
                <input type="hidden" name="skillId" value={skill.id}>
                <input type="hidden" name="approvalState" value="approved">
                <button type="submit" class={button}>{m.educator_student_skill_approve()}</button>
              </form>
              <form method="POST" action="?/setStudentSkillState" use:enhance>
                <input type="hidden" name="skillId" value={skill.id}>
                <input type="hidden" name="approvalState" value="rejected">
                <button type="submit" class={button}>{m.educator_student_skill_reject()}</button>
              </form>
            {:else}
              <form method="POST" action="?/setStudentSkillState" use:enhance>
                <input type="hidden" name="skillId" value={skill.id}>
                <input type="hidden" name="enabled" value={skill.enabled ? "false" : "true"}>
                <button type="submit" class={button}>
                  {skill.enabled ? m.educator_skill_disable() : m.educator_skill_enable()}
                </button>
              </form>
            {/if}
          </div>
        </div>

        {#if showing === skill.id}
          <pre
            class="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-secondary p-2 text-xs text-foreground"
          >{skill.body}</pre>
        {/if}
      </li>
    {/each}
  </ul>
</section>
