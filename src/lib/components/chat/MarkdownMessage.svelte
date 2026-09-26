<script lang="ts">
import { hasOpenFence, renderMarkdown } from "$lib/chat/markdown";

/**
 * A settled assistant message, rendered as markdown (PRD §5, §20).
 *
 * Streaming text does not come here — it renders as plain preformatted text in
 * `StreamingMessage`, because re-parsing markdown on every delta is precisely
 * the work the target Chromebook cannot spare (§20).
 *
 * The `{@html}` below is safe by construction: `renderMarkdown` is the only
 * producer of these strings and sanitises with DOMPurify on every path (§5).
 */
interface Props {
  text: string;
}

let { text }: Props = $props();

// Sanitisation needs a DOM, so the server renders the source as plain text and
// the client swaps in markdown on hydration. Model HTML therefore never has a
// server-rendered path to the browser at all.
let rendered = $derived(typeof window === "undefined" ? null : renderMarkdown(text));

// An unclosed fence means the model is mid-block; render it plainly rather than
// letting `marked` guess at a structure that is still arriving (§20).
let incomplete = $derived(hasOpenFence(text));
</script>

{#if rendered && !incomplete}
  <div class="prose-message">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised in renderMarkdown -->
    {@html rendered}
  </div>
{:else}
  <p class="whitespace-pre-wrap break-words">{text}</p>
{/if}

<style>
/*
   * Scoped to rendered markdown, which is `{@html}` output and therefore not
   * reachable by Svelte's scoped class attribution — hence `:global` inside a
   * scoped wrapper rather than utility classes on the elements themselves.
   *
   * Every colour is wrapped in `oklch()`. The theme variables emitted by
   * `unocss-preset-shadcn` are bare oklch *components* — `0.967 0.0029 264.54`,
   * with no function around them — because its own utilities supply the wrapper.
   * A plain `var(--muted)` here therefore resolves to an invalid colour and
   * silently falls back to transparent, which is what every rule below used to
   * do: code blocks had no ground, links were not the accent, and a blockquote's
   * rule was invisible.
   */
.prose-message :global(p) {
  margin-block: 0.625rem;
  overflow-wrap: break-word;
}
.prose-message :global(p:first-child) {
  margin-block-start: 0;
}
.prose-message :global(p:last-child) {
  margin-block-end: 0;
}
.prose-message :global(ul),
.prose-message :global(ol) {
  margin-block: 0.625rem;
  padding-inline-start: 1.5rem;
}
.prose-message :global(li) {
  margin-block: 0.25rem;
}
.prose-message :global(ul) {
  list-style: disc;
}
.prose-message :global(ol) {
  list-style: decimal;
}
.prose-message :global(code) {
  font-family: var(--font-mono);
  font-size: 0.875em;
  background: oklch(var(--muted));
  padding: 0.1em 0.3em;
  border-radius: calc(var(--radius) - 4px);
}
.prose-message :global(pre) {
  margin-block: 0.75rem;
  padding: 0.75rem 1rem;
  background: oklch(var(--muted));
  border: 1px solid oklch(var(--border));
  border-radius: calc(var(--radius) - 2px);
  overflow-x: auto;
  font-size: 0.8125rem;
  line-height: 1.55;
}
.prose-message :global(pre code) {
  background: none;
  border: 0;
  padding: 0;
}
.prose-message :global(a) {
  color: oklch(var(--primary));
  text-decoration: underline;
  text-underline-offset: 2px;
}
.prose-message :global(h1),
.prose-message :global(h2),
.prose-message :global(h3) {
  font-weight: 600;
  margin-block: 1rem 0.375rem;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.prose-message :global(h1:first-child),
.prose-message :global(h2:first-child),
.prose-message :global(h3:first-child) {
  margin-block-start: 0;
}
.prose-message :global(h1) {
  font-size: 1.125rem;
}
.prose-message :global(h2) {
  font-size: 1.0625rem;
}
.prose-message :global(h3) {
  font-size: 1rem;
}
.prose-message :global(blockquote) {
  border-inline-start: 2px solid oklch(var(--border));
  padding-inline-start: 0.75rem;
  color: oklch(var(--muted-foreground));
}
.prose-message :global(hr) {
  margin-block: 1rem;
  border: 0;
  border-block-start: 1px solid oklch(var(--border));
}
.prose-message :global(table) {
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  margin-block: 0.75rem;
  font-size: 0.875em;
}
.prose-message :global(th),
.prose-message :global(td) {
  border: 1px solid oklch(var(--border));
  padding: 0.3rem 0.5rem;
  text-align: start;
}
.prose-message :global(th) {
  background: oklch(var(--muted));
  font-weight: 600;
}
</style>
