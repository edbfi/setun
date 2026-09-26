<script lang="ts">
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";

/**
 * The conversation list, with search (PRD §10, §18, §21).
 *
 * The list is server-rendered and works without JavaScript; typing narrows it
 * through the search endpoint, which is scoped to the requesting pupil in SQL —
 * there is no parameter here that could name anybody else's conversations.
 *
 * The excerpt arrives as plain text with no markup, so it is interpolated as
 * text and nothing from a model or another pupil can become an element (§21).
 */

interface Conversation {
  id: string;
  title: string | null;
  updatedAt: string;
}

interface Hit {
  conversationId: string;
  title: string | null;
  excerpt: string;
  updatedAt: string;
}

interface Props {
  conversations: Conversation[];
}

let { conversations }: Props = $props();

let query = $state("");
let hits = $state<Hit[] | null>(null);

const moment = $derived(
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "short", timeStyle: "short" }),
);

/**
 * One in-flight search at a time.
 *
 * A Chromebook with one spare core should not be running four fetches and four
 * renders because somebody typed four letters (§20), so each keystroke cancels
 * the request before it.
 */
let inFlight: AbortController | null = null;

async function search(value: string): Promise<void> {
  inFlight?.abort();

  if (value.trim().length === 0) {
    hits = null;
    return;
  }

  const controller = new AbortController();
  inFlight = controller;

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(value)}`, {
      signal: controller.signal,
    });
    if (!response.ok) return;
    hits = ((await response.json()) as { hits: Hit[] }).hits;
  } catch {
    // An aborted or failed search leaves the list as it was; a search box that
    // reported network errors would be noise, not information.
  }
}
</script>

<section class="flex flex-col gap-3">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h2 class="text-sm font-medium text-foreground">{m.chat_conversations()}</h2>
    <a href="/chat" class="text-xs text-primary underline underline-offset-2">
      {m.student_open_chat()}
    </a>
  </div>

  <label class="flex flex-col gap-1">
    <span class="sr-only">{m.student_search_label()}</span>
    <input
      type="search"
      bind:value={query}
      oninput={() => search(query)}
      placeholder={m.student_search_placeholder()}
      class="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
    >
  </label>

  {#if hits !== null}
    {#if hits.length === 0}
      <p class="text-xs text-muted-foreground">{m.student_search_empty()}</p>
    {:else}
      <ul class="flex flex-col divide-y divide-border border-y border-border">
        {#each hits as hit (hit.conversationId)}
          <li>
            <a href="/chat?c={hit.conversationId}" class="flex flex-col gap-0.5 py-2.5">
              <span class="text-sm text-foreground">
                {hit.title ?? m.chat_untitled_conversation()}
              </span>
              <span class="text-xs text-muted-foreground">{hit.excerpt}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if conversations.length === 0}
    <p class="text-xs text-muted-foreground">{m.chat_empty_heading()}</p>
  {:else}
    <ul class="flex flex-col divide-y divide-border border-y border-border">
      {#each conversations as conversation (conversation.id)}
        <li>
          <a
            href="/chat?c={conversation.id}"
            class="flex flex-wrap items-baseline justify-between gap-2 py-2.5"
          >
            <span class="text-sm text-foreground">
              {conversation.title ?? m.chat_untitled_conversation()}
            </span>
            <span class="text-xs text-muted-foreground">
              {moment.format(new Date(conversation.updatedAt))}
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>
