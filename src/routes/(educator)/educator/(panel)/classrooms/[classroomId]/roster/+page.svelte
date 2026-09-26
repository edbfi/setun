<script lang="ts">
import type { SubmitFunction } from "@sveltejs/kit";
import { enhance } from "$app/forms";
import CredentialCards from "$lib/components/educator/CredentialCards.svelte";
import RosterTable from "$lib/components/educator/RosterTable.svelte";
import type { CredentialBatch } from "$lib/credentials";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * The roster and provisioning (PRD §7, §17).
 *
 * Cards first when there are cards: they exist only in this response, so the
 * educator must not have to scroll to find them before navigating away (§7).
 */
let { data, form }: PageProps = $props();
let rotatingClassroom = $state(false);

const batch = $derived(
  form && "batch" in form
    ? ((form.batch as CredentialBatch | undefined) ?? null)
    : (null as CredentialBatch | null),
);
const slipIssueFailure = $derived(
  form && "slipIssueFailure" in form ? form.slipIssueFailure : null,
);
const confirmMismatch = $derived(
  form && "confirmMismatch" in form ? ((form.confirmMismatch as string | null) ?? null) : null,
);

const enhanceClassroomRotation: SubmitFunction = () => {
  rotatingClassroom = true;
  return async ({ update }) => {
    try {
      await update();
    } finally {
      rotatingClassroom = false;
    }
  };
};
</script>

<div class="flex max-w-4xl flex-col gap-8">
  <CredentialCards
    cards={batch?.cards ?? []}
    classroomName={data.classroom.name}
    locale={data.classroom.interfaceLanguage}
    appOrigin={data.appOrigin}
    scope={batch?.scope ?? "classroom"}
  />

  <section class="flex flex-col gap-3">
    <h2 class="text-sm font-medium text-foreground">{m.educator_provision_title()}</h2>
    <p class="text-xs text-muted-foreground">{m.educator_provision_help()}</p>

    <form method="POST" action="?/provision" use:enhance class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_provision_count_label()}</span>
        <input
          type="number"
          name="count"
          value="1"
          min="1"
          max="40"
          class="h-9 w-24 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        >
      </label>
      <button
        type="submit"
        class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {m.educator_provision_submit()}
      </button>
    </form>
  </section>

  <section class="flex flex-col gap-3 border-t border-border pt-6">
    <h2 class="text-sm font-medium text-foreground">{m.educator_slips_title()}</h2>
    <p class="text-xs text-muted-foreground">{m.educator_slip_security()}</p>

    <form method="POST" action="?/rotateClassroom" use:enhance={enhanceClassroomRotation}>
      <button
        type="submit"
        disabled={data.activeStudentCount === 0 || rotatingClassroom}
        onclick={(event) => {
  if (!window.confirm(m.educator_slip_bulk_confirm({ count: data.activeStudentCount }))) {
    event.preventDefault();
  }
}}
        class="h-9 rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50"
      >
        {m.educator_slip_bulk_submit({ count: data.activeStudentCount })}
      </button>
    </form>

    {#if data.activeStudentCount === 0 || slipIssueFailure === "empty"}
      <p class="text-xs text-muted-foreground">{m.educator_slip_bulk_empty()}</p>
    {:else if slipIssueFailure === "stale"}
      <p class="text-xs text-destructive" role="alert">{m.educator_slip_bulk_stale()}</p>
    {/if}
  </section>

  <RosterTable students={data.students} {confirmMismatch} />

  <p class="text-xs">
    <a
      href="?removed={data.includeRemoved ? "0" : "1"}"
      class="text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      {data.includeRemoved ? m.educator_hide_removed() : m.educator_show_removed()}
    </a>
  </p>
</div>
