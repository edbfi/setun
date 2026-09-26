<script lang="ts">
import type { Attachment } from "svelte/attachments";
import * as m from "$lib/paraglide/messages";

/**
 * What changed between two revisions (PRD §13).
 *
 * "Every edit is versioned, which yields undo, a diff view — *what did the AI
 * actually change?* is a good discussion prompt." So the diff is a teaching
 * instrument, not a developer convenience, and it reads as one revision with the
 * previous one's removals shown inline rather than as two columns nobody can
 * follow on a 1366-pixel screen (§20).
 *
 * Loaded on demand with the rest of CodeMirror (§20).
 */

interface Props {
  original: string;
  revised: string;
  /** Identity of the pair, so a different one rebuilds rather than re-diffing in place. */
  pairKey: string;
}

let { original, revised, pairKey }: Props = $props();

const diff: Attachment<HTMLElement> = (node) => {
  let disposed = false;
  let view: { destroy: () => void } | null = null;

  void (async () => {
    const [{ EditorView }, { EditorState }, { unifiedMergeView }, { diffTheme, editorChrome }] =
      await Promise.all([
        import("@codemirror/view"),
        import("@codemirror/state"),
        import("@codemirror/merge"),
        import("./editor-theme"),
      ]);

    if (disposed) return;

    view = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: revised,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          unifiedMergeView({ original, mergeControls: false }),
          editorChrome,
          diffTheme,
        ],
      }),
    });
  })();

  return () => {
    disposed = true;
    view?.destroy();
  };
};
</script>

{#key pairKey}
  <section
    {@attach diff}
    class="h-full overflow-hidden"
    aria-label={m.artifact_diff_heading()}
  ></section>
{/key}
