<script lang="ts">
import Trash2 from "@lucide/svelte/icons/trash-2";
import X from "@lucide/svelte/icons/x";
import type { Snippet } from "svelte";
import DoneSoundControl from "$lib/components/ui/DoneSoundControl.svelte";
import ThemeControl from "$lib/components/ui/ThemeControl.svelte";
import ThinkingControl from "$lib/components/ui/ThinkingControl.svelte";
import * as m from "$lib/paraglide/messages";
import type { DoneSound } from "$lib/server/db/schema";

/**
 * The conversation list, as an overlay (PRD §18, §20).
 *
 * "Usable height after browser and system chrome is roughly 640 pixels, so there
 * is no persistent application header and the sidebar is an overlay rather than
 * a permanent column" (§20). At 1366 pixels wide a permanent column would cost a
 * quarter of the reading width for a list that is consulted between lessons, not
 * during one — and the build surface is what that width is now for.
 *
 * It is also where everything that is not the lesson lives: starting a new
 * conversation, the rest of the pupil's navigation, how the interface is
 * coloured, and signing out.
 *
 * Hand-rolled rather than a dialog primitive: this is a plain panel with a
 * scrim, it must not trap the page in a modal while a turn is streaming behind
 * it, and it costs no additional JavaScript on a route with a 250 KB budget.
 */

interface Conversation {
  id: string;
  title: string | null;
}

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  open: boolean;
  onclose: () => void;
  /** Absent while the drawer is used somewhere deletion does not belong. */
  ondelete?: (conversationId: string) => void;
  /**
   * Starting a new conversation, with the model it will use (§9).
   *
   * A form the caller owns, because it posts to that route's own action and has
   * to keep working with JavaScript off.
   */
  actions?: Snippet;
  /**
   * The rest of the pupil's navigation (§20).
   *
   * The header is one compact strip on a 640-pixel screen. The links are
   * consulted between lessons rather than during one, which is exactly what this
   * drawer already is — so the caller passes them here, keeping the sign-out form
   * on the route whose action it posts to.
   */
  footer?: Snippet;
  /**
   * Whether the pupil's thinking switch belongs here (§20).
   *
   * False where the classroom has decided for them, in which case the control is
   * not offered at all rather than shown as a setting that changes nothing.
   */
  thinkingChoice?: boolean;
  /** The classroom's default for the done sound; the switch overrides it on this device (§20). */
  doneSound?: DoneSound;
}

let {
  conversations,
  activeId,
  open,
  onclose,
  ondelete,
  actions,
  footer,
  thinkingChoice = false,
  doneSound = "on",
}: Props = $props();

/**
 * The row whose delete control is awaiting confirmation (§16).
 *
 * Deleting a conversation removes its messages, turns and buffered events for
 * good, so it asks first. Inline rather than `window.confirm`, which cannot be
 * translated and which a pupil dismisses without reading; and lighter than the
 * type-the-label friction the educator's pupil deletion uses, because this is a
 * pupil deleting their own work and only their own.
 */
let confirming = $state<string | null>(null);

let panel = $state<HTMLElement | null>(null);

/** Whatever had the keyboard when the drawer opened, so closing can hand it back. */
let opener: HTMLElement | null = null;

// A conversation that has gone — deleted, or the drawer reopened on a new list —
// must not leave its confirmation armed against whatever now sits in that row.
$effect(() => {
  if (confirming && !conversations.some((c) => c.id === confirming)) confirming = null;
});

/**
 * The keyboard follows the panel in, and comes back out with it.
 *
 * Opening moves focus into the panel, so the first Tab lands inside the thing
 * that just appeared rather than back in the conversation behind it. Closing has
 * to undo that: the element the focus was in has gone from the document with the
 * panel, and a pupil dropped onto `<body>` has to Tab the whole page again to
 * reach the control they just pressed.
 *
 * Only where dismissing actually dropped it. This panel deliberately does not
 * trap the keyboard, so a pupil can Tab out of an open drawer, and hauling them
 * back to the opener afterwards would be its own kind of rude.
 */
$effect(() => {
  if (open) {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== panel ? active : opener;
    panel?.focus();
    return;
  }

  const returning = opener;
  opener = null;
  const active = document.activeElement;
  if (returning?.isConnected && (active === null || active === document.body)) returning.focus();
});

const link =
  "flex min-h-11 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
</script>

<svelte:window onkeydown={(event) => open && event.key === "Escape" && onclose()} />

{#if open}
  <!-- No backdrop blur (§20): a scrim, not a compositing effect. -->
  <button
    type="button"
    class="fixed inset-0 z-40 bg-black/40 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
    aria-label={m.chat_conversations_close()}
    onclick={onclose}
  ></button>

  <aside
    bind:this={panel}
    tabindex="-1"
    aria-label={m.chat_conversations()}
    class="fixed inset-y-0 start-0 z-50 flex w-76 max-w-[85vw] flex-col gap-3 border-e border-border bg-background p-3 outline-none motion-safe:animate-in motion-safe:slide-in-from-left-4 motion-safe:duration-200"
  >
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold tracking-tight text-foreground">{m.chat_conversations()}</h2>
      <button
        type="button"
        onclick={onclose}
        aria-label={m.chat_conversations_close()}
        class="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>

    {@render actions?.()}

    <nav aria-label={m.chat_conversations()} class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {#each conversations as conversation (conversation.id)}
        {@const title = conversation.title ?? m.chat_untitled_conversation()}
        <!-- Touch-sized rows, not compact ones: the target device is a touchscreen (§20). -->
        <div
          class="group/row flex min-h-11 items-center gap-1 rounded-md pe-1"
          class:bg-secondary={conversation.id === activeId}
        >
          <a
            href="/chat?c={conversation.id}"
            class="flex min-h-11 flex-1 items-center rounded-md px-2 text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            class:font-medium={conversation.id === activeId}
            aria-current={conversation.id === activeId ? "page" : undefined}
          >
            <span class="truncate text-foreground">{title}</span>
          </a>

          {#if ondelete}
            {#if confirming === conversation.id}
              <button
                type="button"
                onclick={() => {
                  confirming = null;
                  ondelete?.(conversation.id);
                }}
                class="min-h-11 shrink-0 rounded-md px-2 text-xs font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m.chat_delete_conversation_confirm()}
              </button>
              <button
                type="button"
                onclick={() => (confirming = null)}
                class="min-h-11 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {m.chat_delete_conversation_cancel()}
              </button>
            {:else}
              <button
                type="button"
                onclick={() => (confirming = conversation.id)}
                aria-label={m.chat_delete_conversation_aria({ title })}
                class="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-secondary hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100"
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            {/if}
          {/if}
        </div>
      {:else}
        <p class="px-2 py-1.5 text-xs text-muted-foreground">{m.chat_conversations_empty()}</p>
      {/each}
    </nav>

    <div class="flex flex-col gap-2 border-t border-border pt-2">
      <a href="/dashboard" class={link}>{m.student_dashboard_link()}</a>
      {@render footer?.()}
      {#if thinkingChoice}
        <!--
          Only where the classroom left the choice to the pupil: a switch that
          decides nothing is a promise the interface does not keep (§20).
        -->
        <ThinkingControl />
      {/if}
      <DoneSoundControl classroomDefault={doneSound} />
      <ThemeControl />
    </div>
  </aside>
{/if}
