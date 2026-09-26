<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { PendingElicitation } from "$lib/state/streaming-turn.svelte";
import ToolAttribution from "./ToolAttribution.svelte";

/**
 * A tool asking the pupil a question (PRD §11, §20).
 *
 * "Rendered with server attribution and a restricted set of input types (free
 * text, number, boolean, single-choice selection — the flat elicitation
 * primitives; nothing richer)."
 *
 * Four field types and no fifth: the union below is closed, so a server that
 * sends something richer has already had it dropped at the transport edge and
 * this component has nothing to fall back on. Skipping is always available,
 * because a pupil should never be stuck in front of a question they cannot
 * answer — the loop continues without it (§11).
 */
interface Props {
  elicitation: PendingElicitation;
  onrespond: (answer: {
    values: Record<string, string | number | boolean>;
    declined: boolean;
  }) => void;
}

let { elicitation, onrespond }: Props = $props();

/**
 * One entry per field, keyed by name; booleans start false, the rest empty.
 *
 * Seeded from the initial props on purpose: the parent keys this component by
 * the call it belongs to, so a second question arrives as a new component with
 * its own empty answers rather than inheriting the previous one's.
 */
// svelte-ignore state_referenced_locally
let values = $state<Record<string, string | number | boolean>>(
  Object.fromEntries(
    elicitation.fields.map((field) => [field.name, field.type === "boolean" ? false : ""]),
  ),
);

const complete = $derived(
  elicitation.fields.every(
    (field) =>
      !field.required || field.type === "boolean" || String(values[field.name] ?? "") !== "",
  ),
);

function submit(event: SubmitEvent) {
  event.preventDefault();
  if (complete) onrespond({ values, declined: false });
}

const field = "rounded-md border border-input bg-background px-3 text-sm text-foreground";
</script>

<section
  class="flex max-w-[85%] flex-col gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2.5"
  aria-live="polite"
>
  <ToolAttribution serverLabel={elicitation.serverLabel} pending />

  <div class="flex flex-col gap-0.5">
    <p class="text-sm font-medium text-foreground">{m.chat_elicitation_title()}</p>
    <!-- The server wrote this. Rendered as text, never as markup (§11, §21). -->
    <p class="text-sm text-muted-foreground">{elicitation.message}</p>
  </div>

  <form onsubmit={submit} class="flex flex-col gap-2">
    {#each elicitation.fields as spec (spec.name)}
      {#if spec.type === "boolean"}
        <label class="flex items-center gap-2 py-1">
          <input
            type="checkbox"
            checked={values[spec.name] === true}
            onchange={(event) => (values[spec.name] = event.currentTarget.checked)}
            class="size-4"
          >
          <span class="text-sm text-foreground">{spec.label}</span>
        </label>
      {:else}
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{spec.label}</span>

          {#if spec.type === "choice"}
            <select
              value={values[spec.name]}
              onchange={(event) => (values[spec.name] = event.currentTarget.value)}
              class="h-11 {field}"
            >
              <option value="">{m.chat_elicitation_choose()}</option>
              {#each spec.options ?? [] as option (option)}
                <option value={option}>{option}</option>
              {/each}
            </select>
          {:else}
            <input
              type={spec.type === "number" ? "number" : "text"}
              value={values[spec.name]}
              oninput={(event) =>
  (values[spec.name] =
    spec.type === "number" ? Number(event.currentTarget.value) : event.currentTarget.value)}
              class="h-11 {field}"
            >
          {/if}
        </label>
      {/if}
    {/each}

    <div class="flex gap-2">
      <button
        type="submit"
        disabled={!complete}
        class="h-11 flex-1 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {m.chat_elicitation_submit()}
      </button>
      <button
        type="button"
        onclick={() => onrespond({ values: {}, declined: true })}
        class="h-11 shrink-0 rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
      >
        {m.chat_elicitation_cancel()}
      </button>
    </div>
  </form>
</section>
