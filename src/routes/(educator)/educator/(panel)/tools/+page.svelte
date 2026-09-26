<script lang="ts">
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * Configured servers and their tools (PRD §11, §17).
 *
 * A dense operator list, not a gallery: one row per server with what was
 * negotiated and whether it answered, and one row per tool with the two switches
 * an educator owns. Nothing here can point Setun at a new endpoint — that is a
 * security decision and lives in reviewable configuration (§11).
 */
let { data, form }: PageProps = $props();

const refreshed = $derived(form && "refreshed" in form ? (form.refreshed as number) : null);

const row = "flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2";
const toggle =
  "h-7 rounded-md border border-input px-2 text-xs font-medium text-foreground hover:bg-secondary";
</script>

<svelte:head><title>{m.educator_tools_title()} · {m.educator_panel_title()}</title></svelte:head>

<div class="flex max-w-4xl flex-col gap-6">
  <header class="flex flex-col gap-1">
    <h1 class="text-base font-semibold text-foreground">{m.educator_tools_title()}</h1>
    <p class="max-w-2xl text-xs text-muted-foreground">{m.educator_tools_intro()}</p>
  </header>

  {#if data.servers.length === 0}
    <p class="text-sm text-muted-foreground">{m.educator_mcp_no_servers()}</p>
  {:else}
    <form method="POST" action="?/refreshAll" use:enhance class="flex items-center gap-3">
      <button type="submit" class={toggle}>{m.educator_mcp_refresh_all()}</button>
      {#if refreshed !== null}
        <span class="text-xs text-muted-foreground" role="status">
          {m.educator_mcp_refreshed({ count: refreshed })}
        </span>
      {/if}
    </form>
  {/if}

  {#each data.servers as server (server.id)}
    <section class="flex flex-col gap-2">
      <div class={row}>
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-sm font-medium text-foreground">{server.label}</span>
          <span class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <code class="rounded bg-secondary px-1 py-0.5">{server.configKey}</code>
            <span>
              {server.negotiatedVersion
  ? m.educator_mcp_version({ version: server.negotiatedVersion })
  : m.educator_mcp_version_unknown()}
            </span>
            <span
              class={[
  "rounded px-1.5 py-0.5",
  {
    "bg-primary/10 text-primary": server.reachability === "reachable",
    "bg-destructive/10 text-destructive": server.reachability === "unreachable",
    "bg-secondary": server.reachability === "unknown",
  },
]}
            >
              {server.reachability === "reachable"
  ? m.educator_mcp_reachable()
  : server.reachability === "unreachable"
    ? m.educator_mcp_unreachable()
    : m.educator_mcp_unknown()}
            </span>
          </span>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          {#if server.configured}
            <form method="POST" action="?/refresh" use:enhance>
              <input type="hidden" name="serverId" value={server.id}>
              <button type="submit" class={toggle}>{m.educator_mcp_refresh()}</button>
            </form>
          {/if}
          <form method="POST" action="?/setServerEnabled" use:enhance>
            <input type="hidden" name="serverId" value={server.id}>
            <input type="hidden" name="enabled" value={server.enabled ? "false" : "true"}>
            <button
              type="submit"
              class={[toggle, { "bg-primary text-primary-foreground hover:bg-primary/90": server.enabled }]}
              aria-pressed={server.enabled}
            >
              {m.educator_mcp_server_enabled()}
            </button>
          </form>
        </div>
      </div>

      {#if server.tools.length === 0}
        <p class="px-3 text-xs text-muted-foreground">{m.educator_mcp_no_tools()}</p>
      {:else}
        <ul class="flex flex-col gap-1 pl-3">
          {#each server.tools as tool (tool.id)}
            <li class={row}>
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="truncate text-sm text-foreground">{tool.name}</span>
                {#if tool.description}
                  <span class="truncate text-xs text-muted-foreground">{tool.description}</span>
                {/if}
              </div>

              <div class="flex shrink-0 items-center gap-2">
                <form method="POST" action="?/setToolFlags" use:enhance>
                  <input type="hidden" name="toolId" value={tool.id}>
                  <input type="hidden" name="sensitive" value={tool.sensitive ? "false" : "true"}>
                  <button
                    type="submit"
                    title={m.educator_tool_sensitive_help()}
                    class={[toggle, { "border-primary text-primary": tool.sensitive }]}
                    aria-pressed={tool.sensitive}
                  >
                    {m.educator_tool_sensitive()}
                  </button>
                </form>
                <form method="POST" action="?/setToolFlags" use:enhance>
                  <input type="hidden" name="toolId" value={tool.id}>
                  <input type="hidden" name="enabled" value={tool.enabled ? "false" : "true"}>
                  <button
                    type="submit"
                    class={[toggle, { "bg-primary text-primary-foreground hover:bg-primary/90": tool.enabled }]}
                    aria-pressed={tool.enabled}
                  >
                    {m.educator_tool_enabled()}
                  </button>
                </form>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
</div>
