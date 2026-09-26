<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import FieldError from "$lib/components/ui/FieldError.svelte";
import * as m from "$lib/paraglide/messages";
import type { SetupEducatorSchema } from "$lib/server/setup/schemas";
import { setupFieldError } from "./labels";

/**
 * Step 1 — the operator account (PRD §7).
 *
 * The one credential in Setun with no reset path: "there is no in-application
 * password recovery — a forgotten educator password is reset by re-seeding the
 * credential in deployment configuration and restarting". The intro says so
 * plainly, and the confirmation field exists because a password typed wrong
 * twice is the failure mode that sentence describes.
 *
 * The step is not rendered at all when the account comes from deployment
 * configuration; the server refuses it independently.
 */

type EducatorData = v.InferOutput<typeof SetupEducatorSchema>;

interface Props {
  data: SuperValidated<EducatorData>;
  /** The server's own floor, handed down rather than restated here. */
  minLength: number;
}

let { data, minLength }: Props = $props();

/**
 * The hint is described rather than labelled.
 *
 * A hint inside the `<label>` element becomes part of the field's accessible
 * name — "Password At least 12 characters." — which is what a screen reader
 * announces on focus and what a test looks the field up by. `aria-describedby`
 * keeps it associated without making it the name.
 */
const hintId = $props.id();

// Superforms captures the initial page data and keeps itself in sync internally.
// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, { id: "setup-educator" });

const field = "h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.setup_educator_title()}</h2>
  <p class="text-sm text-muted-foreground">{m.setup_educator_intro()}</p>

  <form method="POST" action="?/educator" use:enhance class="flex flex-col gap-3">
    {#if setupFieldError($errors._errors)}
      <FieldError message={setupFieldError($errors._errors)} size="sm" />
    {/if}

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_username_label()}</span>
      <input
        name="username"
        type="text"
        autocomplete="username"
        bind:value={$form.username}
        class={field}
      >
      <FieldError message={$errors.username} />
    </label>

    <div class="flex flex-col gap-1.5">
      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_password_label()}</span>
        <input
          name="password"
          type="password"
          autocomplete="new-password"
          aria-describedby={hintId}
          bind:value={$form.password}
          class={field}
        >
      </label>
      <span id={hintId} class="text-xs text-muted-foreground">
        {m.setup_educator_password_hint({ min: minLength })}
      </span>
      <FieldError message={$errors.password} />
    </div>

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.setup_confirm_password_label()}</span>
      <input
        name="confirmPassword"
        type="password"
        autocomplete="new-password"
        bind:value={$form.confirmPassword}
        class={field}
      >
      <FieldError message={$errors.confirmPassword} />
    </label>

    <button
      type="submit"
      disabled={$submitting}
      class="h-10 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
    >
      {m.setup_educator_submit()}
    </button>
  </form>
</section>
