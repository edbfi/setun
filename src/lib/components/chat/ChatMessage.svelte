<script lang="ts">
import ChevronLeft from "@lucide/svelte/icons/chevron-left";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import Pencil from "@lucide/svelte/icons/pencil";
import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
import * as m from "$lib/paraglide/messages";
import { type ChatMessage, textOf } from "$lib/state/conversation.svelte";
import MessageParts from "./MessageParts.svelte";

/**
 * One settled message in the conversation (PRD §10, §20).
 *
 * The pupil's words are a bubble; the answer is not. A column of boxes reads as
 * a form, and on 640 pixels of usable height a box around every answer costs a
 * line of the answer itself — so the answer sits on the page's own ground with
 * nothing but space around it, and the bubble is what marks a turn as *mine*.
 *
 * The rule down the left edge that used to mark an answer is gone: `ToolAttribution`
 * uses exactly that device to mean "something other than the assistant is
 * talking", and two things cannot be the same shape and mean different things.
 * Space separates speakers here; the rule stays the machine layer's alone.
 *
 * Off-screen messages use content-visibility so a long conversation does not
 * cost layout on every frame (§20).
 */
interface Props {
  message: ChatMessage;
  /** Editing a prompt branches the tree as a sibling (§10). */
  onedit?: (message: { id: string; text: string }) => void;
  onregenerate?: (message: ChatMessage) => void;
  /** Step to the sibling variant at `messageId` — the branch picker (§10). */
  onswitch?: (messageId: string) => void;
  /** Open an artifact this message built, from its card in the transcript (§13). */
  onopenartifact?: (artifactId: string) => void;
  /** Which artifact the build surface is showing, so its card can say so (§13). */
  activeArtifactId?: string | null;
  /** Whether the model's reasoning is rendered, once policy and preference agree (§20). */
  showThinking?: boolean;
}

let {
  message,
  onedit,
  onregenerate,
  onswitch,
  onopenartifact,
  activeArtifactId = null,
  showThinking = true,
}: Props = $props();

const isUser = $derived(message.role === "user");
const branch = $derived(message.branch ?? null);

const action =
  "flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
</script>

<article
  class={["message contain-message flex flex-col gap-1.5", isUser ? "items-end" : "items-start"]}
  data-role={message.role}
>
  <div
    class={[
  "text-[0.9375rem] leading-[1.65]",
  isUser
    ? "max-w-[85%] rounded-2xl rounded-br-md border border-primary/20 bg-primary/10 px-3.5 py-2.5 text-foreground"
    : "w-full text-foreground",
]}
  >
    <MessageParts
      parts={message.parts}
      plain={isUser}
      artifacts={message.artifacts}
      {activeArtifactId}
      {onopenartifact}
      {showThinking}
    />
  </div>

  <div class="flex items-center gap-1">
    {#if branch && onswitch}
      <!--
        A branch point: this message has sibling variants an edit or regenerate
        left off-screen. The picker steps between them so the older branch is
        never orphaned (§10). Always visible — unlike the actions beside it —
        because it is the only way back to a variant that is not currently shown.
      -->
      <div class="flex items-center gap-0.5 font-mono text-xs tabular-nums text-muted-foreground">
        <button
          type="button"
          class="grid size-7 place-items-center rounded-md hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={branch.prevId === null}
          aria-label={m.chat_branch_previous()}
          onclick={() => branch?.prevId && onswitch?.(branch.prevId)}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span>{branch.index + 1}/{branch.total}</span>
        <button
          type="button"
          class="grid size-7 place-items-center rounded-md hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={branch.nextId === null}
          aria-label={m.chat_branch_next()}
          onclick={() => branch?.nextId && onswitch?.(branch.nextId)}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
    {/if}

    <!--
      Revealed on hover where there is a pointer, and always present where there
      is not: a control that only appears on hover is a control a touchscreen
      never shows (§20).
    -->
    <div class="message-actions flex items-center gap-0.5">
      {#if isUser && onedit}
        <button
          type="button"
          class={action}
          onclick={() => onedit?.({ id: message.id, text: textOf(message) })}
        >
          <Pencil size={13} aria-hidden="true" />
          {m.chat_edit_message()}
        </button>
      {/if}
      {#if !isUser && onregenerate}
        <button type="button" class={action} onclick={() => onregenerate?.(message)}>
          <RotateCcw size={13} aria-hidden="true" />
          {m.chat_regenerate()}
        </button>
      {/if}
    </div>
  </div>
</article>

<style>
/*
   * Off-screen messages skip layout and paint entirely; the size hint keeps the
   * scrollbar from jumping as they enter and leave (PRD §20).
   */
.contain-message {
  content-visibility: auto;
  contain-intrinsic-size: auto 4rem;
}

/*
   * Hover-to-reveal only where hovering exists. The touchscreen this is built
   * for has no hover state at all, so on it the actions simply stay.
   */
@media (hover: hover) and (pointer: fine) {
  .message-actions {
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .message:hover .message-actions,
  .message-actions:focus-within {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .message-actions {
    transition: none;
  }
}
</style>
