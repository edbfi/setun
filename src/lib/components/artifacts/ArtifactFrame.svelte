<script lang="ts">
import { isSandboxAssetPath, sandboxAssetUrl } from "$lib/artifacts/assets";
import { type ProjectFiles, sameFiles } from "$lib/artifacts/project";
import {
  ARTIFACT_CHANNEL,
  asSandboxMessage,
  type ConsoleLine,
  type HostMessage,
} from "$lib/artifacts/protocol";
import type { ArtifactLanguage } from "$lib/artifacts/types";
import * as m from "$lib/paraglide/messages";

/**
 * The sandboxed iframe host and its message bridge (PRD §14).
 *
 * "Artifacts execute on a separate origin from the application, in an iframe
 * sandboxed to allow scripts but explicitly *not* same-origin." Dropping
 * `allow-same-origin` gives the frame an opaque origin: it cannot read this
 * page's cookies, storage or DOM even though the URL it loads is one this
 * deployment serves.
 *
 * A consequence worth naming, because it looks like a mistake: every message
 * from the frame arrives with `event.origin === "null"`, so origin checking is
 * useless here and `event.source` is the identity that actually holds — it is a
 * window reference this component created and no other page can forge.
 *
 * The same opaque origin is why this component fetches the sandbox's own pinned
 * files on its behalf: an opaque origin is the worst position from which to ask
 * for a subresource, and this page is an ordinary origin for which the same GET
 * is unremarkable. `$lib/artifacts/assets` has the account. Every path the frame
 * names is checked against `isSandboxAssetPath` first, so this reads two
 * directories on the sandbox origin and can be pointed nowhere else.
 */

/**
 * One copy per origin for the lifetime of the tab.
 *
 * Module-level rather than per-component: the compiler's WebAssembly is thirteen
 * megabytes, and a pupil who opens a second artifact — or the same panel twice —
 * must not pay for it again. The browser's own cache would usually cover that,
 * but "usually" is doing too much work for a file this size.
 */
const held = new Map<string, Promise<ArrayBuffer>>();

function loadAsset(origin: string, path: string): Promise<ArrayBuffer> {
  const key = `${origin} ${path}`;
  const already = held.get(key);
  if (already) return already;

  const wanted = fetch(sandboxAssetUrl(origin, path))
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.arrayBuffer();
    })
    .catch((cause: unknown) => {
      // Not kept: a failure now must not be the answer for the rest of the session.
      held.delete(key);
      throw cause;
    });

  held.set(key, wanted);
  return wanted;
}

interface Props {
  /** A distinct hostname from the application's; isolation is by origin (§14). */
  sandboxOrigin: string;
  /**
   * Which artifact is running (§13).
   *
   * The runner keeps each artifact's storage snapshot under this, so a game that
   * saved a high score finds it again after a Run and the artifact beside it
   * starts empty. Opaque to the sandbox: a grouping key, never a lookup.
   */
  artifactId: string;
  language: ArtifactLanguage;
  /** Which file runs. Always a key of `files`. */
  entry: string;
  /** The project to run. Advanced only at a commit point, never per keystroke (§13). */
  files: ProjectFiles;
  oncompiling?: () => void;
  onrunning?: () => void;
  onfailed?: (message: string) => void;
  /**
   * The artifact mounted and then threw (§13).
   *
   * Separate from `onfailed` because the page is on screen: what it needs is the
   * error, not a rewrite. The runner decides which of the two a runtime error is.
   */
  onthrew?: (message: string) => void;
  /** What the artifact printed. Rendered as text, never as markup (§13, §21). */
  onconsole?: (lines: readonly ConsoleLine[]) => void;
}

let {
  sandboxOrigin,
  artifactId,
  language,
  entry,
  files,
  oncompiling,
  onrunning,
  onfailed,
  onthrew,
  onconsole,
}: Props = $props();

/**
 * Put the keyboard in the artifact (§13, §20).
 *
 * A canvas game listens on its own window, so a pupil who has not clicked inside
 * the frame is pressing arrow keys at the conversation. Exported rather than
 * taken automatically: the panel decides when it is the pupil's intent, and a
 * frame that grabs focus as it renders steals the composer mid-sentence.
 */
export function focus(): void {
  send({ channel: ARTIFACT_CHANNEL, type: "focus" });
}

let frame = $state<HTMLIFrameElement | null>(null);
let ready = $state(false);

/** Plain, not reactive: it is only ever read inside an event callback. */
let currentRunId: string | null = null;

/**
 * What the frame is already showing, so an unchanged render is not re-sent.
 *
 * The effect below re-runs whenever the panel's artifact list is *replaced*,
 * which recording a build status does — the values it reads are equal, but the
 * objects they came from are not. Re-sending the render tore the document down
 * and built it again: a game lost its board, and the fresh mount reported an
 * outcome of its own. With two outcomes in one run — `ok` at the mount and
 * `threw` a moment later — that became a loop, each report causing the render
 * that produced the next one.
 *
 * Plain, not reactive: written and read only inside the effect.
 */
let showing: {
  artifactId: string;
  language: ArtifactLanguage;
  entry: string;
  files: ProjectFiles;
} | null = null;

function send(message: HostMessage, transfer: Transferable[] = []): void {
  // `"*"` because the frame has an opaque origin, which has no addressable
  // form. Nothing secret travels this way — the artifact already has its source.
  frame?.contentWindow?.postMessage(message, "*", transfer);
}

/**
 * Answer the frame's request for one of the sandbox origin's own files.
 *
 * The buffer is transferred rather than copied, and a fresh copy is taken from
 * the cached one each time: transfer detaches what it moves, and the cache has
 * to survive a second artifact.
 */
async function serveAsset(path: string): Promise<void> {
  try {
    // Checked again here rather than trusted from the message: `asSandboxMessage`
    // already refused anything else, and this is the line that does the reading.
    if (!isSandboxAssetPath(path)) throw new Error("refused");
    const bytes = (await loadAsset(sandboxOrigin, path)).slice(0);
    send({ channel: ARTIFACT_CHANNEL, type: "asset", path, ok: true, bytes }, [bytes]);
  } catch (cause) {
    send({
      channel: ARTIFACT_CHANNEL,
      type: "asset",
      path,
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

$effect(() => {
  function receive(event: MessageEvent): void {
    if (!frame?.contentWindow || event.source !== frame.contentWindow) return;

    const message = asSandboxMessage(event.data);
    if (!message) return;

    if (message.type === "ready") {
      ready = true;
      // A runner that says `ready` again is a document that has been reloaded
      // and holds nothing, so the next render is not a repeat of anything.
      showing = null;
      return;
    }
    // Not tied to a run: the compiler and the runtimes outlive any one of them.
    if (message.type === "need-asset") {
      void serveAsset(message.path);
      return;
    }
    // A late answer from a superseded run would report the wrong revision.
    if (message.runId !== currentRunId) return;

    if (message.type === "compiling") oncompiling?.();
    else if (message.type === "rendered") onrunning?.();
    else if (message.type === "console") onconsole?.(message.lines);
    else if (message.type === "failed") onfailed?.(message.message);
    else if (message.type === "threw") onthrew?.(message.message);
  }

  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
});

// Runs when the frame reports ready and whenever the committed source changes.
$effect(() => {
  const running = files;
  const start = entry;
  const kind = language;
  const owner = artifactId;
  if (!ready || !owner) return;

  if (
    showing &&
    showing.artifactId === owner &&
    showing.language === kind &&
    showing.entry === start &&
    sameFiles(showing.files, running)
  ) {
    return;
  }
  showing = { artifactId: owner, language: kind, entry: start, files: running };

  currentRunId = crypto.randomUUID();
  send({
    channel: ARTIFACT_CHANNEL,
    type: "render",
    runId: currentRunId,
    artifactId,
    language: kind,
    entry: start,
    // Snapshotted: `postMessage` structured-clones its payload, and a `$state`
    // proxy is not cloneable — the render would fail with a DataCloneError and
    // the panel would sit waiting on a build that never started.
    files: $state.snapshot(running),
  });
});
</script>

<!--
  Scripts and pointer lock, and nothing else (§14). Pointer lock is what a game
  that looks around with the mouse needs; it grants the cursor and nothing more,
  only from a click inside the artifact, and Esc always releases it. Still no
  `allow-same-origin`, so the document stays opaque. The runner page sandboxes
  the artifact's own frame the same way, and the flags intersect.
-->
<iframe
  bind:this={frame}
  src={sandboxOrigin}
  title={m.artifact_frame_title()}
  sandbox="allow-scripts allow-pointer-lock"
  referrerpolicy="no-referrer"
  allow=""
  class="h-full w-full border-0 bg-white"
></iframe>
