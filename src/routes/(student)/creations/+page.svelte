<script lang="ts">
import { enhance } from "$app/forms";
import { effectiveLanguage } from "$lib/artifacts/identity";
import ArtifactFrame from "$lib/components/artifacts/ArtifactFrame.svelte";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * The student's portfolio (PRD §13, §16, §18).
 *
 * "Every edit is versioned, which yields undo, a diff view… and a creations
 * gallery." Artifacts and generated images together, kept until the student or
 * their educator deletes them — which is why this route reads by owner and never
 * by conversation.
 */

let { data }: PageProps = $props();

let selectedId = $state<string | null>(null);
const selected = $derived(data.artifacts.find((item) => item.id === selectedId) ?? null);

const empty = $derived(data.artifacts.length === 0 && data.images.length === 0);
</script>

<svelte:head><title>{m.creations_title()} · {m.app_name()}</title></svelte:head>

<div class="flex h-svh flex-col bg-background">
  <header class="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
    <h1 class="truncate text-sm font-medium text-foreground">{m.creations_title()}</h1>
    <a href="/chat" class="shrink-0 text-xs text-muted-foreground hover:text-foreground">
      {m.creations_back()}
    </a>
  </header>

  <div class="flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-3xl flex-col gap-6 p-3">
      {#if empty}
        <div class="mt-12 flex flex-col items-center gap-2 text-center">
          <h2 class="text-base font-semibold text-foreground">{m.creations_empty_heading()}</h2>
          <p class="max-w-sm text-sm text-muted-foreground">{m.creations_empty_body()}</p>
        </div>
      {/if}

      {#if data.artifacts.length > 0}
        <section class="flex flex-col gap-2">
          <h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {m.creations_artifacts_heading()}
          </h2>

          <ul class="grid gap-2 sm:grid-cols-2">
            {#each data.artifacts as item (item.id)}
              <li class="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
                <span class="truncate text-sm font-medium text-foreground">
                  {item.title ?? m.artifact_untitled({ language: item.language })}
                </span>
                <span class="text-xs text-muted-foreground">
                  {m.artifact_version_count({ count: item.versionCount })}
                </span>

                <div class="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onclick={() => (selectedId = selectedId === item.id ? null : item.id)}
                    aria-expanded={selectedId === item.id}
                    class="rounded-md border border-input px-2 py-1 text-xs text-foreground hover:bg-secondary"
                  >
                    {m.creations_open()}
                  </button>

                  <form method="POST" action="?/deleteArtifact" use:enhance>
                    <input type="hidden" name="id" value={item.id}>
                    <button
                      type="submit"
                      class="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive"
                    >
                      {m.artifact_delete()}
                    </button>
                  </form>
                </div>
              </li>
            {/each}
          </ul>

          {#if selected}
            <!--
              The same isolated origin the workspace uses; nothing about a gallery
              preview makes generated code less hostile (§14).
            -->
            {#key selected.id}
              <div class="h-96 overflow-hidden rounded-md border border-border">
                <ArtifactFrame
                  sandboxOrigin={data.sandboxOrigin}
                  artifactId={selected.id}
                  language={effectiveLanguage(selected, selected.latest)}
                  entry={selected.latest.entry}
                  files={selected.latest.files}
                />
              </div>
            {/key}
          {/if}
        </section>
      {/if}

      {#if data.images.length > 0}
        <section class="flex flex-col gap-2">
          <h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {m.creations_images_heading()}
          </h2>

          <ul class="grid gap-2 sm:grid-cols-3">
            {#each data.images as image (image.id)}
              <li class="flex flex-col gap-1.5 rounded-md border border-border p-2">
                <!--
                  Served by Setun, scoped to its owner. No external image URL ever
                  reaches the browser, and nothing here is served to the sandbox
                  origin (§15, §21).
                -->
                <img
                  src="/api/images/{image.id}"
                  alt={m.creations_image_alt({ prompt: image.prompt })}
                  loading="lazy"
                  class="aspect-square w-full rounded-sm object-cover"
                >
                <span class="truncate text-xs text-muted-foreground">{image.prompt}</span>

                <form method="POST" action="?/deleteImage" use:enhance>
                  <input type="hidden" name="id" value={image.id}>
                  <button
                    type="submit"
                    class="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive"
                  >
                    {m.artifact_delete()}
                  </button>
                </form>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>
  </div>
</div>
