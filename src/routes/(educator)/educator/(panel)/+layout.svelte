<script lang="ts">
import { enhance } from "$app/forms";
import { page } from "$app/state";
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import * as m from "$lib/paraglide/messages";
import type { LayoutProps } from "./$types";

/**
 * The panel's chrome (PRD §17).
 *
 * "A dense, single-operator tool." One rail, one working column, no dashboard
 * cards — an educator opens this between lessons and needs the classroom list
 * and the working area at once.
 *
 * `$app/state`, not `$app/stores`.
 */
let { data, children }: LayoutProps = $props();

const current = $derived(page.url.pathname);
</script>

<svelte:head><title>{m.educator_panel_title()} · {m.app_name()}</title></svelte:head>

<div class="flex min-h-svh flex-col bg-background sm:flex-row">
  <aside
    class="flex shrink-0 flex-col gap-4 border-b border-border p-4 sm:w-56 sm:border-r sm:border-b-0"
  >
    <div class="flex items-center gap-2">
      <SetunMark size={20} class="text-primary" />
      <span class="text-sm font-semibold text-foreground">{m.educator_panel_title()}</span>
    </div>

    <nav class="flex flex-col gap-0.5">
      <span
        class="px-2 py-1 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground"
      >
        {m.educator_classrooms_title()}
      </span>

      {#each data.classrooms as classroom (classroom.id)}
        <a
          href="/educator/classrooms/{classroom.id}"
          class="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary"
          class:bg-secondary={current.startsWith(`/educator/classrooms/${classroom.id}`)}
          class:font-medium={current.startsWith(`/educator/classrooms/${classroom.id}`)}
        >
          <span class="truncate text-foreground">{classroom.name}</span>
          {#if classroom.state === "locked"}
            <span class="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true"></span>
          {:else if classroom.state === "open"}
            <span class="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
          {/if}
        </a>
      {:else}
        <p class="px-2 py-1.5 text-xs text-muted-foreground">{m.educator_no_classrooms()}</p>
      {/each}

      <a
        href="/educator"
        class="mt-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-secondary"
        class:bg-secondary={current === "/educator"}
        class:font-medium={current === "/educator"}
      >
        {m.educator_dashboard_title()}
      </a>
      <a
        href="/educator/models"
        class="rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-secondary"
        class:bg-secondary={current === "/educator/models"}
      >
        {m.educator_aliases_title()}
      </a>
      <a
        href="/educator/tools"
        class="rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-secondary"
        class:bg-secondary={current === "/educator/tools"}
      >
        {m.educator_tools_title()}
      </a>
      <a
        href="/educator/skills"
        class="rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-secondary"
        class:bg-secondary={current === "/educator/skills"}
      >
        {m.educator_skills_title()}
      </a>
    </nav>

    <form method="POST" action="/educator?/logout" use:enhance class="mt-auto pt-2">
      <button type="submit" class="text-xs text-muted-foreground hover:text-foreground">
        {m.educator_sign_out()}
      </button>
    </form>
  </aside>

  <main class="min-w-0 flex-1 p-4 sm:p-6">
    {@render children()}
  </main>
</div>
