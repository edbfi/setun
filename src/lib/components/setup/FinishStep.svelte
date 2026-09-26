<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";

/**
 * Finish (PRD §6.2, §7, §21).
 *
 * The summary is read from the same derivation the wizard navigates by, so it
 * cannot claim a step is done that the server would disagree about. The button
 * is a suggestion; the server re-checks every prerequisite before it writes the
 * completion flag, and refuses if any is missing.
 *
 * What happens next is worth stating plainly on the screen: the operator is
 * signed in to the panel, and this page stops existing.
 */

interface Props {
  aliasName: string | null;
  classroomName: string | null;
  studentCount: number;
  canFinish: boolean;
}

let { aliasName, classroomName, studentCount, canFinish }: Props = $props();
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.setup_finish_title()}</h2>
  <p class="text-sm text-muted-foreground">{m.setup_finish_intro()}</p>

  <ul class="flex flex-col gap-1 rounded-md border border-border p-4 text-sm text-foreground">
    <li>{m.setup_finish_check_account()}</li>
    {#if aliasName}
      <li>{m.setup_finish_check_model({ alias: aliasName })}</li>
    {/if}
    {#if classroomName}
      <li>{m.setup_finish_check_class({ classroom: classroomName })}</li>
    {/if}
    <li>{m.setup_finish_check_students({ count: studentCount })}</li>
  </ul>

  <div class="flex flex-wrap gap-2">
    <a
      href="/setup?step=students"
      class="flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
    >
      {m.setup_back()}
    </a>
    <form method="POST" action="?/finish" use:enhance>
      <button
        type="submit"
        disabled={!canFinish}
        class="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {m.setup_finish_submit()}
      </button>
    </form>
  </div>
</section>
