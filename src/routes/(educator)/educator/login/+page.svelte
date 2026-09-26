<script lang="ts">
import { enhance } from "$app/forms";
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import EducatorRecoveryPanel from "$lib/components/educator/EducatorRecoveryPanel.svelte";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * Educator sign-in (PRD §7).
 *
 * One failure message for every cause, matching the server: an educator who
 * mistypes a username and one who mistypes a password are told the same thing,
 * because anything else would answer "does this account exist?" (§7, §21).
 */
let { form }: PageProps = $props();
</script>

<svelte:head><title>{m.educator_login_title()} · {m.app_name()}</title></svelte:head>

<main class="mx-auto flex min-h-svh max-w-sm flex-col justify-center gap-6 px-6 py-12">
  <div class="flex flex-col gap-2">
    <SetunMark size={28} class="text-primary" />
    <h1 class="text-lg font-semibold text-foreground">{m.educator_login_title()}</h1>
    <p class="text-sm text-muted-foreground">{m.educator_login_intro()}</p>
  </div>

  <form method="POST" use:enhance class="flex flex-col gap-4">
    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_username_label()}</span>
      <input
        name="username"
        type="text"
        autocomplete="username"
        required
        class="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
      >
    </label>

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_password_label()}</span>
      <input
        name="password"
        type="password"
        autocomplete="current-password"
        required
        class="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
      >
    </label>

    {#if form?.failed}
      <p class="text-sm text-destructive" role="alert">{m.educator_login_failed()}</p>
    {/if}

    <button
      type="submit"
      class="h-10 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90"
    >
      {m.educator_login_submit()}
    </button>
  </form>

  <EducatorRecoveryPanel />
</main>
