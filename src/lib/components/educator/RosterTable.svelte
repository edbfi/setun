<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { RosterEntry } from "$lib/server/classroom/roster";

/**
 * The roster (PRD §16, §17).
 *
 * "Per-student status, usage and allowance (with cost estimate), last activity,
 * per-student instructions and attachment overrides, with disable, enable,
 * rotate credential, clear display name, remove, and delete actions."
 *
 * And, as firmly, what it does not carry: nothing a pupil wrote. "Educators have
 * no interface for reading student conversations — the pilot deliberately omits
 * one" (§16). Every column here is account state, a counter, or the educator's
 * own text.
 *
 * The three destructive actions read differently on purpose, because §16 asks
 * the panel to distinguish them: disabling is a toggle, removal takes a pupil
 * off the roster with their work kept, and deletion asks for the label back.
 *
 * Trivial forms, so plain progressively-enhanced actions rather than Superforms
 * (§5) — they work with JavaScript off, which matters on a school machine.
 */

interface Props {
  students: RosterEntry[];
  /** Set when the delete confirmation did not match; the row reopens with a notice. */
  confirmMismatch?: string | null;
}

let { students, confirmMismatch = null }: Props = $props();

let deleteConfirmations = $state<Record<string, string>>({});

const numbers = $derived(new Intl.NumberFormat(getLocale()));
const money = $derived(
  new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
);
const moment = $derived(
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }),
);

/** Display only; enforcement is in tokens and never reads a price (§10). */
function costOf(student: RosterEntry): string | null {
  if (student.costUsd === null || student.costDkk === null) return null;
  return m.allowance_cost({
    usd: money.format(student.costUsd),
    dkk: money.format(student.costDkk),
  });
}

function statusLabel(status: RosterEntry["status"]): string {
  if (status === "disabled") return m.educator_status_disabled();
  if (status === "removed") return m.educator_status_removed();
  return m.educator_status_active();
}

function attachmentValue(student: RosterEntry): "on" | "off" | "inherit" {
  if (student.attachmentsOverride === null) return "inherit";
  return student.attachmentsOverride ? "on" : "off";
}

const smallButton =
  "h-8 rounded-md border border-input px-2.5 text-xs font-medium text-foreground hover:bg-secondary";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_roster_title()}</h2>

  {#if students.length === 0}
    <p class="text-xs text-muted-foreground">{m.educator_roster_empty()}</p>
  {:else}
    <ul class="flex flex-col divide-y divide-border border-y border-border">
      {#each students as student (student.id)}
        <li class="flex flex-col gap-2 py-3" class:opacity-60={student.status === "removed"}>
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="text-sm font-medium text-foreground">{student.label}</span>

            {#if student.displayName}
              <span class="text-xs text-muted-foreground">“{student.displayName}”</span>
            {/if}

            {#if student.status !== "active"}
              <span
                class="rounded-full bg-secondary px-2 py-0.5 text-[0.6875rem] text-secondary-foreground"
              >
                {statusLabel(student.status)}
              </span>
            {/if}

            <span
              class="text-xs tabular-nums"
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

            <span class="text-[0.6875rem] text-muted-foreground">
              {#if student.lastActivityAt}
                {m.educator_last_activity({ when: moment.format(student.lastActivityAt) })}
              {:else}
                {m.educator_last_activity_never()}
              {/if}
            </span>

            <span class="text-[0.6875rem] text-muted-foreground">
              {m.educator_card_hint({ hint: student.credentialHint })}
            </span>
          </div>

          <!-- Per-student instructions: the educator's text, layered after the class's (§10). -->
          <form method="POST" action="?/saveInstructions" use:enhance class="flex flex-col gap-1">
            <input type="hidden" name="studentId" value={student.id}>
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
            <button type="submit" class="{smallButton} self-start">{m.educator_save()}</button>
          </form>

          <div class="flex flex-wrap items-end gap-2">
            <!-- Attachment override; inherit hands the decision back to the class (§10). -->
            <form
              method="POST"
              action="?/setAttachments"
              use:enhance
              class="flex items-end gap-1.5"
            >
              <input type="hidden" name="studentId" value={student.id}>
              <label class="flex flex-col gap-1">
                <span class="text-[0.6875rem] text-muted-foreground">
                  {m.educator_attachments_override_label()}
                </span>
                <select
                  name="attachments"
                  value={attachmentValue(student)}
                  class="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                >
                  <option value="inherit">
                    {m.educator_attachments_inherit({
  state: student.attachmentsEffective ? m.educator_attachments_on() : m.educator_attachments_off(),
})}
                  </option>
                  <option value="on">{m.educator_attachments_on()}</option>
                  <option value="off">{m.educator_attachments_off()}</option>
                </select>
              </label>
              <button type="submit" class={smallButton}>{m.educator_save()}</button>
            </form>

            <form method="POST" action="?/rotate" use:enhance class="flex max-w-xs flex-col gap-1">
              <input type="hidden" name="studentId" value={student.id}>
              <button
                type="submit"
                onclick={(event) => {
  if (!window.confirm(m.educator_slip_rotate_confirm({ label: student.label }))) {
    event.preventDefault();
  }
}}
                class={smallButton}
              >
                {m.educator_slip_create()}
              </button>
              {#if student.status !== "active"}
                <span class="text-[0.6875rem] text-muted-foreground">
                  {m.educator_slip_inactive()}
                </span>
              {/if}
            </form>

            {#if student.displayName}
              <form method="POST" action="?/clearDisplayName" use:enhance>
                <input type="hidden" name="studentId" value={student.id}>
                <button type="submit" class={smallButton}>
                  {m.educator_clear_display_name()}
                </button>
              </form>
            {/if}

            <form method="POST" action="?/setStatus" use:enhance>
              <input type="hidden" name="studentId" value={student.id}>
              <input
                type="hidden"
                name="status"
                value={student.status === "active" ? "disabled" : "active"}
              >
              <button type="submit" class={smallButton}>
                {student.status === "active" ? m.educator_student_disable() : m.educator_student_enable()}
              </button>
            </form>

            {#if student.status !== "removed"}
              <form method="POST" action="?/setStatus" use:enhance>
                <input type="hidden" name="studentId" value={student.id}>
                <input type="hidden" name="status" value="removed">
                <button type="submit" class={smallButton}>{m.educator_student_remove()}</button>
              </form>
            {/if}

            <!-- Permanent deletion, typed rather than clicked (§16). -->
            <form method="POST" action="?/deleteStudent" use:enhance class="flex items-end gap-1.5">
              <input type="hidden" name="studentId" value={student.id}>
              <label class="flex flex-col gap-1">
                <span class="text-[0.6875rem] text-muted-foreground">
                  {m.educator_student_delete_confirm_label({ label: student.label })}
                </span>
                <input
                  name="confirmLabel"
                  autocomplete="off"
                  value={deleteConfirmations[student.id] ?? ""}
                  oninput={(event) => (deleteConfirmations[student.id] = event.currentTarget.value)}
                  class="h-8 w-40 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                >
              </label>
              <button
                type="submit"
                disabled={(deleteConfirmations[student.id]?.trim() ?? "") !== student.label}
                class="h-8 rounded-md border border-destructive px-2.5 text-xs font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
              >
                {m.educator_student_delete()}
              </button>
            </form>
          </div>

          {#if confirmMismatch === student.id}
            <p class="text-xs text-destructive" role="alert">
              {m.educator_student_delete_mismatch()}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
