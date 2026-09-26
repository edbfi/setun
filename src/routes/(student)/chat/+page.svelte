<script lang="ts">
import Plus from "@lucide/svelte/icons/plus";
import { tick, untrack } from "svelte";
import { enhance } from "$app/forms";
import { goto, invalidateAll, replaceState } from "$app/navigation";
import { page } from "$app/state";
import type { BuildStatus } from "$lib/artifacts/types";
import { readEventStream } from "$lib/chat/sse-client";
import { effectiveThinking, thinkingChoiceAvailable } from "$lib/chat/thinking-visibility";
import { fitVisualViewport } from "$lib/chat/viewport";
import ArtifactPanel from "$lib/components/artifacts/ArtifactPanel.svelte";
import BudgetWarning from "$lib/components/chat/BudgetWarning.svelte";
import ChatHeader from "$lib/components/chat/ChatHeader.svelte";
import Composer from "$lib/components/chat/Composer.svelte";
import ContinuePrompt from "$lib/components/chat/ContinuePrompt.svelte";
import ConversationDrawer from "$lib/components/chat/ConversationDrawer.svelte";
import ConversationStarters from "$lib/components/chat/ConversationStarters.svelte";
import ElicitationForm from "$lib/components/chat/ElicitationForm.svelte";
import PermissionPrompt from "$lib/components/chat/PermissionPrompt.svelte";
import Transcript from "$lib/components/chat/Transcript.svelte";
import ClassroomClosed from "$lib/components/classroom/ClassroomClosed.svelte";
import WorkspaceShell from "$lib/components/workspace/WorkspaceShell.svelte";
import * as m from "$lib/paraglide/messages";
import { ArtifactWorkspace, type WorkspaceStage } from "$lib/state/artifacts.svelte";
import { ClassroomState } from "$lib/state/classroom.svelte";
import { ComposerState } from "$lib/state/composer.svelte";
import {
  type ChatMessage as ChatMessageData,
  ConversationState,
  textOf,
} from "$lib/state/conversation.svelte";
import { attachmentRefusalMessage, imageRefusalMessage, refusalMessage } from "$lib/state/refusals";
import { getThinking } from "$lib/state/thinking.svelte";
import { type SplitAxis, watchSplitAxis } from "$lib/workspace/axis";
import type { PageProps } from "./$types";

/**
 * The student workspace (PRD §10, §13, §20).
 *
 * The conversation and the thing being built are two panes of one screen rather
 * than two screens, so the composer is never covered and a pupil can look at what
 * the model made while asking for the next change. This route owns the wiring —
 * the turn stream, the endpoints, the refusals — and nothing about the layout:
 * `WorkspaceShell` holds the geometry and `ArtifactPanel` fills the pane it is
 * given.
 *
 * State containers are instantiated here rather than imported as module
 * singletons: a singleton in a `.svelte.ts` module is shared across every SSR
 * request on the server.
 */
let { data }: PageProps = $props();

const conversation = new ConversationState();
const composer = new ComposerState();
const classroom = new ClassroomState();
const artifacts = new ArtifactWorkspace();

/**
 * Whether this pupil sees the model's reasoning (§20).
 *
 * The classroom's policy and the pupil's own device switch, resolved together.
 * Presentation only: a classroom set to "never shown" drops the events in the
 * runner, so there is nothing here to hide (§21).
 */
const thinking = getThinking();
const showThinking = $derived(effectiveThinking(data.thinkingVisibility, thinking.preference));

let refusal = $state<string | null>(null);
/** The conversation list, which is an overlay rather than a permanent column (§20). */
let drawerOpen = $state(false);
/** True while the composer's image mode is waiting on a picture (§15). */
let generating = $state(false);
/** Which way the workspace splits; the header's switcher draws the same axis (§20). */
let axis = $state<SplitAxis>("block");
let composerRef = $state<ReturnType<typeof Composer> | null>(null);

$effect(() => watchSplitAxis((next) => (axis = next)));

/**
 * The model the next conversation will be created with (§9).
 *
 * An alias is bound to a conversation when it is created and the messages in one
 * were answered by that model, so the choice sits beside *New conversation* in
 * the drawer rather than over a thread already under way. The first message of a
 * visit mints its conversation and carries the same value.
 *
 * Presentation only. Both `?/create` and `POST /api/conversations` fall back to
 * an allowlisted alias whatever a client sends: hiding a control is never access
 * control, and neither is trusting one (§8, §21).
 */
let selectedAliasId = $state<string | null>(null);

const activeAlias = $derived(data.aliases.find((alias) => alias.id === data.modelAliasId) ?? null);

// Default to the first allowlisted alias, and drop a choice the educator has
// since withdrawn rather than sending an id the server will refuse.
$effect(() => {
  const available = data.aliases;
  if (available.length === 0) return;
  if (!selectedAliasId || !available.some((alias) => alias.id === selectedAliasId)) {
    selectedAliasId = available[0].id;
  }
});

/**
 * The status the page renders.
 *
 * The load wins whenever the page data is refreshed — every turn ends with an
 * `invalidateAll`, so the allowance figure is exact then — and the channel
 * carries it in between, which is what makes a lock visible without a reload.
 */
const status = $derived(classroom.status ?? data.status);

/** Guard: a turn we already consumed or are consuming. */
let consumedTurnId = $state<string | null>(null);

// The push channel keeps the room's state current, so a pupil sees a lock land
// rather than discovering it by being refused. Enforcement never depends on it:
// the composer may linger for a moment, and the send is refused all the same
// (PRD §6, §8).
$effect(() => classroom.connect());

// Re-seed from the server whenever the loaded conversation changes.
$effect(() => {
  conversation.id = data.conversation?.id ?? null;
  conversation.title = data.conversation?.title ?? null;
  conversation.replaceMessages(data.messages);
  composer.attach(data.conversation?.id ?? null);
  // Uploads that survived a reload; the server is the record of what is pending.
  composer.setAttachments(data.pendingAttachments);
  drawerOpen = false;
});

// Every turn ends with an `invalidateAll`, so an artifact the model just wrote
// arrives here without a second request. A draft the pupil is typing survives
// unless the revision it was based on has been superseded (§13).
//
// Untracked because `replace` reads the list it is replacing — to tell whether
// the open artifact gained a revision — and an effect that depends on what it
// writes re-runs itself forever.
$effect(() => {
  const next = data.artifacts;
  const conversationId = data.conversation?.id ?? null;
  // The conversation is named so that switching threads re-seeds rather than
  // reading a different conversation's artifacts as things just written (§13).
  untrack(() => artifacts.replace(next, conversationId));
});

// A turn was still streaming when this tab loaded: replay the buffer and tail
// the live turn — the same endpoint whether it is live or already finished (§10).
//
// `consumedTurnId` breaks the invalidateAll → data refresh → re-fire loop: once
// we've begun consuming a turn, the effect does not start a second consumer even
// though `data.resumeTurnId` may return the same value after invalidateAll.
$effect(() => {
  const turnId = data.resumeTurnId;
  if (!turnId || turnId === consumedTurnId || conversation.turn.streaming) return;

  consumedTurnId = turnId;
  conversation.turn.resume(turnId, -1);
  void consume(`/api/turns/${turnId}/events?after=-1`, { method: "GET" });
});

/** Active fetch controller — cancelled when the student presses Stop. */
let consumeController: AbortController | null = null;

// Stop was pressed before the response delivered the turn id. We cannot abort a
// turn we cannot name — and the turn is already running on the server the moment
// the POST handler starts it — so we do not cancel the fetch yet: we record the
// intent and issue the abort the instant the id header arrives.
let abortRequested = false;

/** Read an SSE endpoint into the streaming-turn container. */
async function consume(url: string, init: RequestInit): Promise<void> {
  consumeController = new AbortController();
  try {
    const response = await fetch(url, { ...init, signal: consumeController.signal });

    if (response.status === 409) {
      refusal = m.chat_turn_in_flight();
      conversation.turn.detach();
      return;
    }
    if (response.status === 403) {
      // The server refused this turn — locked, out of hours, an alias the class
      // may not use, or an exhausted allowance. A friendly sentence, chosen
      // from a code: no server string is ever shown to a pupil (§8, §10, §21).
      const body = await response.json().catch(() => null);
      refusal = refusalMessage(body?.error);
      conversation.turn.detach();
      await invalidateAll();
      return;
    }
    if (!response.ok) {
      conversation.turn.apply({ type: "error", message: "unavailable" }, Number.MAX_SAFE_INTEGER);
      conversation.turn.detach();
      return;
    }

    // Extract the real turn ID so abort can target it (replaces the "pending" placeholder).
    const headerTurnId = response.headers.get("x-setun-turn-id");
    if (headerTurnId) {
      conversation.turn.turnId = headerTurnId;
      // Stop was pressed while the id was still "pending": now that we can name
      // the turn, tell the server to stop it and drop the local stream. Without
      // this the detached server turn would run to completion and the
      // invalidateAll below would resume it.
      if (abortRequested) {
        abortRequested = false;
        // Await the abort before returning: the finally below runs
        // invalidateAll, and if the server had not yet marked the turn stopped
        // the reload would report it as resumable and the resume effect would
        // reconnect to the very turn we just stopped.
        await fetch(`/api/turns/${headerTurnId}/abort`, { method: "POST" });
        consumeController?.abort();
        return;
      }
    }

    for await (const { seq, event } of readEventStream(response, consumeController.signal)) {
      conversation.turn.apply(event, seq);
    }
  } catch {
    // The connection dropped or was aborted. The turn keeps running on the
    // server and stays resumable, so this is not an error the student needs
    // to see (§10).
    conversation.turn.detach();
  } finally {
    consumeController = null;
    // Pick up the persisted assistant message, the generated title and the new
    // active leaf in one round trip.
    conversation.turn.clear();
    await invalidateAll();
  }
}

/**
 * The mint already in flight, so simultaneous callers join one rather than each
 * starting their own (§10).
 *
 * A pupil who picks three files at once calls `attach` three times before any of
 * them has awaited anything, so without this all three would pass the
 * `conversation.id` check below and create a conversation of their own. The
 * uploads would then name three different conversations — only the last of which
 * the composer writes into — so two attachments would be missing from the message
 * they were picked for and left holding conversations nobody is in.
 */
let minting: Promise<string | null> | null = null;

/**
 * The conversation this composer writes into, minting one if there is none (§10).
 *
 * A pupil's very first visit has no conversation, and the empty state offers
 * three things to ask for. The conversation is a container the pupil never asked
 * for, so it is created when they first need one rather than made a step they
 * must take.
 *
 * Still lazy: arriving and leaving without typing mints nothing.
 *
 * Returns null when the server refuses — closed, out of hours, or no allowlisted
 * alias — with the refusal already on screen. Hiding the composer was never the
 * control; this endpoint applies the same guard the send path does (§8, §21).
 */
async function ensureConversation(): Promise<string | null> {
  if (conversation.id) return conversation.id;

  minting ??= mintConversation();
  try {
    return await minting;
  } finally {
    // Cleared either way. A refusal is this attempt's answer, not the answer
    // every later attempt is handed back.
    minting = null;
  }
}

/** The request itself; `ensureConversation` is what decides whether to make one. */
async function mintConversation(): Promise<string | null> {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(selectedAliasId ? { modelAliasId: selectedAliasId } : {}),
  }).catch(() => null);

  if (!response?.ok) {
    const payload = await response?.json().catch(() => null);
    refusal = refusalMessage(payload?.error);
    return null;
  }

  const { id } = (await response.json()) as { id: string };
  conversation.id = id;
  // `adopt`, not `attach`: the draft on screen is what we are about to send, and
  // attaching would restore the (empty) draft of a conversation created a
  // moment ago and discard it.
  composer.adopt(id);

  // Name the conversation in the URL, without navigating, so a reload lands on
  // the thread the pupil is in rather than on whichever is newest.
  replaceState(`/chat?c=${id}`, page.state);
  return id;
}

async function send(): Promise<void> {
  refusal = null;
  const conversationId = await ensureConversation();
  if (!conversationId) return;

  const { text, editOfMessageId } = composer.take();
  if (!text) return;

  if (editOfMessageId) conversation.truncateFrom(editOfMessageId);
  conversation.appendUserMessage(
    text,
    composer.attachments.map((file) => ({
      type: "attachment" as const,
      attachmentId: file.id,
      kind: file.kind,
      filename: file.filename,
      mediaType: file.mediaType,
    })),
  );
  abortRequested = false;
  conversation.turn.begin("pending");

  await consume("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      text,
      ...(editOfMessageId ? { editOfMessageId } : {}),
    }),
  });
}

/**
 * Ask the same question again, and keep the first answer (§10).
 *
 * There was no way to a different answer but rewriting the question, and a
 * pupil who rewrote it lost the wording that had produced the answer they were
 * comparing against.
 *
 * The prompt is re-sent as a sibling of itself — the same branching an edit
 * performs, with the text unchanged — so the previous answer is not overwritten
 * but moved onto a branch the picker steps back to. That is the only shape the
 * message tree has for "two answers to one question", and it is the shape §10
 * already describes.
 *
 * The prompt is the message above this one on the active path, which is what
 * `parentId` says on the server; the client is handed the path in order and
 * reads it from there rather than carrying a second copy of the tree.
 */
async function regenerate(assistant: ChatMessageData): Promise<void> {
  if (conversation.turn.streaming) return;

  const index = conversation.messages.findIndex((message) => message.id === assistant.id);
  const prompt = conversation.messages
    .slice(0, index)
    .findLast((message) => message.role === "user");

  const text = prompt ? textOf(prompt) : "";
  if (!prompt || !text) return;

  composer.beginEdit(prompt.id, text);
  await send();
}

/**
 * Answer a question the running turn asked (§11).
 *
 * The turn is running detached from the request that started it, so the answer
 * goes to its own endpoint rather than back up the stream that asked.
 */
async function respond(body: Record<string, unknown>): Promise<void> {
  const turnId = conversation.turn.turnId;
  if (!turnId || turnId === "pending") return;

  await fetch(`/api/turns/${turnId}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    // The turn will time the question out on its own and continue without the
    // tool, so a failed answer is not something to interrupt a pupil with (§11).
  });
}

/** Upload one file as the pupil picks it, so the send carries only identifiers (§10). */
async function attach(file: File): Promise<void> {
  refusal = null;
  const conversationId = await ensureConversation();
  if (!conversationId) return;

  const body = new FormData();
  body.set("file", file);
  body.set("conversationId", conversationId);

  const response = await fetch("/api/attachments", { method: "POST", body }).catch(() => null);

  if (!response?.ok) {
    const payload = await response?.json().catch(() => null);
    refusal = attachmentRefusalMessage(payload?.error);
    return;
  }

  composer.addAttachment(await response.json());
}

async function detach(attachmentId: string): Promise<void> {
  await fetch(`/api/attachments/${attachmentId}`, { method: "DELETE" }).catch(() => null);
  composer.removeAttachment(attachmentId);
}

/**
 * The composer's explicit image mode (§15).
 *
 * The second trigger path: it converges on the same server-side execution the
 * agent loop's tool reaches, so there is nothing to do here but ask and reload.
 */
async function generateImage(): Promise<void> {
  refusal = null;
  const conversationId = await ensureConversation();
  if (!conversationId) return;

  const { text } = composer.take();
  if (!text) return;

  generating = true;
  try {
    const response = await fetch("/api/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, prompt: text }),
    }).catch(() => null);

    if (!response?.ok) {
      const payload = await response?.json().catch(() => null);
      refusal =
        response?.status === 403
          ? refusalMessage(payload?.error)
          : imageRefusalMessage(payload?.error);
      return;
    }

    await invalidateAll();
  } finally {
    generating = false;
  }
}

/**
 * Step to a sibling variant of a branched message (§10).
 *
 * The server moves the conversation's active leaf to the tip of the chosen
 * branch; invalidateAll then re-renders the whole branch — messages, artifacts
 * and the branch picker's own position — in one round trip. Not while a turn is
 * streaming: the leaf is about to move on its own.
 */
async function switchBranch(messageId: string): Promise<void> {
  const conversationId = conversation.id;
  if (!conversationId || conversation.turn.streaming) return;

  const response = await fetch(`/api/conversations/${conversationId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ activeLeafOf: messageId }),
  });
  if (response.ok) await invalidateAll();
}

/**
 * Delete one of the pupil's own conversations (§16).
 *
 * "Students see only their own conversations", and what they can see they can
 * remove: the endpoint is owner-scoped in SQL and cascades to messages, turns,
 * buffered events and the search index, so nothing is left searchable by nobody.
 * The drawer asks before calling this.
 *
 * Deleting the conversation on screen leaves nothing to show, so the page starts
 * fresh rather than silently jumping to a neighbouring thread.
 */
async function deleteConversation(conversationId: string): Promise<void> {
  const response = await fetch(`/api/conversations/${conversationId}`, {
    method: "DELETE",
  }).catch(() => null);

  if (!response?.ok) {
    refusal = m.chat_refusal_unavailable();
    return;
  }

  if (conversationId === conversation.id) {
    // Nothing left to show on this page; the load falls back to the newest
    // conversation the pupil still has, or to an empty composer if none remain.
    await goto("/chat", { invalidateAll: true, noScroll: true });
    return;
  }
  await invalidateAll();
}

/**
 * Open an artifact from its card in the transcript (§13, §20).
 *
 * The pupil's route from "here is the page" to the page is one tap, and tapping
 * the card of the artifact already on screen puts the conversation back — the
 * card is the same control both ways round, which is what a pupil expects of a
 * thing that says "Showing".
 *
 * An artifact the conversation no longer holds — deleted from the gallery, or on
 * a branch that is not on screen — simply does nothing.
 *
 * Selecting while the pupil is typing into that very artifact would throw the
 * draft away, so re-selecting what is already open only brings it forward.
 */
function openArtifact(artifactId: string): void {
  if (!artifacts.items.some((item) => item.id === artifactId)) return;

  if (artifacts.visible && artifacts.openId === artifactId) {
    artifacts.hide();
    return;
  }

  if (artifacts.openId === artifactId) {
    artifacts.reveal();
    return;
  }

  artifacts.select(artifactId);
}

/**
 * Hand a failure back to the model (§13).
 *
 * The error is already recorded against the version by the time this is
 * reachable, so the next turn's prompt states it; this only puts the sentence in
 * the composer and puts the caret in it. Nothing has to be closed first — the
 * composer is beside the error rather than underneath it.
 */
async function askForHelp(status: BuildStatus): Promise<void> {
  // A question, sent now, as text. An edit in progress would send it as a
  // sibling of some earlier prompt, and image mode would draw the sentence
  // instead of answering it (§10, §15).
  composer.editingMessageId = null;
  composer.mode = "text";
  // The pupil's sentence has to match the note the model is given beside it: a
  // page that mounted and then threw did run, and saying otherwise asks for a
  // rewrite of a file that nearly works.
  composer.setDraft(status === "threw" ? m.artifact_fix_request_threw() : m.artifact_fix_request());
  // The conversation has to be on screen for the composer to be reachable — and
  // it is only on screen after the update that reveals it, so the caret waits
  // for that. Focusing a textarea inside a `hidden` pane does nothing at all.
  if (artifacts.stage === "build") {
    artifacts.setStage("both");
    await tick();
  }
  composerRef?.focus();
}

function pickStarter(starter: { text: string; mode: "text" | "image" }): void {
  composer.mode = starter.mode;
  composer.setDraft(starter.text);
  composerRef?.focus();
}

function setStage(stage: WorkspaceStage): void {
  artifacts.setStage(stage);
}

/**
 * "Keep going" on the warning banner (§10).
 *
 * Answers the checkpoint before the loop reaches it, so the turn runs on rather
 * than pausing at the next boundary to ask what the pupil has already said.
 */
async function keepGoing(): Promise<void> {
  const warning = conversation.turn.budgetWarning;
  if (!warning) return;

  conversation.turn.acknowledgeWarning();
  await respond({ requestId: warning.requestId, kind: "continue", proceed: true });
}

async function abort(): Promise<void> {
  const turnId = conversation.turn.turnId;

  // The id has arrived: tell the server to stop, then drop the local stream.
  if (turnId && turnId !== "pending") {
    abortRequested = false;
    consumeController?.abort();
    await fetch(`/api/turns/${turnId}/abort`, { method: "POST" });
    return;
  }

  // Still "pending" — the response header has not delivered the turn id yet
  // (the server is preparing the turn, e.g. resolving tools). Record the intent
  // and let the fetch continue; `consume` fires the abort the moment the id
  // header lands. Cancelling the fetch here would lose the header and orphan a
  // turn that is already running server-side — the bug this replaces.
  abortRequested = true;
}
</script>

<svelte:head><title>{m.chat_title()} · {m.app_name()}</title></svelte:head>

<ConversationDrawer
  conversations={data.conversations}
  activeId={data.conversation?.id ?? null}
  open={drawerOpen}
  onclose={() => (drawerOpen = false)}
  ondelete={deleteConversation}
  thinkingChoice={thinkingChoiceAvailable(data.thinkingVisibility)}
>
  {#snippet actions()}
    <!--
      Starting a thread, and the model it will use (§9).

      A form action, so it works with JavaScript off; the same value is sent when
      a conversation is minted by the first message instead. The picker appears
      only where the educator has allowlisted more than one alias — a control
      with one option decides nothing.
    -->
    <form method="POST" action="?/create" use:enhance class="flex flex-col gap-2">
      {#if data.aliases.length > 1}
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.chat_model_label()}</span>
          <select
            name="modelAliasId"
            bind:value={selectedAliasId}
            class="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {#each data.aliases as alias (alias.id)}
              <option value={alias.id}>{alias.name}</option>
            {/each}
          </select>
        </label>
      {/if}

      <button
        type="submit"
        class="flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus size={16} aria-hidden="true" />
        {m.chat_new_conversation()}
      </button>
    </form>
  {/snippet}

  {#snippet footer()}
    <a
      href="/creations"
      class="flex min-h-11 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {m.creations_link()}
    </a>
    <a
      href="/skills"
      class="flex min-h-11 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {m.student_skills_link()}
    </a>
    <form method="POST" action="?/logout" use:enhance>
      <button
        type="submit"
        class="flex min-h-11 w-full items-center rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {m.chat_sign_out()}
      </button>
    </form>
  {/snippet}
</ConversationDrawer>

<!--
  Sized to the visual viewport rather than to `100svh`, so the on-screen keyboard
  in tablet mode pushes the composer up instead of covering it (§20).
-->
<div class="flex h-svh flex-col bg-background" {@attach fitVisualViewport}>
  <ChatHeader
    title={conversation.title ?? m.chat_untitled_conversation()}
    {drawerOpen}
    ondrawer={() => (drawerOpen = true)}
    allowance={status.allowance}
    stage={artifacts.stage}
    {axis}
    unseen={artifacts.unseen !== null}
    buildCount={artifacts.items.length}
    onstage={setStage}
  />

  {#if !status.open}
    <!--
      Closed: the status screen replaces the workspace entirely (§8). Hiding the
      composer is a courtesy, not the control — every send is refused by the
      server whether or not this tab ever heard about the lock (§21).
    -->
    <ClassroomClosed {status} />
  {:else}
    <WorkspaceShell workspace={artifacts} {axis}>
      {#snippet chat()}
        <Transcript
          {conversation}
          conversationId={data.conversation?.id ?? null}
          activeArtifactId={artifacts.visible ? artifacts.openId : null}
          onedit={(target) => composer.beginEdit(target.id, target.text)}
          onregenerate={regenerate}
          onswitch={switchBranch}
          onopenartifact={openArtifact}
          {showThinking}
        >
          {#snippet empty()}
            <ConversationStarters
              imageModeAvailable={data.imageModeAvailable}
              onpick={pickStarter}
            />
          {/snippet}

          {#snippet footer()}
            <!--
              The turn's only interactive parts. Rendered inline in the
              conversation rather than as a dialog: on a 640-pixel screen a modal
              covers the answer the pupil is deciding about (§11, §20).
            -->
            {#if conversation.turn.permission}
              {#key conversation.turn.permission.toolCallId}
                <PermissionPrompt
                  permission={conversation.turn.permission}
                  onrespond={(approved) =>
  respond({
    requestId: conversation.turn.permission?.toolCallId,
    kind: "permission",
    approved,
  })}
                />
              {/key}
            {/if}

            {#if conversation.turn.elicitation}
              {#key conversation.turn.elicitation.toolCallId}
                <ElicitationForm
                  elicitation={conversation.turn.elicitation}
                  onrespond={(answer) =>
  respond({
    requestId: conversation.turn.elicitation?.toolCallId,
    kind: "elicitation",
    ...answer,
  })}
                />
              {/key}
            {/if}

            {#if conversation.turn.continuePrompt}
              {#key conversation.turn.continuePrompt.requestId}
                <ContinuePrompt
                  prompt={conversation.turn.continuePrompt}
                  onrespond={(proceed) => {
  if (proceed) conversation.turn.acknowledgeWarning();
  void respond({
    requestId: conversation.turn.continuePrompt?.requestId,
    kind: "continue",
    proceed,
  });
}}
                />
              {/key}
            {/if}

            {#if conversation.turn.budgetWarning}
              <!--
                Shown while the answer keeps arriving: the allowance is the
                pupil's day, and a response in flight is never cut for it (§10).
              -->
              <BudgetWarning
                warning={conversation.turn.budgetWarning}
                streaming={conversation.turn.streaming && !conversation.turn.continuePrompt}
                onkeepgoing={keepGoing}
                onstop={abort}
              />
            {/if}

            {#if generating}
              <p class="text-center text-xs text-muted-foreground" role="status">
                {m.chat_image_generating()}
              </p>
            {/if}
          {/snippet}
        </Transcript>

        {#if refusal}
          <!--
            Beside the control it is about, rather than at the end of a transcript
            the pupil may have scrolled away from (§8, §10).
          -->
          <div class="shrink-0 px-3 pt-2">
            <p
              class="mx-auto max-w-2xl rounded-lg border border-border bg-secondary px-3 py-2 text-xs text-secondary-foreground"
              role="status"
            >
              {refusal}
            </p>
          </div>
        {/if}

        <!--
          Always present, including on a pupil's very first visit: the conversation
          it needs is minted on the first send rather than demanded of the pupil
          first (§10). The drawer keeps its own *New conversation* control, which
          is the affordance that still works with JavaScript off.
        -->
        <Composer
          bind:this={composerRef}
          {composer}
          streaming={conversation.turn.streaming || generating}
          attachmentsEnabled={data.attachmentsEnabled}
          imageModeAvailable={data.imageModeAvailable}
          modelName={data.aliases.length > 1 ? (activeAlias?.name ?? null) : null}
          onsend={() => (composer.mode === "image" ? generateImage() : send())}
          onabort={abort}
          onattach={attach}
          ondetach={detach}
        />
      {/snippet}

      {#snippet build()}
        <ArtifactPanel
          workspace={artifacts}
          sandboxOrigin={data.sandboxOrigin}
          onaskforhelp={(status) => void askForHelp(status)}
        />
      {/snippet}
    </WorkspaceShell>
  {/if}
</div>
