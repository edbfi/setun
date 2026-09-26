<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";

/**
 * Which tools a class may use (PRD §11).
 *
 * "It toggles configured servers and selects which individual tools are exposed
 * per classroom." This is the second half — the per-classroom selection, grouped
 * by the server the tools came from, because that is the attribution a pupil
 * will see when one of them asks to run.
 *
 * A tool switched off installation-wide is shown but not selectable: an educator
 * looking for it should find it and learn where the switch is, rather than find
 * nothing.
 */

interface ToolRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  sensitive: boolean;
  allowed: boolean;
}

interface ServerRow {
  id: string;
  label: string;
  enabled: boolean;
  tools: ToolRow[];
}

interface Props {
  servers: ServerRow[];
}

let { servers }: Props = $props();

const button =
  "h-8 shrink-0 rounded-md border border-input px-3 text-xs font-medium text-foreground hover:bg-secondary";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_tool_allowlist_title()}</h2>

  {#if servers.length === 0}
    <p class="text-xs text-muted-foreground">{m.educator_tool_allowlist_empty()}</p>
  {/if}

  {#each servers as server (server.id)}
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted-foreground">{server.label}</span>

      <ul class="flex flex-col gap-1">
        {#each server.tools as tool (tool.id)}
          <li
            class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
          >
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="flex items-center gap-2">
                <span class="truncate text-sm text-foreground">{tool.name}</span>
                {#if tool.sensitive}
                  <span
                    class="rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground"
                  >
                    {m.educator_tool_sensitive()}
                  </span>
                {/if}
              </span>
              {#if !tool.enabled || !server.enabled}
                <span class="text-xs text-muted-foreground"
                  >{m.educator_tool_disabled_notice()}</span
                >
              {:else if tool.description}
                <span class="truncate text-xs text-muted-foreground">{tool.description}</span>
              {/if}
            </div>

            <form
              method="POST"
              action={tool.allowed ? "?/disallowTool" : "?/allowTool"}
              use:enhance
            >
              <input type="hidden" name="mcpToolId" value={tool.id}>
              <button
                type="submit"
                disabled={!tool.enabled || !server.enabled}
                class={[
  button,
  { "bg-primary text-primary-foreground hover:bg-primary/90": tool.allowed },
  "disabled:opacity-50",
]}
              >
                {tool.allowed ? m.educator_allowlist_disallow() : m.educator_allowlist_allow()}
              </button>
            </form>
          </li>
        {/each}
      </ul>
    </div>
  {/each}
</section>
