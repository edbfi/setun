<script lang="ts">
import { rovingTarget } from "$lib/a11y/roving";
import { buildFileTree, type FileTreeNode } from "$lib/artifacts/project";
import * as m from "$lib/paraglide/messages";

/**
 * The files of one artifact (PRD §13, §20).
 *
 * An artifact is a project now, so the Code tab needs a way to say which file is
 * on screen. A tree rather than a flat list, because a model that has been asked
 * to split its work puts things under `src/` and the flat list would read as one
 * long column of near-identical names.
 *
 * One tab stop, and the arrows move within it — the same contract the workspace
 * switcher and the theme control keep, and for the same reason: a keyboard user
 * passing a five-file project should not spend five stops on it.
 *
 * Folders are collapsible and open by default: a pupil opening the Code tab
 * wants to see what is there, and a project this size has nothing to hide.
 */
interface Props {
  paths: readonly string[];
  /** Which file the editor is showing. */
  active: string;
  /** Which file runs, so the tree can say so. */
  entry: string;
  /** Files the pupil has edited since the stored revision. */
  changed?: readonly string[];
  onselect: (path: string) => void;
}

let { paths, active, entry, changed = [], onselect }: Props = $props();
const treeId = $props.id();

const tree = $derived(buildFileTree([...paths]));
const changedSet = $derived(new Set(changed));

/** Folders the pupil has collapsed. Open is the default, so this holds the closed ones. */
let collapsed = $state<Record<string, boolean>>({});

/** Files and folders share one focus order, including when the active file is hidden. */
const ordered = $derived.by(() => {
  const out: string[] = [];

  const walk = (nodes: readonly FileTreeNode[]) => {
    for (const node of nodes) {
      out.push(node.path);
      if (node.kind === "file") {
        continue;
      }
      if (!collapsed[node.path]) walk(node.children);
    }
  };

  walk(tree);
  return out;
});

let focused = $state<string | null>(null);
const tabStop = $derived(
  focused && ordered.includes(focused)
    ? focused
    : ordered.includes(active)
      ? active
      : (ordered[0] ?? ""),
);

let root = $state<HTMLElement | null>(null);

function onkeydown(event: KeyboardEvent): void {
  const next = rovingTarget(event, {
    values: ordered,
    current: tabStop,
    attribute: "data-path",
    orientation: "block",
  });
  if (!next) return;

  event.preventDefault();
  focused = next;
  if (paths.includes(next)) onselect(next);

  // The moved-to file keeps the focus, so the next arrow press continues from it.
  queueMicrotask(() => {
    root?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next)}"]`)?.focus();
  });
}
</script>

{#snippet nodes(list: readonly FileTreeNode[], depth: number)}
  {#each list as node (node.path)}
    {#if node.kind === "folder"}
      <li role="none">
        <button
          type="button"
          role="treeitem"
          data-path={node.path}
          tabindex={tabStop === node.path ? 0 : -1}
          aria-expanded={!collapsed[node.path]}
          aria-selected={false}
          aria-owns={collapsed[node.path] ? undefined : `${treeId}-${node.path}`}
          aria-label={m.artifact_file_folder_toggle({ name: node.name })}
          onfocus={() => (focused = node.path)}
          onclick={() => (collapsed = { ...collapsed, [node.path]: !collapsed[node.path] })}
          style="padding-inline-start: {0.5 + depth * 0.75}rem"
          class="flex w-full items-center gap-1 py-1 pe-2 text-start text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span aria-hidden="true" class="w-2.5 shrink-0 font-mono">
            {collapsed[node.path] ? "›" : "⌄"}
          </span>
          <span class="truncate font-mono">{node.name}</span>
        </button>

        {#if !collapsed[node.path]}
          <ul id={`${treeId}-${node.path}`} role="group" class="flex flex-col">
            {@render nodes(node.children, depth + 1)}
          </ul>
        {/if}
      </li>
    {:else}
      {@const isActive = node.path === active}
      <li role="none">
        <button
          type="button"
          role="treeitem"
          data-path={node.path}
          aria-current={isActive}
          aria-selected={isActive}
          tabindex={tabStop === node.path ? 0 : -1}
          onfocus={() => (focused = node.path)}
          onclick={() => onselect(node.path)}
          style="padding-inline-start: {0.5 + depth * 0.75}rem"
          class={[
            "flex w-full items-center gap-1.5 py-1 pe-2 text-start text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            isActive
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
          ]}
        >
          <span
            aria-hidden="true"
            class={[
              "size-1.5 shrink-0 rounded-full",
              changedSet.has(node.path) ? "bg-primary" : "bg-transparent",
            ]}
          ></span>
          <span class="truncate font-mono">{node.name}</span>
          {#if changedSet.has(node.path)}
            <span class="sr-only">{m.artifact_file_changed()}</span>
          {/if}
          {#if node.path === entry}
            <span class="ms-auto shrink-0 text-[0.625rem] uppercase opacity-70">
              {m.artifact_file_entry()}
            </span>
          {/if}
        </button>
      </li>
    {/if}
  {/each}
{/snippet}

<!--
  A column beside the editor where there is room, and a strip above it where
  there is not: on 640 pixels of usable height a sidebar costs the editor a
  third of its lines (§20).
-->
<ul
  bind:this={root}
  role="tree"
  aria-label={m.artifact_file_tree_label()}
  {onkeydown}
  class="flex shrink-0 flex-col overflow-auto border-b border-border sm:max-h-none sm:w-44 sm:border-b-0 sm:border-e"
>
  {@render nodes(tree, 0)}
</ul>
