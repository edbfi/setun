<script lang="ts">
import { superForm } from "sveltekit-superforms";
import { enhance as formEnhance } from "$app/forms";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * The skill library (PRD §12, §17).
 *
 * Three ways to add one, in the order an educator reaches for them: write it,
 * upload a file, or search the registry. The registry panel says plainly when it
 * cannot be reached, because §12 makes that a supported state rather than a bug.
 *
 * Every uploaded and imported skill shows an Off badge until it is switched on —
 * the same fact the server enforces, stated where the educator is looking.
 */
let { data, form }: PageProps = $props();

// svelte-ignore state_referenced_locally
const { form: fields, errors, enhance, submitting } = superForm(data.form, { id: "skill" });

const entries = $derived(
  form && "entries" in form
    ? (form.entries as { id: string; name: string; description: string }[])
    : null,
);
const registryUnavailable = $derived(Boolean(form && "registryUnavailable" in form));
const uploadFailed = $derived(Boolean(form && "uploadFailed" in form));

const ORIGIN_LABELS = {
  panel: m.educator_skill_origin_panel,
  upload: m.educator_skill_origin_upload,
  import: m.educator_skill_origin_import,
  student: m.educator_skill_origin_student,
};

const field = "rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
const button =
  "h-8 rounded-md border border-input px-3 text-xs font-medium text-foreground hover:bg-secondary";

/** Which skill's instructions are expanded; one at a time keeps the list dense. */
let showing = $state<string | null>(null);
</script>

<svelte:head><title>{m.educator_skills_title()} · {m.educator_panel_title()}</title></svelte:head>

<div class="flex max-w-4xl flex-col gap-8">
  <header class="flex flex-col gap-1">
    <h1 class="text-base font-semibold text-foreground">{m.educator_skills_title()}</h1>
    <p class="max-w-2xl text-xs text-muted-foreground">{m.educator_skills_intro()}</p>
  </header>

  <section class="flex flex-col gap-3">
    <form method="POST" action="?/create" use:enhance class="flex flex-col gap-3">
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_skill_name_label()}</span>
          <input name="name" bind:value={$fields.name} class="h-9 {field}">
          <FieldError message={$errors.name} />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.educator_skill_description_label()}</span>
          <input name="description" bind:value={$fields.description} class="h-9 {field}">
          <FieldError message={$errors.description} />
        </label>
      </div>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_skill_body_label()}</span>
        <textarea name="body" rows="6" bind:value={$fields.body} class={field}></textarea>
        <FieldError message={$errors.body} />
      </label>

      <button
        type="submit"
        disabled={$submitting}
        class="h-9 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {m.educator_skill_create()}
      </button>
    </form>
  </section>

  <section class="flex flex-col gap-2">
    <h2 class="text-sm font-medium text-foreground">{m.educator_skill_upload_title()}</h2>
    <p class="text-xs text-muted-foreground">{m.educator_skill_upload_help()}</p>

    <form
      method="POST"
      action="?/upload"
      enctype="multipart/form-data"
      use:formEnhance
      class="flex flex-wrap items-center gap-2"
    >
      <input
        type="file"
        name="file"
        accept=".md,.markdown,.txt,text/plain,text/markdown"
        class="text-xs"
      >
      <button type="submit" class={button}>{m.educator_skill_upload()}</button>
    </form>
    {#if uploadFailed}
      <p class="text-xs text-destructive" role="alert">{m.educator_skill_upload_failed()}</p>
    {/if}
  </section>

  <section class="flex flex-col gap-2">
    <h2 class="text-sm font-medium text-foreground">{m.educator_skill_import_title()}</h2>

    <form method="POST" action="?/search" use:formEnhance class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_skill_import_query_label()}</span>
        <input name="query" class="h-8 w-64 {field}">
      </label>
      <button type="submit" class={button}>{m.educator_skill_import_search()}</button>
    </form>

    {#if registryUnavailable}
      <p class="text-xs text-muted-foreground" role="status">
        {m.educator_skill_import_unavailable()}
      </p>
    {:else if entries}
      {#if entries.length === 0}
        <p class="text-xs text-muted-foreground">{m.educator_skill_import_empty()}</p>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each entries as entry (entry.id)}
            <li
              class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <div class="flex min-w-0 flex-col">
                <span class="truncate text-sm text-foreground">{entry.name}</span>
                <span class="truncate text-xs text-muted-foreground">{entry.description}</span>
              </div>
              <form method="POST" action="?/import" use:formEnhance>
                <input type="hidden" name="entryId" value={entry.id}>
                <button type="submit" class={button}>{m.educator_skill_import_button()}</button>
              </form>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>

  <section class="flex flex-col gap-2">
    {#if data.skills.length === 0}
      <p class="text-sm text-muted-foreground">{m.educator_skill_library_empty()}</p>
    {/if}

    <ul class="flex flex-col gap-1">
      {#each data.skills as skill (skill.id)}
        <li class="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="flex items-center gap-2">
                <span class="truncate text-sm font-medium text-foreground">{skill.name}</span>
                {#if !skill.enabled}
                  <span
                    class="rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground"
                  >
                    {m.educator_skill_disabled_badge()}
                  </span>
                {/if}
              </span>
              <span class="truncate text-xs text-muted-foreground">
                {ORIGIN_LABELS[skill.origin]()}
                · {skill.description}
              </span>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <button
                type="button"
                class={button}
                onclick={() => (showing = showing === skill.id ? null : skill.id)}
              >
                {m.educator_student_skill_view()}
              </button>
              <form method="POST" action="?/setState" use:formEnhance>
                <input type="hidden" name="skillId" value={skill.id}>
                <input type="hidden" name="enabled" value={skill.enabled ? "false" : "true"}>
                <button type="submit" class={button}>
                  {skill.enabled ? m.educator_skill_disable() : m.educator_skill_enable()}
                </button>
              </form>
              <form method="POST" action="?/delete" use:formEnhance>
                <input type="hidden" name="skillId" value={skill.id}>
                <button
                  type="submit"
                  class="h-8 rounded-md border border-destructive px-3 text-xs font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground"
                >
                  {m.educator_skill_delete()}
                </button>
              </form>
            </div>
          </div>

          {#if showing === skill.id}
            <!-- Untrusted text, shown as text: never rendered as markup (§12, §21). -->
            <pre
              class="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-secondary p-2 text-xs text-foreground"
            >{skill.body}</pre>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
</div>
