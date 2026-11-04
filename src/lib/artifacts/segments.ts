import {
  type ArtifactFence,
  artifactFence,
  type DetectedArtifact,
  detectArtifacts,
  groupProjectWrites,
} from "./detect";
import { CARRIED, type OpenFence, type ScannedFences, scanFences } from "./fences";
import type { ProjectFileKind } from "./project";
import type { ArtifactLanguage } from "./types";

/**
 * A settled message split into prose and the artifacts inside it (PRD §13, §20).
 *
 * The transcript used to render an artifact block as a code block: a wall of
 * markup between two sentences, which is what a fenced block means to `marked`
 * and not what it means here. An artifact is a live document with a panel of its
 * own, so in the transcript it should be a card that opens it.
 *
 * The split is by line, over the same `detectArtifacts` the server records with,
 * so the transcript and the database cannot disagree about which blocks were
 * artifacts. Blocks it skips — an unrecognised tag, an empty body — stay inside
 * the prose and render as ordinary markdown, unchanged.
 */

export type ArtifactSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "artifact";
      /**
       * Position among the message's artifacts, counting from `firstIndex`.
       *
       * artifactMessageSegments numbers writes across the whole message;
       * artifactSegments can offset an isolated part with firstIndex.
       */
      readonly index: number;
      readonly artifact: DetectedArtifact;
      /** The block as written, fences included, for the fallback rendering. */
      readonly raw: string;
      /** Every path this write states, so the card can say how many files (§13). */
      readonly files: readonly string[];
    }
  /**
   * An artifact fence the message ends inside (§13, §20).
   *
   * A turn stopped mid-file — Stop pressed, a cap reached, a dropped connection
   * — leaves a fence with no closing line. It is not an artifact, and the server
   * records nothing for it; but rendered as markdown it is a code block running
   * to the end of the message, which is the wall of code the cards replace. So it
   * is its own segment, and the transcript keeps it collapsed.
   */
  | {
      readonly kind: "unclosed";
      readonly fence: ArtifactFence;
      /** The block as written, opening line included, for the collapsed view. */
      readonly raw: string;
    };

/**
 * Split one text part. `firstIndex` is how many artifacts earlier parts held.
 *
 * Text segments are emitted only when they hold something other than blank
 * lines: the gap between a paragraph and the block below it is not a paragraph.
 */
export function artifactSegments(markdown: string, firstIndex = 0): ArtifactSegment[] {
  return artifactMessageSegments([markdown])[0].map((segment) =>
    segment.kind === "artifact" ? { ...segment, index: segment.index + firstIndex } : segment,
  );
}

/** Group across the same joined text as the recorder, keeping each part's prose in place. */
export function artifactMessageSegments(texts: readonly string[]): ArtifactSegment[][] {
  const markdown = texts.join("\n");
  const scanned = scanFences(markdown);
  const lines = scanned.lines;
  const detected = detectArtifacts(markdown);
  const tailFence = scanned.open
    ? artifactFence(scanned.open.language, scanned.open.attributes)
    : null;
  /** Where the unclosed artifact fence begins; nothing from here on is prose. */
  const tail = tailFence && scanned.open ? scanned.open.line : lines.length;
  const writes = groupProjectWrites(detected);
  const cards = new Map<number, Extract<ArtifactSegment, { kind: "artifact" }>>();
  writes.forEach((write, index) => {
    const first = write.blocks[0];
    cards.set(first.line, {
      kind: "artifact",
      index,
      artifact: first,
      raw: write.blocks
        .map((block) => lines.slice(block.line, block.endLine + 1).join("\n"))
        .join("\n"),
      files: write.blocks.flatMap((block) => (block.path ? [block.path] : [])),
    });
  });

  let start = 0;
  return texts.map((text) => {
    const partEnd = start + text.split("\n").length;
    const end = Math.min(partEnd, tail);
    const segments: ArtifactSegment[] = [];
    let at = start;
    const prose = (from: number, to: number) => {
      const text = lines.slice(from, to).join("\n");
      if (text.trim()) segments.push({ kind: "text", text });
    };

    // Walk individual ranges in document order. Grouping must never swallow
    // prose or another project's fences between files of the same write.
    for (const block of detected) {
      if (block.endLine < start || block.line >= end) continue;
      prose(at, Math.max(at, block.line));
      const card = cards.get(block.line);
      if (card && block.line >= start) segments.push(card);
      at = Math.min(end, block.endLine + 1);
    }
    prose(at, end);
    if (tailFence && tail >= start && tail < partEnd) {
      segments.push({ kind: "unclosed", fence: tailFence, raw: lines.slice(tail).join("\n") });
    }
    start = partEnd;
    return segments;
  });
}

/**
 * A message still arriving, split just far enough to hide the markup (§13, §20).
 *
 * Prose stays an unparsed paragraph while a turn streams — re-parsing and
 * re-highlighting a growing message on every delta is the work that drops frames
 * on the target hardware, and that decision stands. What does not stand is
 * showing the artifact itself as prose: a pupil who asked for a page watched
 * `<!doctype html>` scroll past for the length of the file.
 *
 * So the boundaries are scanned and nothing else is: one `split("\n")` and one
 * regular expression per line, no markdown and no highlighting. Every artifact
 * fence collapses to a stub — a closed one naming what was built, the trailing
 * open one saying it is being built. When the turn settles the real cards
 * replace them through `artifactSegments`, which is where the refs exist.
 */
export type StreamingSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "artifact"; readonly artifact: DetectedArtifact }
  /** The fence the message ends inside: a title and a language, and no source yet. */
  | {
      readonly kind: "pending";
      /**
       * The runnable language, or null for a file that is only imported — a
       * stylesheet or a data module, which a revision re-emits on its own (§13).
       */
      readonly language: ArtifactLanguage | null;
      /** The fence tag, runnable or not, so a stub can say what kind of file it is. */
      readonly fileKind: ProjectFileKind;
      /** The `delete` flag: this file is being removed rather than written. */
      readonly deleted: boolean;
      readonly key: string | null;
      readonly title: string | null;
      /**
       * How many lines of the file have arrived so far (§20).
       *
       * A long artifact can take a minute to write, and a stub that says only
       * "building" for the whole of it looks stuck. A count that climbs is the
       * cheapest honest sign that something is happening.
       */
      readonly lines: number;
      /** Which file of the project is arriving, when the fence named one. */
      readonly path: string | null;
    };

/** Anything that is not whitespace, tested without allocating a trimmed copy. */
const NON_BLANK = /\S/;

/**
 * How many lines a fence body holds, given the rows it was split into.
 *
 * A body ending in a newline has finished its last line; one ending mid-line is
 * still on it, and that line counts — the pupil can see it being typed.
 */
function bodyLines(rows: readonly string[]): number {
  if (rows.length === 0) return 0;
  return rows.length - 1 + (rows.at(-1) === "" ? 0 : 1);
}

/** Newlines in a piece, counted without allocating a split of it. */
function countNewlines(piece: string): number {
  let count = 0;
  for (let at = piece.indexOf("\n"); at !== -1; at = piece.indexOf("\n", at + 1)) count++;
  return count;
}

export function streamingSegments(markdown: string): StreamingSegment[] {
  // The scanner's own line array, not a second split of the same string: this
  // runs on every delta of a growing message, and §20 budgets it at one pass.
  return segmentsOf(scanFences(markdown), null);
}

/**
 * A whole streaming message's text parts, scanned as one document (§13, §20).
 *
 * Prose arrives as several parts: `StreamingTurn` starts a new one wherever a
 * tool call or a generated image landed between two deltas. Scanned apart, a
 * fence that spans one of those boundaries is lost — the part after it has no
 * opening line, so the pupil watches the rest of their page arrive as prose,
 * which is the one thing the stub card exists to prevent.
 *
 * So every open fence is carried from part to part, an ordinary code block's as
 * much as an artifact's: a `js` block whose closing line lands in the next part
 * would otherwise leave that line reading as an *opening* one, and the artifact
 * behind it parsed as the body of a code block.
 *
 * The part that opened a fence owns its card, and the parts continuing it render
 * only what follows the close — so one artifact is one stub, wherever the tool
 * call fell inside it. When the fence does close, that stub stops saying the
 * artifact is being built and names it, in the place it has been all along.
 *
 * Each part is still scanned by line, so a boundary that fell mid-line leaves
 * the two halves as two lines for the length of the scan. That is only ever
 * wrong for a delta that stopped immediately before a line the scan would read
 * as a fence, and only until the turn settles.
 *
 * Returns one segment list per text given, in the order they were given.
 */
export function streamingMessageSegments(texts: readonly string[]): StreamingSegment[][] {
  const scans: StreamingSegment[][] = [];
  let carried: OpenFence | null = null;
  /**
   * The scan whose stub owns the open fence, the pieces of source it has
   * collected, and whether any of them holds anything.
   *
   * `bodied` is carried rather than derived: this whole walk runs again on every
   * delta, and re-reading the pieces collected so far to answer one boolean
   * would make a long artifact cost more with every part it crosses. They are
   * joined once, when the fence closes and a card needs its source.
   */
  let stub: {
    at: number;
    open: OpenFence;
    source: string[];
    bodied: boolean;
    /**
     * The running line count, kept incrementally for the same reason `bodied`
     * is: this walk runs again on every delta, and re-joining the source to
     * count its lines would make a long artifact cost more with every part it
     * crosses.
     */
    newlines: number;
    endsWithNewline: boolean;
    nonEmpty: boolean;
  } | null = null;

  texts.forEach((text, at) => {
    const scanned = scanFences(text, carried);

    // At most one block can have opened before this part: the carried one, and
    // nothing else can open until it closes.
    const closed = scanned.blocks.find((block) => block.line === CARRIED);
    const piece = closed ? closed.source : text;
    const bodied = stub ? stub.bodied || NON_BLANK.test(piece) : false;

    // Whether the carried block has a body at all is the caller's to know: it is
    // spread across the parts the fence crossed, and the scan sees one of them.
    scans.push(segmentsOf(scanned, carried ? { bodied } : null));

    if (stub && closed) {
      // Joined with nothing: each piece is the exact substring of its part, and
      // `StreamingTurn` concatenates deltas rather than adding a line between
      // them — a boundary that fell mid-line is one line again here.
      // A deletion is the one write that has no body, and still a write.
      const deleting = artifactFence(stub.open.language, stub.open.attributes)?.deleted;
      if (bodied || deleting) {
        nameStub(scans[stub.at], stub.open, [...stub.source, piece].join(""));
      } else unbuildStub(scans[stub.at], texts[stub.at], stub.open);
      stub = null;
    } else if (stub) {
      // Still open, so the whole of this part is inside it.
      stub.source.push(text);
      stub.bodied = bodied;
      stub.newlines += countNewlines(text);
      if (text.length > 0) {
        stub.nonEmpty = true;
        stub.endsWithNewline = text.endsWith("\n");
      }
      growStub(scans[stub.at], stub.newlines + (stub.nonEmpty && !stub.endsWithNewline ? 1 : 0));
    }

    const open = scanned.open;
    carried = open;
    if (!open || open.line === CARRIED) return;

    // A fence opened here and is still open: this part owns its stub, if the
    // fence is one the transcript shows a stub for at all.
    if (!artifactFence(open.language, open.attributes)) {
      stub = null;
      return;
    }

    const rows = scanned.lines.slice(open.line + 1);
    const head = rows.join("\n");
    stub = {
      at,
      open,
      source: [head],
      bodied: NON_BLANK.test(head),
      newlines: Math.max(0, rows.length - 1),
      endsWithNewline: rows.at(-1) === "",
      nonEmpty: head.length > 0,
    };
  });

  return scans;
}

/** Update the line count on a stub whose fence later parts are still filling. */
function growStub(segments: StreamingSegment[], lines: number): void {
  const at = segments.findIndex((segment) => segment.kind === "pending");
  const pending = at === -1 ? null : segments[at];
  if (pending?.kind !== "pending") return;

  segments[at] = { ...pending, lines };
}

/**
 * Turn the stub that said an artifact was being built into the artifact itself.
 *
 * It stays in the part that opened the fence rather than moving to the one that
 * closed it: a card that jumps below the tool call which interrupted it, halfway
 * through a stream, is worse than one that stays where the pupil last saw it.
 */
function nameStub(segments: StreamingSegment[], open: OpenFence, source: string): void {
  const at = segments.findIndex((segment) => segment.kind === "pending");
  const fence = artifactFence(open.language, open.attributes);
  if (at === -1 || !fence) return;

  segments[at] = {
    kind: "artifact",
    artifact: { ...fence, source, line: open.line, endLine: CARRIED },
  };
}

/**
 * Put a stub back as the fence it was written as, when it held nothing.
 *
 * An empty block is not an artifact — `detectArtifacts` skips it and the settled
 * transcript renders it as written — and the two must not disagree about which
 * blocks were artifacts. Folded into the prose above it where there is any, so
 * what the pupil sees is what a single scan of the whole message would give.
 */
function unbuildStub(segments: StreamingSegment[], text: string, open: OpenFence): void {
  const at = segments.findIndex((segment) => segment.kind === "pending");
  if (at === -1) return;

  const raw = text.split("\n").slice(open.line).join("\n");
  const above = segments[at - 1];

  if (above?.kind === "text") {
    segments.splice(at - 1, 2, { kind: "text", text: `${above.text}\n${raw}` });
    return;
  }

  segments[at] = { kind: "text", text: raw };
}

/**
 * `carriedIn` says the scan began inside a fence an earlier part opened, whose
 * stub that part is already showing — so the block it closes here, and the
 * pending it may still be inside, belong there and are not repeated. Its
 * `bodied` is whether that block has a body anywhere across the parts it
 * crossed, which this scan cannot see for itself.
 */
function segmentsOf(
  scanned: ScannedFences,
  carriedIn: { readonly bodied: boolean } | null,
): StreamingSegment[] {
  const { blocks, open, lines } = scanned;
  const pending = open ? artifactFence(open.language, open.attributes) : null;

  // A fence that is open but not an artifact — a bare ``` or a js block — is
  // ordinary prose and stays in the paragraph, exactly as it does today.
  const end = pending && open ? Math.max(open.line, 0) : lines.length;

  const segments: StreamingSegment[] = [];
  let at = 0;

  for (const block of blocks) {
    const fence = artifactFence(block.language, block.attributes);
    const carried = block.line === CARRIED;
    // An empty body is not an artifact, here as on the settled path — but a
    // carried block's body is spread over the parts it crossed, so what this
    // scan holds of it says nothing about whether there is one.
    const empty = fence?.deleted ? false : carried ? !carriedIn?.bodied : !block.source.trim();
    if (!fence || empty) continue;

    const before = lines.slice(at, Math.max(block.line, 0)).join("\n");
    if (before.trim()) segments.push({ kind: "text", text: before });

    at = block.endLine + 1;
    if (carried) continue;

    segments.push({
      kind: "artifact",
      artifact: { ...fence, source: block.source, line: block.line, endLine: block.endLine },
    });
  }

  const after = lines.slice(at, end).join("\n");
  if (after.trim()) segments.push({ kind: "text", text: after });

  if (pending && open && !(carriedIn && open.line === CARRIED)) {
    segments.push(pendingSegment(pending, bodyLines(lines.slice(open.line + 1))));
  }

  return segments;
}

function pendingSegment(
  fence: ArtifactFence,
  lines: number,
): Extract<StreamingSegment, { kind: "pending" }> {
  return {
    kind: "pending",
    language: fence.language,
    fileKind: fence.kind,
    deleted: fence.deleted,
    key: fence.key,
    title: fence.title,
    lines,
    path: fence.path,
  };
}

/** How many artifacts a piece of prose holds — the running count between parts. */
export function artifactSegmentCount(markdown: string): number {
  // Writes, not fences: three fences under one id are one card and one recorded
  // revision, and counting them separately would put the transcript's cards out
  // of step with what the server stored (§13).
  return groupProjectWrites(detectArtifacts(markdown)).length;
}

/**
 * Which recorded revision each card of a settled message stands for (§13).
 *
 * The refs come from the database and the cards from the text, and the two
 * usually line up one for one. When they do not — an identical re-emission
 * appends no revision, a write over the caps records nothing — the transcript
 * used to give up on the whole message and render every fence as written, so
 * one restated stylesheet put the whole page's code in the chat.
 *
 * So the pairing is per card: by position when the two agree throughout, and
 * otherwise by the id the fence wrote. A card nothing pairs with gets null, and
 * the transcript keeps that one contained rather than naming a revision the
 * database does not have.
 *
 * Returned in card-index order.
 */
export function pairArtifactRefs<Ref extends { readonly key: string; readonly language: string }>(
  cards: readonly Extract<ArtifactSegment, { kind: "artifact" }>[],
  refs: readonly Ref[],
): (Ref | null)[] {
  const ordered = [...cards].sort((a, b) => a.index - b.index);

  const positional =
    refs.length === ordered.length &&
    ordered.every((card) => {
      const ref = refs[card.index];
      // A write whose first fence is a plain file — a revision that changed only
      // the stylesheet — states no language of its own, so the ref's tag stands.
      return (
        ref !== undefined && (!card.artifact.language || ref.language === card.artifact.language)
      );
    });
  if (positional) return ordered.map((card) => refs[card.index]);

  const used = new Set<number>();
  const written = new Set(
    ordered.flatMap((card) => (card.artifact.key ? [card.artifact.key] : [])),
  );
  let cursor = 0;

  return ordered.map((card) => {
    const { key, language } = card.artifact;
    const at = key
      ? refs.findIndex((ref, index) => !used.has(index) && ref.key === key)
      : // A key-less block's ref carries a derived key, so it is found by order
        // and language among the refs no written id claims.
        refs.findIndex(
          (ref, index) =>
            index >= cursor &&
            !used.has(index) &&
            !written.has(ref.key) &&
            ref.language === language,
        );
    if (at === -1) return null;

    used.add(at);
    cursor = at + 1;
    return refs[at];
  });
}
