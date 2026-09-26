<script lang="ts" module>
/**
 * Reports are sent one at a time, in the order they were raised.
 *
 * One run can produce two of them — `ok` when the page mounts, `threw` when it
 * breaks a moment later — against the same version. Sent concurrently they can
 * land in either order, and the loser is what the server keeps: the model would
 * then be told a page ran when the pupil is looking at an error, or the reverse.
 * A chain rather than a per-instance field so a panel remounted mid-flight does
 * not start a second one.
 */
let sending: Promise<unknown> = Promise.resolve();
</script>

<script lang="ts">
import { rovingTarget } from "$lib/a11y/roving";
import { effectiveArtifactKey, effectiveLanguage } from "$lib/artifacts/identity";
import { kindOf } from "$lib/artifacts/project";
import type { ConsoleLine } from "$lib/artifacts/protocol";
import type { ArtifactLanguage, BuildStatus } from "$lib/artifacts/types";
import * as m from "$lib/paraglide/messages";
import type {
  ArtifactVersionSummary,
  ArtifactVersionView,
  ArtifactWorkspace,
  PanelTab,
} from "$lib/state/artifacts.svelte";
import ArtifactDiff from "./ArtifactDiff.svelte";
import ArtifactEditor from "./ArtifactEditor.svelte";
import ArtifactFrame from "./ArtifactFrame.svelte";
import ArtifactIndex from "./ArtifactIndex.svelte";
import ArtifactStatusBar from "./ArtifactStatusBar.svelte";
import ArtifactTrit from "./ArtifactTrit.svelte";
import FileTree from "./FileTree.svelte";

/**
 * The build surface (PRD §13, §20).
 *
 * Preview, source, history and the list of everything built, filling whichever
 * pane the workspace shell gives it. It no longer positions itself: an overlay
 * that covered the conversation meant every question about an artifact started
 * with putting the artifact away, and that was the single worst thing about the
 * flow this replaces.
 *
 * The panel owns the commit points. A keystroke reaches the workspace and stops
 * there; a Run, or the heavily debounced idle behind it, is what compiles and
 * what stores a revision — "never per keystroke" (§13).
 *
 * It also owns the report back. The browser is the only party that knows whether
 * an artifact ran, so a run against the stored source is PATCHed onto that
 * version and the next turn's prompt states it — which is what turns "it does not
 * work" into an error the model can act on.
 */

interface Props {
  workspace: ArtifactWorkspace;
  /** A distinct hostname from this one; isolation is by origin (§14). */
  sandboxOrigin: string;
  onaskforhelp?: (status: BuildStatus) => void;
}

let { workspace, sandboxOrigin, onaskforhelp }: Props = $props();

/**
 * The idle behind the commit. Long on purpose: the compiler worker competes
 * with the interface for one spare core, so a pause in typing is not a request
 * to build (§13, §20).
 */
const IDLE_MS = 3_000;

let versions = $state<ArtifactVersionSummary[]>([]);
/**
 * The revisions whose files have been fetched, by version.
 *
 * The list carries paths and sizes; the content is fetched for the revision the
 * pupil selects, and for the one before it so the diff has both sides. Cached
 * because moving up and down the list revisits the same pair.
 */
let snapshots = $state<Record<string, ArtifactVersionView>>({});
let snapshotFailures = $state<Record<string, boolean>>({});
const snapshotRequests = new Map<string, Promise<ArtifactVersionView | null>>();
/** Which file of the selected revision the diff is showing. */
let diffPath = $state<string | null>(null);
let selectedVersionId = $state<string | null>(null);
let frame = $state<ReturnType<typeof ArtifactFrame> | null>(null);
let tablist = $state<HTMLDivElement | null>(null);

/** Reports already sent, so a re-render does not PATCH the same outcome twice. */
let reported = $state<string | null>(null);

/**
 * Clear the stamp so a report that did not land can be re-sent — but only while
 * it is still the report the panel owes.
 *
 * One run produces two outcomes, `ok` at the mount and `threw` a moment later,
 * and they are sent along one chain. Clearing unconditionally when the first
 * fails would reopen the effect on a stamp the *second* already holds, and the
 * second would be PATCHed twice. A superseded report has nothing to retry: the
 * outcome it described is no longer the one the panel is reporting.
 */
function release(stamp: string): void {
  if (reported === stamp) reported = null;
}

const artifact = $derived(workspace.open);

/**
 * The project the frame runs.
 *
 * The committed snapshot, which advances only at a commit point — never the
 * files the editor holds, which move with every keystroke (§13).
 */
const runningEntry = $derived(workspace.running?.entry ?? artifact?.latest.entry ?? "index.html");
const runningFiles = $derived(workspace.running?.files ?? artifact?.latest.files ?? {});
const title = $derived(
  artifact?.title ?? (artifact ? m.artifact_untitled({ language: artifact.language }) : ""),
);
const artifactKey = $derived(
  artifact
    ? (artifact.key ??
        effectiveArtifactKey({ language: artifact.language, id: artifact.id, key: null }))
    : "",
);

const selected = $derived(versions.find((version) => version.id === selectedVersionId) ?? null);
const previous = $derived.by(() => {
  if (!selected) return null;
  const index = versions.findIndex((version) => version.id === selected.id);
  return index > 0 ? versions[index - 1] : null;
});

/** Which file of the selected revision the diff shows: the pupil's pick, else what changed. */
const diffFile = $derived.by(() => {
  if (!selected) return null;
  if (diffPath && selected.files.some((file) => file.path === diffPath)) return diffPath;

  const changed = selected.files.find((file) => file.change !== "unchanged");
  return (changed ?? selected.files[0])?.path ?? null;
});

const selectedSnapshot = $derived(selected ? (snapshots[selected.id] ?? null) : null);
const previousSnapshot = $derived(previous ? (snapshots[previous.id] ?? null) : null);

/** What one revision did, in the three counts the list shows. */
function changeSummary(version: ArtifactVersionSummary): string {
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const file of version.files) {
    if (file.change === "added") counts.added++;
    if (file.change === "modified") counts.modified++;
  }

  return [
    counts.added > 0 ? m.artifact_history_added({ count: counts.added }) : "",
    counts.modified > 0 ? m.artifact_history_modified({ count: counts.modified }) : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
}

/**
 * The list is a tab of its own, and only where there is a choice to make.
 *
 * With one artifact the index would be a list of one and a control that leads
 * back to where you already are.
 */
const tabs = $derived([
  ...(workspace.items.length > 1
    ? [
        {
          value: "index" as const,
          label: m.artifact_tab_builds({ count: workspace.items.length }),
        },
      ]
    : []),
  { value: "preview" as const, label: m.artifact_tab_preview() },
  { value: "code" as const, label: m.artifact_tab_code() },
  { value: "history" as const, label: m.artifact_tab_history() },
]);

/** The tab actually shown: `index` is unreachable once it stops being offered. */
const tab = $derived<PanelTab>(
  tabs.some((candidate) => candidate.value === workspace.tab) ? workspace.tab : "preview",
);

/**
 * One tab stop for the list, and the arrows move within it.
 *
 * Roving `tabindex` is only half of the tab pattern. Without this the tabs that
 * are not selected carry `tabindex="-1"` and nothing moves the focus off the one
 * that is, so *Code* and *History* are unreachable by keyboard entirely.
 */
function ontablistkeydown(event: KeyboardEvent): void {
  const next = rovingTarget(event, {
    values: tabs.map((candidate) => candidate.value),
    current: tab,
    attribute: "data-tab",
    // A horizontal tab list, so Up and Down are the page's, not this list's.
    orientation: "inline",
  });
  if (!next) return;

  event.preventDefault();
  workspace.tab = next;

  // The moved-to tab keeps the focus, so the next arrow press continues from it.
  // Not the frame, unlike a click: arrowing along the list is looking at what is
  // there, and handing the keyboard to a game halfway would end the journey.
  queueMicrotask(() => {
    tablist?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  });
}

/**
 * Store the current source as a revision.
 *
 * "Edits recompile locally with no model request" — this reaches Setun and no
 * further; nothing about it touches the gateway or a student's allowance (§13).
 */
async function store(snapshot: {
  entry: string;
  files: Record<string, string>;
  language: ArtifactLanguage | null;
  /** A Restore states the whole project; an edit states only what it changed. */
  replace: boolean;
}): Promise<void> {
  const target = workspace.open;
  if (!target) return;

  const stored = target.latest.files;
  const changed = Object.fromEntries(
    Object.entries(snapshot.files).filter(([path, source]) => stored[path] !== source),
  );
  const deletes = Object.keys(stored).filter((path) => !(path in snapshot.files));

  // Both, because a restore can bring back files the artifact already holds
  // under a different tag — same text, different pipeline (§13).
  const sameTag = snapshot.language === effectiveLanguage(target, target.latest);
  if (
    Object.keys(changed).length === 0 &&
    deletes.length === 0 &&
    snapshot.entry === target.latest.entry &&
    sameTag
  ) {
    return;
  }

  const response = await fetch(`/api/artifacts/${target.id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // A Restore posts the whole file list: the revision it brings back may
      // lack files the current one holds, and merging those would leave a
      // project that is neither revision.
      files: snapshot.replace ? snapshot.files : changed,
      deletes: snapshot.replace ? [] : deletes,
      replace: snapshot.replace,
      entry: snapshot.entry,
      language: snapshot.language,
    }),
  }).catch(() => null);

  if (!response?.ok) {
    workspace.saveFailed = true;
    return;
  }

  const version = (await response.json()) as ArtifactVersionView;
  workspace.applyVersion(target.id, version);
  // The history list holds summaries, so a stored revision invalidates it rather
  // than being folded in: what the list shows is what each revision *changed*,
  // which this one has just altered for the revision after it too.
  if (tab === "history") void loadVersions(target.id);
}

/** A commit point: run what is on screen, and keep it. */
async function commit(replace = false): Promise<void> {
  const snapshot = {
    entry: workspace.entry,
    files: { ...workspace.files },
    language: workspace.language,
    replace,
  };
  workspace.commit();
  await store(snapshot);
}

async function restore(summary: ArtifactVersionSummary): Promise<void> {
  const artifactId = workspace.openId;
  if (!artifactId) return;
  const full = await snapshotFor(summary.id);
  if (!full || workspace.openId !== artifactId) return;

  // Not `edit`: the revision comes back under the tag it was written with, and
  // an html revision of an artifact since rewritten as a component must not go
  // through the Svelte compiler (§13).
  workspace.restore(full);
  await commit(true);
  if (workspace.openId === artifactId) workspace.tab = "preview";
}

/**
 * Which history request is the current one.
 *
 * Two can be in flight at once and they can land in either order — the pupil
 * moved to another artifact, or a revision of *this* one landed and reopened the
 * effect. Both cases are the same mistake if the loser is what gets assigned, so
 * only the newest request is allowed to write.
 */
let versionsRequest = 0;

async function loadVersions(artifactId: string): Promise<void> {
  const request = ++versionsRequest;

  const response = await fetch(`/api/artifacts/${artifactId}`).catch(() => null);
  if (!response?.ok) return;

  const body = (await response.json()) as { versions: ArtifactVersionSummary[] };
  // Both, because they answer different questions. The generation catches a
  // second request overtaking the first — which is how a revision of this same
  // artifact races. The artifact catches the case where no second request was
  // ever made: choosing another build leaves the history tab, so the effect
  // returns early and this reply, still the newest, would otherwise become the
  // new artifact's history.
  if (request !== versionsRequest || workspace.openId !== artifactId) return;

  versions = body.versions;
  selectedVersionId = body.versions.at(-1)?.id ?? null;
  diffPath = null;
}

/** One revision's files, from the cache or from the server. */
async function snapshotFor(versionId: string): Promise<ArtifactVersionView | null> {
  const held = snapshots[versionId];
  if (held) return held;
  const pending = snapshotRequests.get(versionId);
  if (pending) return pending;

  const id = workspace.openId;
  if (!id) return null;

  const request = fetch(`/api/artifacts/${id}/versions/${versionId}`)
    .then(async (response) => {
      if (!response.ok) throw new Error("Snapshot request failed");
      const full = (await response.json()) as ArtifactVersionView;
      snapshots = { ...snapshots, [versionId]: full };
      snapshotFailures = { ...snapshotFailures, [versionId]: false };
      return full;
    })
    .catch(() => {
      snapshotFailures = { ...snapshotFailures, [versionId]: true };
      return null;
    })
    .finally(() => snapshotRequests.delete(versionId));
  snapshotRequests.set(versionId, request);
  return request;
}

function retrySnapshots(): void {
  for (const version of [selected, previous]) {
    if (version && snapshotFailures[version.id]) {
      snapshotFailures = { ...snapshotFailures, [version.id]: false };
    }
  }
}

/**
 * Take the keyboard, unless the pupil is typing something (§13, §20).
 *
 * A canvas game listens on its own window and is unplayable until the frame has
 * focus. Pulling the caret out of the composer or the editor mid-word is worse
 * than a game that needs one tap, so the active element decides.
 */
function focusArtifact(): void {
  const active = document.activeElement;
  const tag = active?.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    (active instanceof HTMLElement && active.isContentEditable)
  ) {
    return;
  }

  frame?.focus();
}

// The heavily debounced idle (§13). Re-armed on every keystroke, so it fires
// once the student stops rather than while they are still typing.
$effect(() => {
  // Read so the effect re-arms on every keystroke rather than only on the first.
  void workspace.files;
  if (!workspace.dirty) return;

  const timer = setTimeout(() => void commit(), IDLE_MS);
  return () => clearTimeout(timer);
});

/**
 * The selected revision's files, and the one before it (§13).
 *
 * Fetched rather than listed: a version list is cheap and its sources are not,
 * so the History tab loads paths and sizes and reaches for content only for the
 * pair a diff actually needs.
 */
$effect(() => {
  const ids = [selected?.id, previous?.id].filter((id): id is string => typeof id === "string");
  for (const id of ids) {
    if (!snapshots[id] && !snapshotFailures[id]) void snapshotFor(id);
  }
});

// History is read when it is opened, and again once a revision lands.
$effect(() => {
  const id = workspace.openId;
  const newest = workspace.open?.latest.id;
  if (!id || tab !== "history" || !newest) return;

  void loadVersions(id);
});

/**
 * Report the run onto the version it ran (§13).
 *
 * `pendingBuildReport` is null for a draft the version does not hold and null
 * when the stored status already says this, so the guard here is only against
 * sending the same report twice while the effect re-runs.
 */
$effect(() => {
  const report = workspace.pendingBuildReport;
  if (!report) return;

  const stamp = `${report.versionId}:${report.status}`;
  if (reported === stamp) return;
  reported = stamp;

  sending = sending.then(() =>
    fetch(`/api/artifacts/${report.artifactId}/versions/${report.versionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buildStatus: report.status, buildMessage: report.message }),
    })
      .then((response) => {
        // Folded back in either way is wrong: an unrecorded outcome would be
        // re-sent on the next render, and the model would be told nothing.
        if (response.ok) workspace.applyBuildStatus(report);
        else release(stamp);
      })
      .catch(() => release(stamp)),
  );
});
</script>

<section
  class="flex h-full min-h-0 flex-col bg-card"
  aria-label={m.artifact_panel_title()}
  data-artifact-id={artifact?.id ?? ""}
>
  {#if workspace.items.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <h2 class="text-base font-semibold tracking-tight text-card-foreground">
        {m.artifact_empty_heading()}
      </h2>
      <p class="max-w-sm text-sm text-muted-foreground">{m.artifact_empty_body()}</p>
    </div>
  {:else}
    <header class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <div class="mr-auto min-w-0">
        {#if tab === "index" || !artifact}
          <p class="truncate text-sm font-semibold tracking-tight text-card-foreground">
            {m.artifact_index_heading()}
          </p>
        {:else}
          <p class="truncate text-sm font-semibold tracking-tight text-card-foreground">{title}</p>
          <!-- Identity is always the mono face, so code-things read as code-things. -->
          <p class="truncate font-mono text-xs tabular-nums text-muted-foreground">
            {m.artifact_id_label()}={artifactKey} · {workspace.language ??
              artifact.language} · v{artifact.latest.revision}{workspace.paths.length > 1
              ? ` · ${m.artifact_files_count({ count: workspace.paths.length })}`
              : ""}
          </p>
        {/if}
      </div>

      {#if artifact && tab !== "index"}
        <button
          type="button"
          onclick={() => void commit()}
          class="min-h-9 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
        >
          {m.artifact_run()}
        </button>
      {/if}
    </header>

    <div
      bind:this={tablist}
      role="tablist"
      aria-label={m.artifact_panel_title()}
      tabindex="-1"
      onkeydown={ontablistkeydown}
      class="flex shrink-0 items-center gap-1 border-b border-border px-2"
    >
      {#each tabs as candidate (candidate.value)}
        <button
          type="button"
          role="tab"
          id="artifact-tab-{candidate.value}"
          data-tab={candidate.value}
          aria-controls="artifact-view"
          aria-selected={tab === candidate.value}
          tabindex={tab === candidate.value ? 0 : -1}
          onclick={() => {
            workspace.tab = candidate.value;
            if (candidate.value === "preview") focusArtifact();
          }}
          class={[
            "min-h-11 border-b-2 px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            tab === candidate.value
              ? "border-primary text-card-foreground"
              : "border-transparent text-muted-foreground hover:text-card-foreground",
          ]}
        >
          {candidate.label}
        </button>
      {/each}
    </div>

    <div
      id="artifact-view"
      role="tabpanel"
      aria-labelledby="artifact-tab-{tab}"
      class="min-h-0 flex-1"
    >
      {#if tab === "index"}
        <ArtifactIndex
          items={workspace.items}
          openId={workspace.openId}
          onselect={(id) => {
            workspace.show(id);
            workspace.tab = "preview";
          }}
        />
      {/if}

      <!--
        The frame stays mounted across tabs: reloading the artifact because a
        pupil looked at its source would throw away whatever state it had.
      -->
      <div class={["h-full", tab === "preview" ? "block" : "hidden"]}>
        {#if artifact && workspace.running !== null}
          <ArtifactFrame
            bind:this={frame}
            {sandboxOrigin}
            artifactId={artifact.id}
            language={workspace.runningLanguage ?? artifact.language}
            entry={runningEntry}
            files={runningFiles}
            oncompiling={() => (workspace.status = "compiling")}
            onrunning={() => {
              workspace.status = "running";
              workspace.error = null;
              workspace.recordOutcome("ok", null);
              // A game is unplayable until its own window has the keyboard, and
              // the pupil is looking at it the moment it renders.
              focusArtifact();
            }}
            onfailed={(message) => {
              workspace.status = "failed";
              workspace.error = message;
              workspace.recordOutcome("failed", message);
            }}
            onthrew={(message) => {
              // The status stays "running": the page is still on screen, and
              // what changed is that something on it broke.
              workspace.error = message;
              workspace.recordOutcome("threw", message);
            }}
            onconsole={(lines: readonly ConsoleLine[]) => workspace.appendConsole(lines)}
          />
        {/if}
      </div>

      {#if tab === "code" && artifact}
        <div class="flex h-full min-h-0 flex-col sm:flex-row">
          {#if workspace.paths.length > 1}
            <!--
              Only where there is something to choose: a one-file artifact has no
              tree to show, and a sidebar naming its single file would cost the
              editor a third of its lines on a 640-pixel screen (§20).
            -->
            <FileTree
              paths={workspace.paths}
              active={workspace.path}
              entry={workspace.entry}
              changed={workspace.changedPaths}
              onselect={(path) => workspace.selectFile(path)}
            />
          {/if}

          <div class="min-h-0 flex-1">
            <!--
              Re-keyed on the file and its tag: the editor resolves its grammar
              once inside its attachment and holds no compartment, so moving to
              another file — or a restore that changes the tag — is followed by a
              fresh editor (§13).
            -->
            {#key `${workspace.path}:${workspace.language}`}
              <ArtifactEditor
                value={workspace.source}
                language={workspace.language ?? artifact.language}
                kind={kindOf(workspace.path)}
                onchange={(source) => workspace.edit(source)}
              />
            {/key}
          </div>
        </div>
      {/if}

      {#if tab === "history" && artifact}
        <div class="flex h-full min-h-0 flex-col sm:flex-row">
          <ul
            class="max-h-40 shrink-0 overflow-y-auto border-b border-border sm:max-h-none sm:w-44 sm:border-b-0 sm:border-r"
          >
            {#each [...versions].reverse() as version (version.id)}
              <li>
                <button
                  type="button"
                  onclick={() => (selectedVersionId = version.id)}
                  aria-current={selectedVersionId === version.id}
                  class={[
                    "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selectedVersionId === version.id
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-secondary/50",
                  ]}
                >
                  <span class="flex items-center gap-1.5">
                    <ArtifactTrit status={version.buildStatus ?? null} />
                    <span class="font-mono font-medium tabular-nums">
                      {m.artifact_version_label({ revision: version.revision })}
                    </span>
                    {#if version.language && version.language !== artifact.language}
                      <!-- Only when it differs: the tag a revision was written
                           under is otherwise the one already in the header. -->
                      <span class="font-mono text-muted-foreground">{version.language}</span>
                    {/if}
                  </span>
                  <span>
                    {version.authoredBy === "student"
                      ? m.artifact_version_by_student()
                      : m.artifact_version_by_model()}
                  </span>
                  {#if version.buildStatus === "failed"}
                    <span class="text-destructive">{m.artifact_version_build_failed()}</span>
                  {:else if version.buildStatus === "threw"}
                    <span class="text-destructive">{m.artifact_version_build_threw()}</span>
                  {:else if !version.buildStatus}
                    <span>{m.artifact_status_not_run()}</span>
                  {/if}
                  <!--
                    What this revision did, rather than what it holds: a project
                    of five files revised in one place should read as one change
                    (§13).
                  -->
                  <span class="font-mono tabular-nums">{changeSummary(version)}</span>
                </button>
              </li>
            {/each}
          </ul>

          <div class="flex min-h-0 flex-1 flex-col">
            {#if selected && selected.files.length > 1}
              <!--
                One diff per file: a revision of a five-file project against its
                predecessor is five diffs, and stacking them would bury the one
                that changed.
              -->
              <div
                class="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1"
                role="group" aria-label={m.artifact_diff_file_label()}
              >
                {#each selected.files as file (file.path)}
                  <button
                    type="button"
                    onclick={() => (diffPath = file.path)}
                    aria-current={file.path === diffFile}
                    class={[
                      "shrink-0 rounded-md px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      file.path === diffFile
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:bg-secondary/50",
                    ]}
                  >
                    {file.path}
                    {#if file.change !== "unchanged"}
                      <span aria-hidden="true" class="text-primary">•</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}

            {#if selected && diffFile}
              {@const before = previousSnapshot?.files[diffFile]}
              {@const after = selectedSnapshot?.files[diffFile]}
              <div class="min-h-0 flex-1 overflow-auto">
                {#if snapshotFailures[selected.id] || (previous && snapshotFailures[previous.id])}
                  <div class="flex flex-col items-start gap-2 p-3">
                    <p role="alert" class="text-xs text-muted-foreground">
                      {m.artifact_history_load_failed()}
                    </p>
                    <button
                      type="button"
                      onclick={retrySnapshots}
                      class="min-h-9 rounded-md border border-input px-2.5 text-xs text-card-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {m.artifact_history_retry()}
                    </button>
                  </div>
                {:else if selectedSnapshot === null || (previous !== null && previousSnapshot === null)}
                  <p role="status" class="p-3 text-xs text-muted-foreground">
                    {m.artifact_history_loading()}
                  </p>
                {:else if after === undefined}
                  <p class="p-3 text-xs text-muted-foreground">
                    {m.artifact_diff_deleted({ path: diffFile })}
                  </p>
                {:else if before === undefined}
                  <p class="p-3 text-xs text-muted-foreground">
                    {m.artifact_diff_added({ path: diffFile })}
                  </p>
                {:else if before === after}
                  <p class="p-3 text-xs text-muted-foreground">
                    {m.artifact_diff_unchanged({ path: diffFile })}
                  </p>
                {:else}
                  <ArtifactDiff
                    original={before}
                    revised={after}
                    pairKey={`${selected.id}:${diffFile}`}
                  />
                {/if}
              </div>
            {:else}
              <p class="p-3 text-xs text-muted-foreground">{m.artifact_diff_none()}</p>
            {/if}

            {#if selected}
              <div class="shrink-0 border-t border-border p-2">
                <button
                  type="button"
                  onclick={() => void restore(selected)}
                  class="min-h-9 rounded-md border border-input px-2.5 text-xs text-card-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {m.artifact_restore()}
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if tab !== "index"}
      <ArtifactStatusBar {workspace} {onaskforhelp} />
    {/if}
  {/if}
</section>
