<script lang="ts">
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import Image from "@lucide/svelte/icons/image";
import Paperclip from "@lucide/svelte/icons/paperclip";
import Square from "@lucide/svelte/icons/square";
import X from "@lucide/svelte/icons/x";
import * as m from "$lib/paraglide/messages";
import type { ComposerState } from "$lib/state/composer.svelte";

/**
 * The message composer (PRD §10, §15, §20).
 *
 * One surface rather than a row of separate boxes: the attachments a message
 * carries, the words, and the controls that decide what pressing send does all
 * belong to the same message, and drawing them as one bordered field says so.
 * Touch-sized targets throughout, because the target hardware is a touchscreen
 * convertible where the on-screen keyboard occupies half the usable height.
 *
 * Two controls sit beside the text rather than behind a menu: attaching a file,
 * and the explicit image mode of §15. Image mode changes what the send button
 * does, so it changes the placeholder and the button's own name — a mode the
 * pupil cannot see they are in is a mode they will be surprised by.
 */
interface Props {
  composer: ComposerState;
  streaming: boolean;
  /** Absent when the classroom allows no attachments, or the alias takes none (§10). */
  attachmentsEnabled?: boolean;
  /** Present only where a generation-capable alias is allowlisted (§15). */
  imageModeAvailable?: boolean;
  /**
   * The friendly name of the model answering in this conversation (§9).
   *
   * Shown, never chosen here: an alias is bound to a conversation when it is
   * created, so the choice belongs beside *New conversation* and this is the
   * label that says which one it was. Only the friendly name ever appears — the
   * gateway identifier behind it reaches no pupil's browser (§9, §21).
   */
  modelName?: string | null;
  onsend: () => void;
  onabort: () => void;
  onattach?: (file: File) => void;
  ondetach?: (attachmentId: string) => void;
}

let {
  composer,
  streaming,
  attachmentsEnabled = false,
  imageModeAvailable = false,
  modelName = null,
  onsend,
  onabort,
  onattach,
  ondetach,
}: Props = $props();

let textarea = $state<HTMLTextAreaElement | null>(null);
let filePicker = $state<HTMLInputElement | null>(null);

const isImageMode = $derived(composer.mode === "image");
const sendLabel = $derived(isImageMode ? m.chat_image_mode() : m.chat_send());

/** Put the caret where the pupil is about to type. Called by the page. */
export function focus(): void {
  textarea?.focus();
}

function pickFiles(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  for (const file of input.files ?? []) onattach?.(file);
  // Reset, so choosing the same file twice in a row still fires a change.
  input.value = "";
}

function submit(event: SubmitEvent) {
  event.preventDefault();
  if (composer.canSend && !streaming) onsend();
}

/**
 * Enter sends, Shift+Enter breaks the line.
 *
 * Not applied while the IME is composing: on a Danish keyboard, dead-key
 * accents would otherwise send the message mid-character.
 */
function onkeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;

  event.preventDefault();
  if (composer.canSend && !streaming) onsend();
}

// Grow with the content up to a ceiling, so the latest message stays visible
// above the on-screen keyboard (§20).
$effect(() => {
  const element = textarea;
  if (!element) return;

  // Read the draft so this re-runs as it changes.
  composer.draft;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
});

/**
 * The composer's controls, at the size a finger needs (§20).
 *
 * `size-11` is 44 pixels. The target device is a touchscreen convertible and
 * these are the most-pressed controls on the route, so they keep the touch
 * target the rest of the interface uses rather than the smaller one the icons
 * alone would need.
 */
const iconButton =
  "grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
</script>

<form class="shrink-0 bg-background px-3 pb-3 pt-1" onsubmit={submit}>
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-1.5">
    {#if composer.isEditing}
      <div
        class="flex items-center justify-between gap-2 rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-xs text-muted-foreground"
      >
        <span>{m.chat_editing_notice()}</span>
        <button
          type="button"
          class="shrink-0 rounded px-1 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onclick={() => composer.cancelEdit()}
        >
          {m.chat_cancel_edit()}
        </button>
      </div>
    {/if}

    <div
      class="flex flex-col rounded-2xl border border-input bg-card shadow-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/40 motion-safe:transition-colors"
    >
      {#if composer.attachments.length > 0}
        <ul class="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
          {#each composer.attachments as file (file.id)}
            <li
              class="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary py-1 pl-2 pr-1 text-xs"
            >
              <span class="truncate">{file.filename}</span>
              <button
                type="button"
                onclick={() => ondetach?.(file.id)}
                aria-label={m.chat_attachment_remove({ filename: file.filename })}
                class="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      <textarea
        bind:this={textarea}
        value={composer.draft}
        oninput={(event) => composer.setDraft(event.currentTarget.value)}
        {onkeydown}
        rows="1"
        placeholder={isImageMode ? m.chat_image_placeholder() : m.chat_composer_placeholder()}
        aria-label={m.chat_composer_label()}
        class="max-h-50 min-h-11 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[0.9375rem] leading-relaxed text-card-foreground outline-none placeholder:text-muted-foreground"
      ></textarea>

      <div class="flex items-center gap-1 px-2 pb-2">
        {#if attachmentsEnabled}
          <input
            bind:this={filePicker}
            type="file"
            multiple
            class="sr-only"
            onchange={pickFiles}
            aria-hidden="true"
            tabindex="-1"
          >
          <button
            type="button"
            onclick={() => filePicker?.click()}
            aria-label={m.chat_attachment_add()}
            title={m.chat_attachment_add()}
            class={iconButton}
          >
            <Paperclip size={17} aria-hidden="true" />
          </button>
        {/if}

        {#if imageModeAvailable}
          <button
            type="button"
            onclick={() => composer.toggleMode()}
            aria-pressed={isImageMode}
            aria-label={isImageMode ? m.chat_image_mode_off() : m.chat_image_mode()}
            title={isImageMode ? m.chat_image_mode_off() : m.chat_image_mode()}
            class={[iconButton, isImageMode && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"]}
          >
            <Image size={17} aria-hidden="true" />
          </button>
        {/if}

        {#if modelName}
          <!-- Which model is answering. The machine layer, so the mono face (§9). -->
          <span
            class="ml-1 hidden min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground sm:inline"
          >
            {m.chat_model_in_use({ model: modelName })}
          </span>
        {/if}

        {#if streaming}
          <button
            type="button"
            onclick={onabort}
            aria-label={m.chat_stop()}
            class="ml-auto grid size-11 shrink-0 place-items-center rounded-full border border-input text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Square size={13} fill="currentColor" aria-hidden="true" />
          </button>
        {:else}
          <button
            type="submit"
            disabled={!composer.canSend}
            aria-label={sendLabel}
            title={sendLabel}
            class="ml-auto grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-opacity"
          >
            {#if isImageMode}
              <Image size={17} aria-hidden="true" />
            {:else}
              <ArrowUp size={18} aria-hidden="true" />
            {/if}
          </button>
        {/if}
      </div>
    </div>
  </div>
</form>
