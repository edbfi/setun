<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { RosterEntry } from "$lib/server/classroom/roster";

/**
 * Per-student instructions (PRD §10, §16, §17).
 *
 * The roster shows a pupil's pseudonymous label, their state, and the one field
 * an educator authors for them. It deliberately shows nothing they wrote:
 * "educators have no interface for reading student conversations — the pilot
 * deliberately omits one" (§16).
 *
 * The instructions layer refines the classroom layer rather than replacing it,
 * which is why this is a per-pupil field rather than a per-pupil override of the
 * classroom text (§10).
 */

interface Props {
  students: RosterEntry[];
}

let { students }: Props = $props();

const numbers = $derived(new Intl.NumberFormat(getLocale()));
const money = $derived(
  new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
);

/** Display only; enforcement is in tokens and never reads a price (§10). */
function costOf(student: RosterEntry): string | null {
  if (student.costUsd === null || student.costDkk === null) return null;
  return m.allowance_cost({
    usd: money.format(student.costUsd),
    dkk: money.format(student.costDkk),
  });
}
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_roster_title()}</h2>

  {#if students.length === 0}
    <p class="text-xs text-muted-foreground">{m.educator_roster_empty()}</p>
  {:else}
    <ul class="flex flex-col divide-y divide-border border-y border-border">
      {#each students as student (student.id)}
        <li class="py-3">
          <form
            method="POST"
            action="?/saveStudentInstructions"
            use:enhance
            class="flex flex-col gap-1.5"
          >
            <input type="hidden" name="studentId" value={student.id}>

            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span class="text-sm font-medium text-foreground">{student.label}</span>
              {#if student.status === "disabled"}
                <span
                  class="rounded-full bg-secondary px-2 py-0.5 text-[0.6875rem] text-secondary-foreground"
                >
                  {student.status}
                </span>
              {/if}

              <!-- Usage against the allowance, with the approximate cost (§17). -->
              <span
                class="text-xs"
                class:text-destructive={student.exhausted}
                class:text-muted-foreground={!student.exhausted}
              >
                {m.allowance_used({
  used: numbers.format(student.usedTokens),
  limit: numbers.format(student.limitTokens),
})}
              </span>
              {#if costOf(student)}
                <span class="text-[0.6875rem] text-muted-foreground">{costOf(student)}</span>
              {/if}
            </div>

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">
                {m.educator_student_instructions_label({ label: student.label })}
              </span>
              <textarea
                name="instructions"
                rows="2"
                value={student.instructions ?? ""}
                class="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              ></textarea>
            </label>

            <button
              type="submit"
              class="h-8 self-start rounded-md border border-input px-3 text-xs font-medium text-foreground hover:bg-secondary"
            >
              {m.educator_save()}
            </button>
          </form>
        </li>
      {/each}
    </ul>
  {/if}
</section>
