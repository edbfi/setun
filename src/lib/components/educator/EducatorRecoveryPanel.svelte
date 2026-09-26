<script lang="ts">
import { EDUCATOR_RECOVERY_COMMAND } from "$lib/educator-recovery";
import * as m from "$lib/paraglide/messages";

let copyState = $state<"idle" | "copied" | "failed">("idle");

async function copyCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(EDUCATOR_RECOVERY_COMMAND);
    copyState = "copied";
  } catch {
    copyState = "failed";
  }
}
</script>

<details class="rounded-md border border-border bg-muted/30 px-4 py-3">
  <summary class="cursor-pointer text-sm font-medium text-foreground marker:text-muted-foreground">
    {m.educator_recovery_action()}
  </summary>

  <div class="mt-3 flex flex-col gap-3 border-t border-border pt-3">
    <div class="flex flex-col gap-1">
      <h2 class="text-sm font-semibold text-foreground">{m.educator_recovery_title()}</h2>
      <p class="text-sm text-muted-foreground">{m.educator_recovery_intro()}</p>
    </div>

    <p class="text-sm text-muted-foreground">{m.educator_recovery_command_intro()}</p>
    <div class="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <code class="select-all break-all font-mono text-xs text-foreground">
        {EDUCATOR_RECOVERY_COMMAND}
      </code>
      <button
        type="button"
        onclick={copyCommand}
        class="h-8 self-start rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground hover:bg-muted"
      >
        {m.educator_recovery_copy()}
      </button>
    </div>

    {#if copyState === "copied"}
      <p class="text-xs text-muted-foreground" role="status">
        {m.educator_recovery_copied()}
      </p>
    {:else if copyState === "failed"}
      <p class="text-xs text-destructive" role="alert">
        {m.educator_recovery_copy_failed()}
      </p>
    {/if}

    <p class="text-xs text-muted-foreground">{m.educator_recovery_effect()}</p>
  </div>
</details>
