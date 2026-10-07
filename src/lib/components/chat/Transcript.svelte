<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import type { Snippet } from "svelte";
import { tick, untrack } from "svelte";
import { readTranscriptPosition, writeTranscriptPosition } from "$lib/chat/viewport";
import * as m from "$lib/paraglide/messages";
import type {
  ChatMessage as ChatMessageData,
  ConversationState,
} from "$lib/state/conversation.svelte";
import ChatMessage from "./ChatMessage.svelte";
import StreamingMessage from "./StreamingMessage.svelte";

/**
 * The conversation itself (PRD §10, §20).
 *
 * The reading surface, and everything that belongs to reading: the window over a
 * long thread, where the scroll sits across a tab discard, and whether new text
 * should pull the view down.
 *
 * That last one used to be unconditional — every delta scrolled to the bottom —
 * so a pupil scrolling back to reread the paragraph the answer was about was
 * dragged forward a line at a time. The view follows the stream only while the
 * pupil is already at the newest end; step away and it stays where they left it,
 * with one control to come back.
 */
interface Props {
  conversation: ConversationState;
  /** Names the thread whose scroll position is remembered; null before one exists. */
  conversationId: string | null;
  onedit?: (message: { id: string; text: string }) => void;
  onregenerate?: (message: ChatMessageData) => void;
  onswitch?: (messageId: string) => void;
  onopenartifact?: (artifactId: string) => void;
  /** Which artifact the build surface is showing, so its card can say so (§13). */
  activeArtifactId?: string | null;
  /** Whether the model's reasoning is rendered, once policy and preference agree (§20). */
  showThinking?: boolean;
  /** The first-visit surface: shown only while the thread is genuinely empty. */
  empty?: Snippet;
  /** The turn's interactive parts and any refusal, rendered after the stream. */
  footer?: Snippet;
}

let {
  conversation,
  conversationId,
  onedit,
  onregenerate,
  onswitch,
  onopenartifact,
  activeArtifactId = null,
  showThinking = true,
  empty,
  footer,
}: Props = $props();

/** Messages rendered before the window has to be widened by hand (§20). */
const MESSAGE_WINDOW = 30;

/** Within this many pixels of the end counts as "reading the newest" (§20). */
const PINNED_SLACK = 64;

let scroller = $state<HTMLDivElement | null>(null);
let content = $state<HTMLDivElement | null>(null);
let windowSize = $state(MESSAGE_WINDOW);
let pinned = $state(true);

/** How long the thread was when we last looked, so an arrival can be spotted. */
let counted = 0;

// A different conversation starts at the newest end again (§20).
$effect(() => {
  conversationId;
  untrack(() => {
    windowSize = MESSAGE_WINDOW;
    pinned = true;
    counted = conversation.messages.length;
  });
});

/**
 * A pupil reading back keeps what they are reading (§20).
 *
 * The window is the newest `windowSize` messages, so an answer landing while
 * the pupil is somewhere above pushes the oldest mounted message out of the
 * column — and content disappearing above the viewport slides everything they
 * were reading up under their eyes. Widening the window by however many arrived
 * holds the start of the slice still, and costs nothing while they are at the
 * newest end, which is where the window is doing its job.
 */
$effect(() => {
  const total = conversation.messages.length;

  untrack(() => {
    const added = total - counted;
    counted = total;
    if (added <= 0 || pinned) return;

    windowSize += added;
    // The widened window is part of the stored position. Nothing was added
    // above the viewport — that is the point — so the offset still stands, and
    // a discard before the next scroll would otherwise come back to this offset
    // over a narrower column.
    remember();
  });
});

/** The newest slice of the active path — the rest is behind "show earlier" (§20). */
const visibleMessages = $derived(
  conversation.messages.length > windowSize
    ? conversation.messages.slice(-windowSize)
    : conversation.messages,
);

const hidden = $derived(conversation.messages.length - visibleMessages.length);

const isEmpty = $derived(
  conversation.messages.length === 0 && !conversation.hasPendingAssistantText,
);

function measure(): void {
  const element = scroller;
  if (!element) return;

  pinned = element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_SLACK;
}

function jumpToLatest(): void {
  const element = scroller;
  if (!element) return;

  pinned = true;
  element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
}

// Keep the newest content in view as it streams — but only for a pupil who is
// already there.
$effect(() => {
  conversation.turn.text;
  conversation.messages.length;
  if (!pinned) return;

  const element = untrack(() => scroller);
  element?.scrollTo({ top: element.scrollHeight });
});

/**
 * Follow the column as it settles, not only as it changes.
 *
 * A turn lands as one data refresh, but the height it produces arrives later: an
 * artifact card animates in, a code block lays out, a generated image loads. The
 * effect above fires on the change and misses all of it, which left the newest
 * card half behind the composer. Watching the column's own size catches every
 * one of them, and still only for a pupil who has not scrolled away.
 */
$effect(() => {
  const inner = content;
  const element = scroller;
  if (!inner || !element || typeof ResizeObserver === "undefined") return;

  const observer = new ResizeObserver(() => {
    if (pinned) element.scrollTo({ top: element.scrollHeight });
  });
  observer.observe(inner);
  return () => observer.disconnect();
});

/** The reading position as it stands: where, and over how much of the thread. */
function remember(): void {
  const element = scroller;
  if (!element) return;

  writeTranscriptPosition(conversationId, { offset: element.scrollTop, window: windowSize });
}

/**
 * Reading position across a tab discard (§20).
 *
 * A 4 GB Chromebook discards background tabs routinely. The composer draft
 * already survives one and the in-flight turn resumes from the server; this is
 * the third piece — coming back to where you were reading rather than to the top
 * of the lesson.
 *
 * Restored once per conversation, and only when there is something stored:
 * otherwise the autoscroll above is right and this would fight it.
 */
$effect(() => {
  const element = scroller;
  if (!element || !conversationId) return;

  /** Cleared on teardown, so a restore still in the air is abandoned. */
  let live = true;

  const stored = untrack(() => readTranscriptPosition(conversationId));
  if (stored) {
    untrack(() => {
      // The window before the offset: a position measured over sixty mounted
      // messages lands somewhere else in a column of thirty.
      if (stored.window > windowSize) windowSize = stored.window;
      // And nothing may pull the view to the newest end while the offset is
      // still one DOM update away.
      pinned = false;
    });

    void tick().then(() => {
      // The pupil can switch conversations inside that update, and the scroller
      // is the same element either way — this offset belongs to the thread that
      // has gone.
      if (!live) return;

      element.scrollTo({ top: stored.offset });
      measure();
    });
  }

  const onscroll = () => {
    remember();
    measure();
  };
  element.addEventListener("scroll", onscroll, { passive: true });
  return () => {
    live = false;
    element.removeEventListener("scroll", onscroll);
  };
});
</script>

<div data-transcript class="relative min-h-0 flex-1">
  <div bind:this={scroller} class="h-full overflow-y-auto overscroll-contain">
    <div bind:this={content} class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pb-8 pt-5">
      {#if isEmpty && empty}
        {@render empty()}
      {/if}

      {#if hidden > 0}
        <button
          type="button"
          onclick={async () => {
            const thread = conversationId;
            windowSize += MESSAGE_WINDOW;
            // Part of the position, not a separate preference: coming back to
            // the same line means coming back to the same mounted thread. After
            // the update, because thirty more messages mounting *above* moves
            // the offset this is about to store.
            await tick();
            // And only if the pupil is still in the thread they asked it of:
            // `remember` reads whichever conversation is live, so a switch
            // inside that update would file this position under the new one.
            if (conversationId !== thread) return;
            remember();
          }}
          class="mx-auto min-h-9 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {m.chat_show_earlier({ count: hidden })}
        </button>
      {/if}

      {#each visibleMessages as message (message.id)}
        <ChatMessage
          {message}
          {onedit}
          {onregenerate}
          {onswitch}
          {onopenartifact}
          {activeArtifactId}
          {showThinking}
        />
      {/each}

      <StreamingMessage turn={conversation.turn} {showThinking} />

      {@render footer?.()}
    </div>
  </div>

  {#if !pinned && !isEmpty}
    <!--
      One way back to the newest message, for a pupil who has read backwards.
      Over the transcript rather than in the chrome: it belongs to the scroll it
      controls, and it is gone the moment it would do nothing.
    -->
    <button
      type="button"
      onclick={jumpToLatest}
      class="absolute bottom-3 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:animate-in motion-safe:fade-in"
    >
      <ArrowDown size={16} aria-hidden="true" />
      <span class="sr-only">{m.chat_jump_to_latest()}</span>
    </button>
  {/if}
</div>
