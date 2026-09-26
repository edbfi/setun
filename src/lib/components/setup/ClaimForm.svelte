<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";
import { formatClaimTime, setupErrorMessage } from "./labels";

/**
 * Step 0 — proving host access (PRD §6.2, §7, §21).
 *
 * Two ways in, and they are not equivalent. The bootstrap token proves you can
 * read the server's console, which is the only thing that distinguishes the
 * operator from a passer-by before an account exists. The credential form below
 * it appears only once an account *does* exist, and is the way back in when the
 * token has lapsed and the claim cookie is gone.
 *
 * A claim held by another browser is a screen, not a dead end: the notice says
 * when it lapses, and the form stays where it is so the page works again the
 * moment it does.
 */

interface Props {
  /** Failure code from the last attempt, or null. */
  error: string | null;
  /** When a live claim lapses, ISO, or null when nobody holds one. */
  retryAt: string | null;
  heldElsewhere: boolean;
  /** Recovery is only offered once there is a credential to recover with. */
  canRecover: boolean;
}

let { error, retryAt, heldElsewhere, canRecover }: Props = $props();

const message = $derived(setupErrorMessage(error));
const field = "h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground";
const button =
  "h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90";
</script>

<div class="flex flex-col gap-6">
  {#if heldElsewhere}
    <div class="flex flex-col gap-1.5 rounded-md border border-border bg-secondary/40 p-4">
      <h2 class="text-sm font-medium text-foreground">{m.setup_claim_held_title()}</h2>
      <p class="text-sm text-muted-foreground">{m.setup_claim_held_body()}</p>
      {#if retryAt}
        <p class="text-sm text-foreground">
          {m.setup_claim_retry_at({ time: formatClaimTime(retryAt) })}
        </p>
      {/if}
    </div>
  {/if}

  <section class="flex flex-col gap-3">
    <h2 class="text-sm font-medium text-foreground">{m.setup_claim_title()}</h2>
    <p class="text-sm text-muted-foreground">{m.setup_claim_intro()}</p>

    <form method="POST" action="?/claim" use:enhance class="flex flex-col gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.setup_claim_token_label()}</span>
        <input
          name="token"
          type="text"
          autocomplete="off"
          spellcheck="false"
          required
          class="{field} font-mono tracking-[0.08em]"
        >
      </label>

      {#if message}
        <p class="text-sm text-destructive" role="alert">{message}</p>
      {/if}

      <button type="submit" class={button}>{m.setup_claim_submit()}</button>
    </form>

    <p class="text-xs text-muted-foreground">{m.setup_claim_where()}</p>
  </section>

  {#if canRecover}
    <section class="flex flex-col gap-3 border-t border-border pt-6">
      <h2 class="text-sm font-medium text-foreground">{m.setup_recover_title()}</h2>
      <p class="text-sm text-muted-foreground">{m.setup_recover_intro()}</p>

      <form method="POST" action="?/recover" use:enhance class="flex flex-col gap-3">
        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-foreground">{m.educator_username_label()}</span>
          <input name="username" type="text" autocomplete="username" required class={field}>
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-foreground">{m.educator_password_label()}</span>
          <input
            name="password"
            type="password"
            autocomplete="current-password"
            required
            class={field}
          >
        </label>

        <button
          type="submit"
          class="h-10 rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
        >
          {m.setup_recover_submit()}
        </button>
      </form>
    </section>
  {/if}
</div>
