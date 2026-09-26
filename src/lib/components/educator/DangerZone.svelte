<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { ClassroomDeletionScope } from "$lib/server/classroom/students";

/**
 * Deleting a classroom (PRD §16, §17).
 *
 * §16 asks the panel to "clearly distinguish disabling, removal from a class,
 * and permanent deletion", and it did — for pupils. The container had no
 * deletion at all, so a room set up by mistake stayed on the dashboard for good.
 *
 * The friction is the pupil deletion's, because the same thing is true here and
 * more so: the educator retypes the name. Below it, the counts — a decision to
 * delete a class is made knowing how many pupils, conversations and creations go
 * with it, and counts are all §16 lets the panel show of them.
 *
 * Last on the page, in its own bordered block, because nothing above it is
 * irreversible and this is.
 */

interface Props {
  classroomName: string;
  scope: ClassroomDeletionScope;
  /** True when the last attempt did not match the name; nothing was deleted. */
  mismatch: boolean;
}

let { classroomName, scope, mismatch }: Props = $props();

const numbers = $derived(new Intl.NumberFormat(getLocale()));

let confirmName = $state("");
const matches = $derived(confirmName.trim() === classroomName);
</script>

<section class="flex flex-col gap-3 rounded-md border border-destructive p-4">
  <h2 class="text-sm font-medium text-destructive">{m.educator_delete_classroom_title()}</h2>
  <p class="text-xs text-muted-foreground">{m.educator_delete_classroom_body()}</p>

  <p class="text-xs font-medium text-foreground tabular-nums">
    {m.educator_delete_classroom_counts({
  students: numbers.format(scope.students),
  conversations: numbers.format(scope.conversations),
  creations: numbers.format(scope.creations),
})}
  </p>

  {#if mismatch}
    <p role="alert" class="text-xs text-destructive">
      {m.educator_delete_classroom_mismatch()}
    </p>
  {/if}

  <form method="POST" action="?/deleteClassroom" use:enhance class="flex flex-wrap items-end gap-2">
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">
        {m.educator_delete_classroom_confirm_label()}
      </span>
      <input
        name="confirmName"
        bind:value={confirmName}
        autocomplete="off"
        placeholder={classroomName}
        class="h-9 w-64 rounded-md border border-input bg-background px-3 text-sm text-foreground"
      >
    </label>

    <!--
      Disabled until the name matches, and checked again on the server: the
      button is a courtesy, and the action refuses a mismatch whatever reaches it.
    -->
    <button
      type="submit"
      disabled={!matches}
      class="h-9 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
    >
      {m.educator_delete_classroom_submit()}
    </button>
  </form>
</section>
