<script lang="ts">
import { enhance } from "$app/forms";
import * as Dialog from "$lib/components/ui/dialog";
import * as m from "$lib/paraglide/messages";

/**
 * Which models a classroom may use (PRD §8, §9, §16).
 *
 * "The panel displays this flag wherever aliases are allowlisted, and enabling a
 * no-DPA alias for a classroom requires an explicit confirmation that states
 * plainly what it means."
 *
 * So the flag is a badge on every row — not something an educator has to open
 * anything to see — and a model without an agreement routes through the dialog
 * below, whose body says what the choice means in the words §16 uses rather than
 * a generic "are you sure".
 *
 * The dialog is a courtesy, not the control. The server refuses the allowlisting
 * without the confirmation field regardless of what this component does (§16, §21).
 */

interface AliasRow {
  id: string;
  name: string;
  available: boolean;
  dataProtection: boolean;
  allowed: boolean;
}

interface Props {
  aliases: AliasRow[];
}

let { aliases }: Props = $props();

/** The alias awaiting confirmation, or null while no dialog is open. */
let confirming = $state<AliasRow | null>(null);

const open = $derived(confirming !== null);
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_allowlist_title()}</h2>

  {#if aliases.length === 0}
    <p class="text-xs text-muted-foreground">{m.educator_allowlist_empty()}</p>
  {:else}
    <ul class="flex flex-col divide-y divide-border border-y border-border">
      {#each aliases as alias (alias.id)}
        <li class="flex flex-wrap items-center justify-between gap-3 py-2.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm text-foreground">{alias.name}</span>
            <span
              class="shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium"
              class:bg-secondary={alias.dataProtection}
              class:text-secondary-foreground={alias.dataProtection}
              class:bg-destructive={!alias.dataProtection}
              class:text-destructive-foreground={!alias.dataProtection}
            >
              {alias.dataProtection ? m.educator_alias_dpa_badge() : m.educator_alias_no_dpa_badge()}
            </span>
          </div>

          {#if alias.allowed}
            <form method="POST" action="?/disallowAlias" use:enhance>
              <input type="hidden" name="modelAliasId" value={alias.id}>
              <button
                type="submit"
                class="h-8 rounded-md border border-input px-3 text-xs font-medium text-foreground hover:bg-secondary"
              >
                {m.educator_allowlist_disallow()}
              </button>
            </form>
          {:else if alias.dataProtection}
            <form method="POST" action="?/allowAlias" use:enhance>
              <input type="hidden" name="modelAliasId" value={alias.id}>
              <button
                type="submit"
                class="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                {m.educator_allowlist_allow()}
              </button>
            </form>
          {:else}
            <button
              type="button"
              onclick={() => {
  confirming = alias;
}}
              class="h-8 rounded-md border border-destructive px-3 text-xs font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground"
            >
              {m.educator_allowlist_allow()}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<Dialog.Root
  {open}
  onOpenChange={(next) => {
  if (!next) confirming = null;
}}
>
  <Dialog.Content class="max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{m.educator_no_dpa_confirm_title()}</Dialog.Title>
      <Dialog.Description>{m.educator_no_dpa_confirm_body()}</Dialog.Description>
    </Dialog.Header>

    <Dialog.Footer>
      <button
        type="button"
        onclick={() => {
  confirming = null;
}}
        class="h-9 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary"
      >
        {m.educator_no_dpa_confirm_cancel()}
      </button>

      <form
        method="POST"
        action="?/allowAlias"
        use:enhance={() => {
  return async ({ update }) => {
    confirming = null;
    await update();
  };
}}
      >
        <input type="hidden" name="modelAliasId" value={confirming?.id ?? ""}>
        <!-- The recorded acknowledgement §16 asks for, verified server-side. -->
        <input type="hidden" name="confirmNoDpa" value="on">
        <button
          type="submit"
          class="h-9 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
        >
          {m.educator_no_dpa_confirm_accept()}
        </button>
      </form>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
