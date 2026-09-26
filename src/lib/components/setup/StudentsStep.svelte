<script lang="ts">
import { enhance } from "$app/forms";
import CredentialCards from "$lib/components/educator/CredentialCards.svelte";
import type { CredentialCard } from "$lib/credentials";
import * as m from "$lib/paraglide/messages";
import type { Locale } from "$lib/paraglide/runtime";

/**
 * Step 5 — a first batch of pupils (PRD §7, §17).
 *
 * The panel's own provisioning path, reached a screen earlier. "Labels are
 * generated word pairs from a localised wordlist… unique within a classroom,
 * speakable in class — and printable credential cards."
 *
 * The codes are in this response and in no other. There is no route that could
 * show them again, because there is nothing stored that could answer it (§7).
 *
 * This is the one step that is not idempotent: provisioning again is a second
 * batch, not an edit. The notice says so rather than letting an operator
 * discover it by pressing the button twice.
 */

interface Props {
  cards: CredentialCard[];
  classroomName: string;
  appOrigin: string;
  /** The classroom's interface language — what the printed card is written in (§17). */
  classroomLanguage: Locale;
  alreadyProvisioned: boolean;
}

let { cards, classroomName, appOrigin, classroomLanguage, alreadyProvisioned }: Props = $props();

const field = "h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.setup_students_title()}</h2>
  <p class="text-sm text-muted-foreground">{m.setup_students_intro()}</p>
  <p class="text-xs text-muted-foreground">{m.educator_provision_help()}</p>

  {#if alreadyProvisioned}
    <p class="text-sm text-foreground">{m.setup_students_again()}</p>
  {/if}

  <form method="POST" action="?/students" use:enhance class="flex flex-wrap items-end gap-2">
    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_provision_count_label()}</span>
      <input name="count" type="number" min="1" max="40" value="20" class={field}>
    </label>
    <button
      type="submit"
      class="h-10 rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
    >
      {m.educator_provision_submit()}
    </button>
  </form>

  <CredentialCards {cards} {classroomName} {appOrigin} locale={classroomLanguage} />

  <div class="flex flex-wrap gap-2">
    <a
      href="/setup?step=classroom"
      class="flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
    >
      {m.setup_back()}
    </a>
    <a
      href="/setup?step=finish"
      class="flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
    >
      {cards.length > 0 ? m.setup_continue() : m.setup_students_skip()}
    </a>
  </div>
</section>
