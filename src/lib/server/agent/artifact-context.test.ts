import { beforeEach, describe, expect, it } from "bun:test";
import { defaultPathFor } from "../../artifacts/project";
import type { ArtifactLanguage } from "../../artifacts/types";
import type { AppDatabase } from "../db/client";
import { appendSnapshot, recordVersionBuild } from "../db/queries/artifacts";
import { createConversation } from "../db/queries/conversations";
import { appendMessage } from "../db/queries/messages";
import type { Message, MessagePart } from "../db/schema";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import {
  buildArtifactContext,
  CARRIED_MAX_CHARS,
  type CarriedSource,
  elideSupersededArtifacts,
  formatArtifactState,
  formatCarriedSources,
} from "./artifact-context";
import { recordTurnArtifacts } from "./artifacts";

/**
 * Append a one-file revision, the way every caller did before projects.
 *
 * These suites are about continuity, ordering and elision rather than about
 * file layout, so they keep saying "here is the source" and this puts it at the
 * conventional path for its language.
 */
function appendSource(
  db: AppDatabase,
  input: {
    artifactId: string;
    messageId?: string | null;
    source: string;
    language?: ArtifactLanguage | null;
    authoredBy: "model" | "student";
  },
) {
  const entry = defaultPathFor(input.language ?? "html");
  return appendSnapshot(db, { ...input, entry, files: { [entry]: input.source } });
}

/**
 * What the model is told about the artifacts it has written (PRD §13).
 *
 * Two things are asserted here and both are about *not* lying to the model: the
 * note describes each artifact as it stands, and the elision only removes a copy
 * of a source the model will see again further down the same path.
 */

let db: AppDatabase;
let fixtures: ReturnType<typeof seedTestFixtures>;
let conversationId: string;

beforeEach(() => {
  db = createTestDatabase();
  fixtures = seedTestFixtures(db);
  conversationId = createConversation(db, {
    studentId: fixtures.student.id,
    modelAliasId: fixtures.alias.id,
  }).id;
});

function assistantTurn(text: string) {
  const message = appendMessage(db, {
    conversationId,
    parentId: null,
    role: "assistant",
    parts: [{ type: "text", text }],
  });

  return recordTurnArtifacts(db, {
    studentId: fixtures.student.id,
    conversationId,
    messageId: message.id,
    parts: [{ type: "text", text }],
  });
}

function context(...onPath: Pick<Message, "role" | "parts">[]) {
  return buildArtifactContext(db, {
    conversationId,
    studentId: fixtures.student.id,
    path: onPath,
  });
}

function path(
  ...messages: { role: "user" | "assistant"; parts: MessagePart[] }[]
): Pick<Message, "role" | "parts">[] {
  return messages;
}

function assistant(text: string) {
  return { role: "assistant" as const, parts: [{ type: "text" as const, text }] };
}

function user(text: string) {
  return { role: "user" as const, parts: [{ type: "text" as const, text }] };
}

describe("buildArtifactContext", () => {
  it("indexes every stored source and marks the current one", () => {
    const [first] = assistantTurn("```html id=side\n<p>en</p>\n```");
    assistantTurn("```html id=side\n<p>to</p>\n```");

    const { index } = context();

    expect(index.get("<p>en</p>")?.[0]).toMatchObject({
      artifactId: first.artifactId,
      key: "side",
      language: "html",
      revision: 1,
      isCurrent: false,
    });
    expect(index.get("<p>to</p>")?.[0].isCurrent).toBe(true);
  });

  it("describes each artifact as it stands now", () => {
    assistantTurn('```html id=side title="Min side"\n<p>en</p>\n```');
    assistantTurn("```svg id=logo\n<svg/>\n```");

    const note = formatArtifactState(context().state);

    expect(note).toContain('id=side (html) "Min side" — revision 1, last written by you');
    expect(note).toContain("id=logo (svg) — revision 1, last written by you, not run yet");
  });

  it("states a failed run, collapsed onto one line", () => {
    const [recorded] = assistantTurn("```html id=side\n<p>en</p>\n```");
    recordVersionBuild(db, {
      artifactId: recorded.artifactId,
      versionId: recorded.versionId,
      studentId: fixtures.student.id,
      status: "failed",
      message: "SyntaxError:\n  unexpected `token`",
    });

    const note = formatArtifactState(context().state);

    expect(note).toContain("last run failed: SyntaxError: unexpected token");
    expect(note?.split("\n").filter((line) => line.includes("last run failed"))).toHaveLength(1);
  });

  it("tells a run that mounted and then threw from one that failed", () => {
    const [recorded] = assistantTurn("```html id=side\n<p>en</p>\n```");
    recordVersionBuild(db, {
      artifactId: recorded.artifactId,
      versionId: recorded.versionId,
      studentId: fixtures.student.id,
      status: "threw",
      message: "TypeError: t.score is not a function",
    });

    // "Last run failed" for a page the pupil is looking at asks for a rewrite;
    // this asks for the one error that is actually wrong (§13).
    expect(formatArtifactState(context().state)).toContain(
      "ran, then threw: TypeError: t.score is not a function",
    );
  });

  it("names the pupil when the newest revision is theirs", () => {
    const [recorded] = assistantTurn("```html id=side\n<p>en</p>\n```");
    appendSource(db, {
      artifactId: recorded.artifactId,
      source: "<p>min</p>",
      authoredBy: "student",
    });

    expect(formatArtifactState(context().state)).toContain("last written by the pupil");
  });

  it("has nothing to say about a conversation that built nothing", () => {
    expect(formatArtifactState(context().state)).toBeNull();
  });
});

describe("elideSupersededArtifacts", () => {
  it("replaces an earlier copy of a source the model will see again", () => {
    assistantTurn("```html id=side\n<p>en</p>\n```");
    assistantTurn("```html id=side\n<p>to</p>\n```");

    const elided = elideSupersededArtifacts(
      path(
        assistant("Her:\n```html id=side\n<p>en</p>\n```\nSådan."),
        assistant("Nu:\n```html id=side\n<p>to</p>\n```"),
      ),
      context().index,
    );

    const first = elided[0].parts[0];
    expect(first.type === "text" && first.text).toBe(
      "Her:\n[artifact id=side (html) revision 1 — superseded; the current version appears later in this conversation]\nSådan.",
    );
    // The newest copy is the one the model works from; it is never touched.
    const second = elided[1].parts[0];
    expect(second.type === "text" && second.text).toContain("<p>to</p>");
  });

  it("names a repeated current source as identical rather than superseded", () => {
    assistantTurn("```html id=side\n<p>en</p>\n```");

    const elided = elideSupersededArtifacts(
      path(
        assistant("```html id=side\n<p>en</p>\n```"),
        assistant("```html id=side\n<p>en</p>\n```"),
      ),
      context().index,
    );

    const first = elided[0].parts[0];
    expect(first.type === "text" && first.text).toContain("identical to the current version");
  });

  it("keeps two blocks of one message when neither is superseded", () => {
    assistantTurn("```html id=side\n<p>en</p>\n```\n```svg id=logo\n<svg/>\n```");

    const message = assistant("```html id=side\n<p>en</p>\n```\nog\n```svg id=logo\n<svg/>\n```");
    const elided = elideSupersededArtifacts(path(message), context().index);

    expect(elided[0].parts[0]).toEqual(message.parts[0]);
  });

  it("elides both blocks of one message when both are superseded", () => {
    assistantTurn("```html id=side\n<p>en</p>\n```\n```svg id=logo\n<svg/>\n```");
    assistantTurn('```html id=side\n<p>to</p>\n```\n```svg id=logo\n<svg width="1"/>\n```');

    const elided = elideSupersededArtifacts(
      path(
        assistant("```html id=side\n<p>en</p>\n```\nog\n```svg id=logo\n<svg/>\n```"),
        assistant('```html id=side\n<p>to</p>\n```\n```svg id=logo\n<svg width="1"/>\n```'),
      ),
      context().index,
    );

    const first = elided[0].parts[0];
    expect(first.type === "text" && first.text).toBe(
      "[artifact id=side (html) revision 1 — superseded; the current version appears later in this conversation]\nog\n[artifact id=logo (svg) revision 1 — superseded; the current version appears later in this conversation]",
    );
  });

  it("leaves a block in the same message as the current source alone", () => {
    assistantTurn("```html id=side\n<p>en</p>\n```\n```html id=side\n<p>to</p>\n```");

    const message = assistant("```html id=side\n<p>en</p>\n```\n```html id=side\n<p>to</p>\n```");
    const elided = elideSupersededArtifacts(path(message), context().index);

    expect(elided[0].parts[0]).toEqual(message.parts[0]);
  });

  it("leaves an ordinary code block and an empty fence alone", () => {
    assistantTurn("```html id=side\n<p>en</p>\n```");

    const message = assistant("```js\nconst x = 1;\n```\n```html\n\n```");
    const elided = elideSupersededArtifacts(path(message), context().index);

    expect(elided[0].parts[0]).toEqual(message.parts[0]);
  });

  it("leaves a block alone when its current source is not on this path", () => {
    // A branch the pupil stepped away from: the newest revision is real, but the
    // model will never see it here, so the copy it does see must be complete.
    assistantTurn("```html id=side\n<p>en</p>\n```");
    assistantTurn("```html id=side\n<p>to</p>\n```");

    const message = assistant("```html id=side\n<p>en</p>\n```");
    const elided = elideSupersededArtifacts(path(message), context().index);

    expect(elided[0].parts[0]).toEqual(message.parts[0]);
  });

  it("leaves a deleted artifact's block alone", () => {
    const message = assistant("```html id=vaek\n<p>en</p>\n```");

    expect(elideSupersededArtifacts(path(message), context().index)[0]).toEqual(message);
  });

  it("keeps a delivered student edit that is still the current source", () => {
    const [recorded] = assistantTurn("```html id=side\n<p>en</p>\n```");
    const version = appendSource(db, {
      artifactId: recorded.artifactId,
      source: "<p>min</p>",
      authoredBy: "student",
    });

    const edit: MessagePart = {
      type: "artifact-edit",
      artifactId: recorded.artifactId,
      versionId: version.id,
      language: "html",
      title: null,
      source: "<p>min</p>",
      key: "side",
    };

    const elided = elideSupersededArtifacts(
      path({ role: "user", parts: [{ type: "text", text: "se her" }, edit] }),
      context().index,
    );

    expect(elided[0].parts[1]).toEqual(edit);
  });

  it("turns a re-carried edit into a placeholder once the model has rewritten it", () => {
    const [recorded] = assistantTurn("```html id=side\n<p>en</p>\n```");
    const version = appendSource(db, {
      artifactId: recorded.artifactId,
      source: "<p>min</p>",
      authoredBy: "student",
    });
    assistantTurn("```html id=side\n<p>rettet</p>\n```");

    const edit: MessagePart = {
      type: "artifact-edit",
      artifactId: recorded.artifactId,
      versionId: version.id,
      language: "html",
      title: null,
      source: "<p>min</p>",
      key: "side",
    };

    const elided = elideSupersededArtifacts(
      path({ role: "user", parts: [edit] }, assistant("```html id=side\n<p>rettet</p>\n```")),
      context().index,
    );

    expect(elided[0].parts[0]).toEqual({
      type: "text",
      text: "[artifact id=side (html) revision 2 — superseded; the current version appears later in this conversation]",
    });
  });

  it("elides a block against its own artifact, not another holding the same text", () => {
    // Two artifacts can hold byte-identical source — a pupil asking for "the
    // same page again under a new id" is the ordinary way. The index is keyed by
    // text, so without the id the wrong artifact decides both blocks' fate.
    assistantTurn("```html id=side\n<p>ens</p>\n```");
    assistantTurn("```html id=kopi\n<p>ens</p>\n```");
    // Only `side` moves on; `kopi` still holds the shared text as its current
    // source and must reach the model in full.
    assistantTurn("```html id=side\n<p>ny</p>\n```");

    const elided = elideSupersededArtifacts(
      path(
        assistant("```html id=side\n<p>ens</p>\n```"),
        assistant("```html id=kopi\n<p>ens</p>\n```"),
        assistant("```html id=side\n<p>ny</p>\n```"),
      ),
      context().index,
    );

    expect(elided[0].parts[0]).toEqual({
      type: "text",
      text: "[artifact id=side (html) revision 1 — superseded; the current version appears later in this conversation]",
    });
    expect(elided[1].parts[0]).toEqual({
      type: "text",
      text: "```html id=kopi\n<p>ens</p>\n```",
    });
  });

  it("leaves an unattributable block alone when two artifacts hold its text", () => {
    // No id on the fence, and the tag cannot tell them apart. Eliding either
    // would drop a source that is still the other artifact's current one.
    assistantTurn("```html\n<p>ens</p>\n```");
    const second = assistantTurn("```html id=kopi\n<p>ens</p>\n```");
    assistantTurn("```html id=kopi\n<p>ny</p>\n```");
    expect(second[0].artifactId).toBeDefined();

    const elided = elideSupersededArtifacts(
      path(
        assistant("```html\n<p>ens</p>\n```"),
        assistant("```html id=kopi\n<p>ens</p>\n```"),
        assistant("```html id=kopi\n<p>ny</p>\n```"),
      ),
      context().index,
    );

    expect(elided[0].parts[0]).toEqual({ type: "text", text: "```html\n<p>ens</p>\n```" });
    expect(elided[1].parts[0]).toEqual({
      type: "text",
      text: "[artifact id=kopi (html) revision 1 — superseded; the current version appears later in this conversation]",
    });
  });

  it("still elides an id-less block whose artifact has since changed language", () => {
    // A block is never placed by its tag, so a row rewritten under a new one
    // goes on compressing its own legacy blocks. What the placeholder *names* is
    // the tag that revision was written under, which is the html it really was.
    const first = assistantTurn("```html\n<p>gammel</p>\n```");
    assistantTurn(`\`\`\`svelte id=${first[0].key}\n<p>ny</p>\n\`\`\``);

    const elided = elideSupersededArtifacts(
      path(
        assistant("```html\n<p>gammel</p>\n```"),
        assistant(`\`\`\`svelte id=${first[0].key}\n<p>ny</p>\n\`\`\``),
      ),
      context().index,
    );

    expect(elided[0].parts[0]).toEqual({
      type: "text",
      text: `[artifact id=${first[0].key} (html) revision 1 — superseded; the current version appears later in this conversation]`,
    });
  });

  it("does nothing at all when the conversation has built nothing", () => {
    const given = path(user("hej"), assistant("```html\n<p>en</p>\n```"));

    expect(elideSupersededArtifacts(given, context().index)).toEqual(given);
  });
});

describe("carried sources", () => {
  it("carries the current source when the path stops at an earlier revision", () => {
    const [recorded] = assistantTurn("```html id=side\n<p>en</p>\n```");
    assistantTurn("```html id=side\n<p>to</p>\n```");
    expect(recorded.artifactId).toBeDefined();

    // A pupil editing an earlier prompt sends a path from the branch they left:
    // revision 2 is named by the state note and present nowhere (§13).
    const { carried } = context(assistant("```html id=side\n<p>en</p>\n```"));

    expect(carried).toEqual([
      {
        key: "side",
        language: "html",
        title: null,
        revision: 2,
        entry: "index.html",
        allPaths: ["index.html"],
        missing: { "index.html": "<p>to</p>" },
      },
    ]);
  });

  it("carries nothing when the path already holds the current source", () => {
    assistantTurn("```html id=side\n<p>en</p>\n```");
    assistantTurn("```html id=side\n<p>to</p>\n```");

    expect(
      context(
        assistant("```html id=side\n<p>en</p>\n```"),
        assistant("```html id=side\n<p>to</p>\n```"),
      ).carried,
    ).toEqual([]);
  });

  it("counts the pupil's own edit part as holding the source", () => {
    const [recorded] = assistantTurn("```html id=side\n<p>en</p>\n```");
    const version = appendSource(db, {
      artifactId: recorded.artifactId,
      source: "<p>min</p>",
      authoredBy: "student",
    });

    // The edit is appended to the prompt before the path is read, so carrying it
    // again would send the same file twice (§13).
    const edit: MessagePart = {
      type: "artifact-edit",
      artifactId: recorded.artifactId,
      versionId: version.id,
      language: "html",
      title: null,
      source: "<p>min</p>",
      key: "side",
    };

    expect(context({ role: "user", parts: [edit] }).carried).toEqual([]);
  });

  it("carries an artifact no message on the path mentions at all", () => {
    assistantTurn("```html id=side\n<p>en</p>\n```");

    expect(context(user("Byg noget andet")).carried.map((item) => item.key)).toEqual(["side"]);
  });

  it("places a block by identity, so a twin's text does not stand in for it", () => {
    // Two artifacts holding byte-identical current sources. Only `side`'s block
    // is on the path, and text alone would say both were held (§13).
    assistantTurn("```html id=side\n<p>ens</p>\n```");
    assistantTurn("```html id=kopi\n<p>ens</p>\n```");

    const { carried } = context(assistant("```html id=side\n<p>ens</p>\n```"));

    expect(carried.map((item) => item.key)).toEqual(["kopi"]);
  });
});

describe("formatCarriedSources", () => {
  const item: CarriedSource = {
    key: "side",
    language: "html",
    title: "Min side",
    revision: 2,
    entry: "index.html",
    allPaths: ["index.html"],
    missing: { "index.html": "<p>to</p>" },
  };

  it("has nothing to say when the path holds everything", () => {
    expect(formatCarriedSources([])).toBeNull();
  });

  it("names the artifact, then hands over the file in the shape it asks for", () => {
    const text = formatCarriedSources([item]);

    expect(text).toContain('id=side (html) "Min side", revision 2, holds index.html.');
    expect(text).toContain("reuse id=side with the same paths.]");
    // The same info string the model is asked to write, so it can copy the
    // identity off the block rather than translate it (§13).
    expect(text).toContain('```html id=side path=index.html title="Min side"');
    expect(text).toContain("\n<p>to</p>\n");
  });

  it("opens a longer fence for a source that holds a fence of its own", () => {
    const source = ["<p>Sådan skriver du kode:</p>", "```", "et loop", "```"].join("\n");
    const text = formatCarriedSources([{ ...item, missing: { "index.html": source } }]);

    // A three-backtick fence would close on the artifact's own line, and the
    // rest of the file would reach the model as prose.
    expect(text).toContain("````html id=side");
    expect(text?.endsWith("````")).toBe(true);
    expect(text).toContain(source);
  });

  it("names an artifact it cannot afford to send, rather than dropping it", () => {
    const big = {
      ...item,
      key: "stor",
      missing: { "index.html": "x".repeat(CARRIED_MAX_CHARS + 1) },
    };
    const text = formatCarriedSources([big, { ...item, key: "lille" }]);

    // Named either way: a model told an artifact exists and shown nothing asks
    // about it; a model shown nothing at all rewrites it (§13).
    expect(text).toContain("id=stor (html)");
    expect(text).toContain("Sources omitted for length.]");
    expect(text).not.toContain("x".repeat(100));

    // And the one that fits is still sent whole, past the one that did not.
    expect(text).toContain('```html id=lille path=index.html title="Min side"');
    expect(text).toContain("<p>to</p>");
  });

  it("bounds the batch and not each source, which is where the sum matters", () => {
    const half = "y".repeat(CARRIED_MAX_CHARS * 0.75);
    const text = formatCarriedSources([
      { ...item, key: "en", missing: { "index.html": half } },
      { ...item, key: "to", missing: { "index.html": half } },
    ]);

    expect(text).toContain('```html id=en path=index.html title="Min side"');
    expect(text).toContain("id=to (html)");
    expect(text).toContain("Sources omitted for length.]");
  });
});

/**
 * A project's context, per file (PRD §13, §22).
 *
 * The elision and the carrying both work file by file now: a revision that
 * changed only the stylesheet leaves four of its five files at exactly the text
 * an earlier revision holds, and eliding those is the whole point.
 */
describe("projects in the model's context", () => {
  it("carries identical files when a legacy block does not name a unique path", () => {
    assistantTurn(
      "```html id=side path=index.html\nsame\n```\n```html id=side path=other.html\nsame\n```",
    );
    const legacy = context(assistant("```html id=side\nsame\n```"));
    expect(legacy.carried[0].missing).toEqual({ "index.html": "same", "other.html": "same" });
    const named = context(assistant("```html id=side path=index.html\nsame\n```"));
    expect(named.carried[0].missing).toEqual({ "other.html": "same" });
  });
  const project = [
    '```tsx id=tid path=src/App.tsx title="Tidslinje" entry',
    "app",
    "```",
    "```css id=tid path=src/styles.css",
    "css",
    "```",
  ].join("\n");

  it("lists every file with its length, and marks the entry", () => {
    assistantTurn(project);
    const { state } = context();

    expect(state[0].files).toEqual([
      { path: "src/App.tsx", lines: 1, isEntry: true },
      { path: "src/styles.css", lines: 1, isEntry: false },
    ]);

    const note = formatArtifactState(state);
    expect(note).toContain("files: src/App.tsx (1 lines, entry), src/styles.css (1 lines)");
    expect(note).toContain("writing only the");
  });

  it("elides the file a later write replaced and keeps the one it did not", () => {
    assistantTurn(project);
    assistantTurn("```css id=tid path=src/styles.css\nny css\n```");

    const elided = elideSupersededArtifacts(
      path(assistant(project), assistant("```css id=tid path=src/styles.css\nny css\n```")),
      context().index,
    );

    const first = elided[0].parts[0];
    const text = first.type === "text" ? first.text : "";

    // The entry is untouched — it is still the current copy of that file. The
    // whole fence, not the word: "app" is also inside "appears", which is what
    // the placeholder replacing it says.
    expect(text).toContain('```tsx id=tid path=src/App.tsx title="Tidslinje" entry\napp\n```');
    // The stylesheet the model has since rewritten is gone.
    expect(text).not.toContain("\ncss\n");
    expect(text).toContain("superseded");
  });

  it("keeps the only copy of a file no later write touched (the driving game)", () => {
    // Reported from a classroom: "I can see the filenames in the project overview,
    // but not their contents." The model revised one file of a project, as it is
    // told to, and the file it left alone lost its only copy: the old revision's
    // ref for that same text said the artifact had moved on, and the elision took
    // it — while the path still counted the file as present, so nothing carried it.
    const game = [
      '```html id=bil path=index.html title="Bilspil" entry',
      '<canvas></canvas><script type="module" src="src/drivePhysics.js"></script>',
      "```",
      "```js id=bil path=src/drivePhysics.js",
      "export function step(car) { car.x += car.speed; }",
      "```",
    ].join("\n");
    const faster =
      '```html id=bil path=index.html entry\n<canvas id="fast"></canvas><script type="module" src="src/drivePhysics.js"></script>\n```';
    const louder = "```css id=bil path=src/styles.css\nbody { background: black }\n```";

    assistantTurn(game);
    assistantTurn(faster);
    assistantTurn(louder);

    const onPath = path(
      user("lav et bilspil"),
      assistant(game),
      user("hurtigere"),
      assistant(faster),
      user("mørk baggrund"),
      assistant(louder),
    );
    const built = context(...onPath);
    const elided = elideSupersededArtifacts(onPath, built.index);
    const sent = elided
      .flatMap((message) => message.parts)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");

    // The physics file's only copy is still there…
    expect(sent).toContain("export function step(car) { car.x += car.speed; }");
    // …because nothing carries it otherwise.
    expect(built.carried).toEqual([]);
    // So is the current page, which the stylesheet-only revision left alone.
    expect(sent).toContain('<canvas id="fast"></canvas>');
    // The page's first version did move on, and goes.
    expect(sent).not.toContain("<canvas></canvas>");
  });

  it("carries only the files the path lacks, under a header naming them all", () => {
    assistantTurn(project);

    // A branch holding the entry but never the stylesheet.
    const { carried } = context(assistant("```tsx id=tid path=src/App.tsx entry\napp\n```"));

    expect(carried).toHaveLength(1);
    expect(carried[0].missing).toEqual({ "src/styles.css": "css" });
    expect(carried[0].allPaths).toEqual(["src/App.tsx", "src/styles.css"]);

    const text = formatCarriedSources(carried);
    expect(text).toContain("holds src/App.tsx, src/styles.css");
    expect(text).toContain("```css id=tid path=src/styles.css");
    expect(text).not.toContain("\napp\n");
  });

  it("carries nothing when the path holds every file", () => {
    assistantTurn(project);

    expect(context(assistant(project)).carried).toEqual([]);
  });
});
