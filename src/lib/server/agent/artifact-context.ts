import { detectArtifacts } from "../../artifacts/detect";
import { fenceFor } from "../../artifacts/fences";
import { effectiveArtifactKey, effectiveLanguage, fenceInfo } from "../../artifacts/identity";
import { kindOf, lineCount } from "../../artifacts/project";
import type { ArtifactLanguage, BuildStatus, VersionAuthor } from "../../artifacts/types";
import type { AppDatabase } from "../db/client";
import { listConversationVersions, snapshotsOf } from "../db/queries/artifacts";
import type { Message, MessagePart } from "../db/schema";

/**
 * What the model is told about the artifacts it has already written (PRD §13).
 *
 * Three jobs, from one read of the conversation's versions:
 *
 * 1. **The state note.** A short list of what exists — id, language, revision,
 *    who wrote it last, and how it ran. Without it a model cannot know which id
 *    to reuse, and cannot know that the thing it wrote did not run at all.
 * 2. **Superseded-source elision.** Full rewrites are the update mechanism, so
 *    the path holds every version of every artifact in full. Left alone, a
 *    fourth revision of a page sends four copies of that page — the input grows
 *    without bound, and the model has three obsolete versions of its own file to
 *    confuse with the current one. So a block whose artifact's current source
 *    appears *later* in the same conversation is replaced by a line saying so.
 *
 * 3. **Carried sources.** The same read answers the opposite question: which
 *    artifacts' current sources the path does *not* hold. A pupil who edits an
 *    earlier prompt sends a path from a different branch of the message tree,
 *    and the artifact the model wrote on the branch they left is named by the
 *    state note and present nowhere. So its complete source travels behind the
 *    note, in the same never-persisted slot.
 *
 * The rule is deliberately conservative: nothing is elided unless the current
 * source is demonstrably present further down the same path. A block that is the
 * newest copy the model will see is always sent in full.
 *
 * Presence is decided by identity and not by text alone — a block counts for the
 * artifact its `id=` names, and an id-less block only when its text names exactly
 * one artifact. Both questions use the same rule, so an artifact can never be
 * both elided against a copy that is not its own and left uncarried because of it.
 */

/** Where one stored source sits: which artifact, which file, and whether current. */
export interface ArtifactSourceRef {
  readonly artifactId: string;
  readonly key: string;
  readonly language: ArtifactLanguage;
  /** Which file of the project this text is, so elision is per file (§13). */
  readonly path: string;
  readonly revision: number;
  /** True when this text is what the artifact's newest revision holds at `path`. */
  readonly isCurrent: boolean;
}

/** One file of an artifact, as the state note lists it. */
export interface ArtifactStateFile {
  readonly path: string;
  readonly lines: number;
  readonly isEntry: boolean;
}

/** One line of the note: an artifact as it stands now. */
export interface ArtifactStateLine {
  readonly key: string;
  readonly language: ArtifactLanguage;
  readonly title: string | null;
  readonly revision: number;
  readonly authoredBy: VersionAuthor;
  readonly buildStatus: BuildStatus | null;
  readonly buildMessage: string | null;
  /**
   * Every file the artifact holds, with its length (§13).
   *
   * The line counts are the one lever besides the prompt against a model
   * writing everything into one file: a model that can see `src/App.tsx (410
   * lines)` beside `styles.css (12 lines)` has been told where the weight is.
   */
  readonly files: readonly ArtifactStateFile[];
}

/** An artifact whose current files the path does not hold in full. */
export interface CarriedSource {
  readonly key: string;
  readonly language: ArtifactLanguage;
  readonly title: string | null;
  readonly revision: number;
  readonly entry: string;
  /** Every file the artifact currently holds, so the header can name them all. */
  readonly allPaths: readonly string[];
  /** Only the files the path lacks: path → source. */
  readonly missing: Readonly<Record<string, string>>;
}

export interface ArtifactContext {
  /** Source text → every stored version holding exactly that text. */
  readonly index: ReadonlyMap<string, readonly ArtifactSourceRef[]>;
  readonly state: readonly ArtifactStateLine[];
  /** Current sources absent from the active path, to travel with the note. */
  readonly carried: readonly CarriedSource[];
}

export const EMPTY_ARTIFACT_CONTEXT: ArtifactContext = {
  index: new Map(),
  state: [],
  carried: [],
};

export function buildArtifactContext(
  db: AppDatabase,
  input: {
    conversationId: string;
    studentId: string;
    /** The active path, which decides what has to be carried rather than elided. */
    path: readonly Pick<Message, "role" | "parts">[];
  },
): ArtifactContext {
  const rows = listConversationVersions(db, input);
  /**
   * The files of every revision, in one query (§13).
   *
   * A version is a project now, so its source is no longer a column on the row.
   * Fetched together rather than per version: a lesson with a dozen creations
   * would otherwise be a dozen round trips to assemble one prompt.
   */
  const snapshots = snapshotsOf(
    db,
    rows.map((row) => row.version.id),
  );

  // Ordered by artifact and then revision, so the last row of each group is the
  // current one and one pass is enough.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latest.set(row.artifact.id, row);

  const index = new Map<string, ArtifactSourceRef[]>();
  for (const { artifact, version } of rows) {
    const snapshot = snapshots.get(version.id);
    if (!snapshot) continue;

    const current = latest.get(artifact.id)?.version.id === version.id;

    // Per file, not per version: a revision that changed only the stylesheet
    // leaves four of its five files at the exact text an earlier revision holds,
    // and eliding those is the whole point of the index (§13).
    for (const [path, source] of Object.entries(snapshot.files)) {
      const refs = index.get(source) ?? [];
      refs.push({
        artifactId: artifact.id,
        key: effectiveArtifactKey(artifact),
        // The tag this revision was written under, so a placeholder names what
        // the block actually was rather than what the row has since become (§13).
        language: effectiveLanguage(artifact, version),
        path,
        revision: version.revision,
        isCurrent: current,
      });
      index.set(source, refs);
    }
  }

  const state = [...latest.values()].map(({ artifact, version }) => {
    const snapshot = snapshots.get(version.id);

    return {
      key: effectiveArtifactKey(artifact),
      language: effectiveLanguage(artifact, version),
      title: artifact.title,
      revision: version.revision,
      authoredBy: version.authoredBy,
      buildStatus: version.buildStatus ?? null,
      buildMessage: version.buildMessage ?? null,
      files: Object.entries(snapshot?.files ?? {})
        .map(([path, source]) => ({
          path,
          lines: lineCount(source),
          isEntry: path === version.entryPath,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  });

  const held = currentSourcesOnPath(input.path, index);
  const carried = [...latest.values()].flatMap(({ artifact, version }) => {
    const snapshot = snapshots.get(version.id);
    if (!snapshot) return [];

    const missing: Record<string, string> = {};
    for (const [path, source] of Object.entries(snapshot.files)) {
      if (!held.has(fileKey(artifact.id, path))) missing[path] = source;
    }

    // Nothing to carry: the path already holds every file of this artifact.
    if (Object.keys(missing).length === 0) return [];

    return [
      {
        key: effectiveArtifactKey(artifact),
        language: effectiveLanguage(artifact, version),
        title: artifact.title,
        revision: version.revision,
        entry: version.entryPath,
        allPaths: Object.keys(snapshot.files).sort(),
        missing,
      },
    ];
  });

  return { index, state, carried };
}

/** An error message is a hint in a prompt, not a log; one line, bounded. */
const NOTE_MESSAGE_MAX = 300;

function collapse(message: string): string {
  return message.replace(/`/g, "").replace(/\s+/g, " ").trim().slice(0, NOTE_MESSAGE_MAX);
}

/**
 * The note itself, or null when the conversation has built nothing.
 *
 * Written to the model, so English and not a Paraglide message. It goes in as
 * the last text of the last user message rather than as a system message: it is
 * adjacent to the request it informs, it is identical on both gateway dialects,
 * it leaves the cacheable prefix alone, and it is never persisted — the note
 * describes the moment the turn was assembled and would be a lie afterwards.
 */
export function formatArtifactState(state: readonly ArtifactStateLine[]): string | null {
  if (state.length === 0) return null;

  const lines = state.map((item) => {
    const title = item.title ? ` "${collapse(item.title)}"` : "";
    const author = item.authoredBy === "model" ? "you" : "the pupil";
    const run =
      item.buildStatus === "failed"
        ? `last run failed: ${collapse(item.buildMessage ?? "no message")}`
        : item.buildStatus === "threw"
          ? `ran, then threw: ${collapse(item.buildMessage ?? "no message")}`
          : item.buildStatus === "ok"
            ? "last run: ok"
            : "not run yet";

    const head = `- id=${item.key} (${item.language})${title} — revision ${item.revision}, last written by ${author}, ${run}`;
    if (item.files.length === 0) return head;

    const files = item.files
      .map((file) => `${file.path} (${file.lines} lines${file.isEntry ? ", entry" : ""})`)
      .join(", ");

    return `${head}\n  files: ${files}`;
  });

  return [
    "[The artifacts in this conversation. Reuse an id to change that artifact, writing only the",
    "files you change, each with its path; use a new id for a separate thing.",
    ...lines,
    "]",
  ].join("\n");
}

/**
 * How much carried source one turn will send.
 *
 * Cumulative over the whole batch rather than per artifact: the failure being
 * bounded is a conversation with several large artifacts none of which is on the
 * path, where the sum is the problem and no single one of them is. Past the
 * bound the artifact is still named — a model told an artifact exists and shown
 * nothing asks about it, which is recoverable; a model shown nothing at all
 * rewrites it.
 */
export const CARRIED_MAX_CHARS = 200_000;

/**
 * The sources the path does not hold, or null when it holds them all.
 *
 * Written to the model, like the state note, and appended after it. Each source
 * arrives in the shape the model is asked to produce — the same info string
 * `fenceInfo` writes — so what it reads is a block it can copy the identity off
 * rather than one it has to translate.
 */
export function formatCarriedSources(carried: readonly CarriedSource[]): string | null {
  if (carried.length === 0) return null;

  const blocks: string[] = [];
  let used = 0;

  for (const item of carried) {
    const title = item.title ? ` "${collapse(item.title)}"` : "";
    const missing = Object.entries(item.missing);
    const total = missing.reduce((sum, [, source]) => sum + source.length, 0);
    // Named in full whatever is sent: a model told which files exist can ask for
    // one it was not shown, where a model shown nothing rewrites the lot.
    const head = `The current version of id=${item.key} (${item.language})${title}, revision ${item.revision}, holds ${item.allPaths.join(", ")}. Some of it does not appear above.`;

    if (used + total > CARRIED_MAX_CHARS) {
      blocks.push(`[${head} Sources omitted for length.]`);
      continue;
    }
    used += total;

    blocks.push(
      [
        `[${head} These are the files missing from the conversation; to change them, reuse id=${item.key} with the same paths.]`,
        ...missing.flatMap(([path, source]) => {
          // Long enough for this source: an artifact holding a line of three
          // backticks would otherwise close its own fence and send the rest of
          // itself as prose.
          const fence = fenceFor(source);
          const tag = kindOf(path) ?? item.language;

          return [
            `${fence}${fenceInfo(tag, {
              key: item.key,
              path,
              title: path === item.entry ? item.title : null,
              entry: item.allPaths.length > 1 && path === item.entry,
            })}`,
            source,
            fence,
          ];
        }),
      ].join("\n"),
    );
  }

  return blocks.join("\n\n");
}

/**
 * Which artifacts the path already holds the current source of.
 *
 * The map is artifact id → the last message index holding it, which is what the
 * elision below needs; a caller that only wants presence reads `has`.
 *
 * A block is placed by identity: the id its fence carries, or the id an
 * `artifact-edit` part names. Without that, a block belonging to one artifact
 * counts for another artifact holding the same text — which elides a source the
 * model still needs, and leaves an absent one uncarried.
 */
export function currentSourcesOnPath(
  path: readonly Pick<Message, "role" | "parts">[],
  index: ArtifactContext["index"],
): Map<string, number> {
  const currentAt = new Map<string, number>();
  if (index.size === 0) return currentAt;

  path.forEach((message, at) => {
    for (const block of blocksOf(message)) {
      for (const ref of placeBlock(index.get(block.source) ?? [], block.identity)) {
        if (ref.isCurrent) currentAt.set(fileKey(ref.artifactId, ref.path), at);
      }
    }
  });

  return currentAt;
}

/**
 * One file of one artifact, as a map key.
 *
 * A null byte, because a path may hold every character an identifier may and the
 * two halves must not be able to run together into a third meaning.
 */
export function fileKey(artifactId: string, path: string): string {
  return `${artifactId}\u0000${path}`;
}

/**
 * Replace obsolete copies of an artifact's source with a line naming them.
 *
 * Two passes, because the decision needs the whole path first: pass one finds,
 * per artifact, the last message that holds its *current* source; pass two
 * replaces every earlier recorded block of that artifact.
 *
 * Blocks are rewritten in reverse order within a message so the line indices of
 * the ones not yet rewritten stay valid.
 *
 * What is never touched: a block that was never recorded as an artifact (an
 * ordinary code block, an empty fence, a deleted or expired artifact), a block
 * whose artifact's current source is not on this path at all, and a block in the
 * same message as that current source.
 *
 * The index is keyed by source text, and two artifacts can hold the same text —
 * so a block is placed by the id it carries, or by the id an `artifact-edit`
 * part names, before anything is elided. Without that, a block belonging to one
 * artifact is elided against another artifact's later copy: the placeholder
 * names the wrong id, and a source the model still needs leaves the path.
 *
 * A block that names no id is placed only when the text itself names exactly one
 * artifact. The tag is not enough — two same-language artifacts holding the same
 * text is precisely the case above — and a guess here costs the model a file.
 */
export function elideSupersededArtifacts(
  path: readonly Pick<Message, "role" | "parts">[],
  index: ArtifactContext["index"],
): Pick<Message, "role" | "parts">[] {
  if (index.size === 0) return [...path];

  /** File → the last message index holding its current source. */
  const currentAt = currentSourcesOnPath(path, index);

  /** Artifact → the last message index holding any current file of it. */
  const artifactAt = new Map<string, number>();
  for (const [key, at] of currentAt) {
    const artifactId = key.split("\u0000")[0];
    artifactAt.set(artifactId, Math.max(artifactAt.get(artifactId) ?? -1, at));
  }

  return path.map((message, at) => {
    /**
     * Whether this block is an obsolete copy of something the model can still see.
     *
     * Two rules, because "obsolete" means two different things.
     *
     * A block that *is* the current file is obsolete only against a later copy
     * of that same file — a model restating something it did not change, which
     * collapses to one copy and a line saying the two were identical.
     *
     * A block that is not current is obsolete as soon as the artifact visibly
     * moves on anywhere further down the path. Per artifact rather than per
     * file, because a rewrite can drop a file entirely: a page reworked as a
     * component leaves `index.html` with no successor at its own path, and it is
     * still dead weight the model should not be reading (§13). The later current
     * file is what guarantees the model is left with something rather than a
     * placeholder and nothing.
     */
    const movedOn = (ref: ArtifactSourceRef): boolean =>
      ref.isCurrent
        ? (currentAt.get(fileKey(ref.artifactId, ref.path)) ?? -1) > at
        : (artifactAt.get(ref.artifactId) ?? -1) > at;

    /**
     * The ref that decides this source's fate: the block's own artifact, if its
     * current version is further down the path.
     *
     * A text that *is* the current file is judged by the current rule alone. The
     * same text is also held by every older revision that left the file
     * unchanged, and those refs are not current — so asking "did any ref move
     * on?" found an old revision, saw the artifact change somewhere later, and
     * elided the only copy of a file no later write had touched. A project the
     * model revises one file at a time, as it is told to, lost every file it
     * left alone: "I can see the filenames, but not their contents" (§13).
     */
    const superseded = (source: string, identity: BlockIdentity): ArtifactSourceRef | null => {
      const refs = placeBlock(index.get(source) ?? [], identity);
      const current = refs.find((ref) => ref.isCurrent);
      if (current) return movedOn(current) ? current : null;
      return refs.find(movedOn) ?? null;
    };

    let changed = false;
    const parts = message.parts.map((part): MessagePart => {
      if (part.type === "artifact-edit") {
        // Every file the part carries has to be superseded before the part goes:
        // a multi-file edit whose stylesheet the model has since rewritten still
        // holds the pupil's own copy of the entry.
        const carried = editFilesOf(part);
        const refs = carried.map(({ path, source }) =>
          superseded(source, { artifactId: part.artifactId, path }),
        );
        if (refs.length === 0 || refs.some((ref) => ref === null)) return part;

        changed = true;
        // An `artifact-edit` part is a whole block on its own, so the whole part
        // becomes the placeholder rather than being rewritten in place.
        return { type: "text", text: placeholder(refs[0] as ArtifactSourceRef) };
      }

      if (part.type !== "text") return part;

      const lines = part.text.split("\n");
      let rewritten = false;

      for (const block of [...detectArtifacts(part.text)].reverse()) {
        const ref = superseded(block.source, { key: block.key, path: block.path });
        if (!ref) continue;

        lines.splice(block.line, block.endLine - block.line + 1, placeholder(ref));
        rewritten = true;
      }

      if (!rewritten) return part;
      changed = true;
      return { type: "text", text: lines.join("\n") };
    });

    return changed ? { ...message, parts } : message;
  });
}

/**
 * What a block says about which artifact it is.
 *
 * The id an `artifact-edit` part names is exact; the `id=` on a fence is what
 * the model itself wrote. A fence written before ids says nothing, and its tag
 * is not an identity — an artifact's language follows its key and can change
 * under it, so a block's tag matches neither one artifact nor only one.
 */
type BlockIdentity = {
  readonly artifactId?: string;
  readonly key?: string | null;
  /** The `path=` the block carried, when it carried one. */
  readonly path?: string | null;
};

function owns(ref: ArtifactSourceRef, identity: BlockIdentity): boolean {
  // A path narrows further, where the block stated one: an artifact holding the
  // same text at two paths is otherwise ambiguous between them.
  if (identity.path && ref.path !== identity.path) return false;

  return identity.artifactId !== undefined
    ? ref.artifactId === identity.artifactId
    : ref.key === identity.key;
}

/**
 * Which of a source's refs a block belongs to.
 *
 * Empty when nothing can be said: an unattributable block whose text two
 * artifacts hold. The tag is not enough — an artifact's language follows its key
 * and can change under it — and a guess here costs the model a file.
 */
function placeBlock(
  refs: readonly ArtifactSourceRef[],
  identity: BlockIdentity,
): readonly ArtifactSourceRef[] {
  if (refs.length === 0) return [];

  const matches =
    identity.artifactId !== undefined || (identity.key ?? null) !== null
      ? refs.filter((ref) => owns(ref, identity))
      : refs;
  // A legacy block supplies one file, even if several paths share its bytes.
  const files = new Set(matches.map((ref) => fileKey(ref.artifactId, ref.path)));
  return files.size === 1 ? matches : [];
}

/**
 * The files an `artifact-edit` part carries, path and all.
 *
 * A part written before projects carries only `source`, whose path is unknown —
 * so it is placed by artifact alone, exactly as it was.
 */
function editFilesOf(
  part: Extract<MessagePart, { type: "artifact-edit" }>,
): { path: string | null; source: string }[] {
  if (part.files) {
    return Object.entries(part.files).map(([path, source]) => ({ path, source }));
  }
  return [{ path: null, source: part.source }];
}

/** Every artifact block a message holds, with what it says about its identity. */
function blocksOf(message: Pick<Message, "parts">): { source: string; identity: BlockIdentity }[] {
  return message.parts.flatMap((part): { source: string; identity: BlockIdentity }[] => {
    if (part.type === "artifact-edit") {
      return editFilesOf(part).map(({ path, source }) => ({
        source,
        identity: { artifactId: part.artifactId, path },
      }));
    }
    if (part.type !== "text") return [];

    return detectArtifacts(part.text).map((block) => ({
      source: block.source,
      identity: { key: block.key, path: block.path },
    }));
  });
}

function placeholder(ref: ArtifactSourceRef): string {
  const what = ref.isCurrent
    ? "identical to the current version, which appears later in this conversation"
    : "superseded; the current version appears later in this conversation";

  return `[artifact id=${ref.key} (${ref.language}) revision ${ref.revision} — ${what}]`;
}
