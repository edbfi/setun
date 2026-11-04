import { describe, expect, it } from "bun:test";
import {
  artifactMessageSegments,
  artifactSegmentCount,
  artifactSegments,
  groupStreamingWrites,
  pairArtifactRefs,
  streamingMessageSegments,
  streamingSegments,
} from "./segments";

describe("artifactSegments", () => {
  it("preserves disjoint prose and other projects while grouping a write", () => {
    const first = "```html id=a path=index.html\n<p>a</p>\n```";
    const last = "```css id=a path=style.css\np {color: teal}\n```";
    const segments = artifactSegments(
      [
        first,
        "Between A and B.",
        "```svg id=b\n<svg/>\n```",
        "Between B and A.",
        last,
        "Done.",
      ].join("\n"),
    );
    expect(segments.map((segment) => segment.kind)).toEqual([
      "artifact",
      "text",
      "artifact",
      "text",
      "text",
    ]);
    expect(segments[0].kind === "artifact" && segments[0].raw).toBe(`${first}\n${last}`);
    expect(segments[1]).toEqual({ kind: "text", text: "Between A and B." });
    expect(segments[3]).toEqual({ kind: "text", text: "Between B and A." });
  });

  it("groups project files across text parts before numbering cards", () => {
    const parts = artifactMessageSegments([
      "```html id=a path=index.html\n<p>a</p>\n```",
      "Styles follow.\n```css id=a path=style.css\np {}\n```\n```svg id=b\n<svg/>\n```",
    ]);
    expect(parts[0][0].kind === "artifact" && parts[0][0].files).toEqual([
      "index.html",
      "style.css",
    ]);
    expect(parts[1][0]).toEqual({ kind: "text", text: "Styles follow." });
    const cards = parts.flat().filter((segment) => segment.kind === "artifact");
    expect(cards.map((card) => card.index)).toEqual([0, 1]);
  });
  it("splits prose around an artifact block", () => {
    const segments = artifactSegments(
      ["Her er siden:", "```html id=side", "<p>hi</p>", "```", "Prøv den."].join("\n"),
    );

    expect(segments.map((segment) => segment.kind)).toEqual(["text", "artifact", "text"]);
    expect(segments[0]).toEqual({ kind: "text", text: "Her er siden:" });
    expect(segments[2]).toEqual({ kind: "text", text: "Prøv den." });
  });

  it("carries the block as written, for a caller that cannot place it", () => {
    const [segment] = artifactSegments("```html id=side\n<p>hi</p>\n```");

    expect(segment.kind).toBe("artifact");
    if (segment.kind !== "artifact") throw new Error("expected an artifact segment");
    expect(segment.raw).toBe("```html id=side\n<p>hi</p>\n```");
    expect(segment.artifact.key).toBe("side");
    expect(segment.index).toBe(0);
  });

  it("numbers from the running count so a message's parts agree", () => {
    const segments = artifactSegments("```svg\n<svg/>\n```", 2);

    expect(segments[0].kind === "artifact" && segments[0].index).toBe(2);
  });

  it("numbers two blocks in one part in order", () => {
    const segments = artifactSegments("```html\na\n```\nmid\n```svg\n<svg/>\n```");
    const indices = segments.flatMap((segment) =>
      segment.kind === "artifact" ? [segment.index] : [],
    );

    expect(indices).toEqual([0, 1]);
  });

  it("leaves an ordinary code block inside the prose", () => {
    const segments = artifactSegments("```js\nconst x = 1;\n```");

    expect(segments).toEqual([{ kind: "text", text: "```js\nconst x = 1;\n```" }]);
  });

  it("skips an empty artifact block exactly as detection does", () => {
    const segments = artifactSegments("```html\n\n```");

    expect(segments.every((segment) => segment.kind === "text")).toBe(true);
  });

  it("emits no text segment for blank space between blocks", () => {
    const segments = artifactSegments("```html\na\n```\n\n```svg\n<svg/>\n```");

    expect(segments.map((segment) => segment.kind)).toEqual(["artifact", "artifact"]);
  });

  it("returns nothing for empty prose", () => {
    expect(artifactSegments("")).toEqual([]);
    expect(artifactSegments("   \n  ")).toEqual([]);
  });
});

describe("artifactSegmentCount", () => {
  it("counts what a part contributes to the running index", () => {
    expect(artifactSegmentCount("```html\na\n```\n```js\nb\n```")).toBe(1);
    expect(artifactSegmentCount("ingen kode her")).toBe(0);
  });
});

describe("streamingSegments", () => {
  it("leaves prose alone when there is no fence in it", () => {
    expect(streamingSegments("Jeg bygger den nu.")).toEqual([
      { kind: "text", text: "Jeg bygger den nu." },
    ]);
  });

  it("collapses the fence still arriving to a pending stub with its identity", () => {
    const segments = streamingSegments(
      ["Her er siden:", '```html id=side title="Min side"', "<!doctype html>", "<h1>Hej"].join(
        "\n",
      ),
    );

    // The pupil watched `<!doctype html>` scroll past before this (§13, §20).
    expect(segments).toEqual([
      { kind: "text", text: "Her er siden:" },
      {
        kind: "pending",
        language: "html",
        fileKind: "html",
        deleted: false,
        key: "side",
        title: "Min side",
        lines: 2,
        path: null,
      },
    ]);
  });

  it("leaves an open fence that is not an artifact in the prose", () => {
    const markdown = "Sådan her:\n```js\nconst x = 1;";

    // An ordinary code block is prose while it streams, exactly as before.
    expect(streamingSegments(markdown)).toEqual([{ kind: "text", text: markdown }]);
  });

  it("names a closed block and goes on to the one still arriving", () => {
    const segments = streamingSegments(
      ["```html id=en\n<p>en</p>\n```", "Og nu den anden:", "```svg id=to", "<svg"].join("\n"),
    );

    expect(segments.map((segment) => segment.kind)).toEqual(["artifact", "text", "pending"]);
    expect(segments[0].kind === "artifact" && segments[0].artifact.key).toBe("en");
    expect(segments[2]).toEqual({
      kind: "pending",
      language: "svg",
      fileKind: "svg",
      deleted: false,
      key: "to",
      title: null,
      lines: 1,
      path: null,
    });
  });

  it("does not read a backtick inside an info string as a fence", () => {
    // Mid-line, so no fence is opened at all.
    const inline = "Skriv `html` sådan her.";
    expect(streamingSegments(inline)).toEqual([{ kind: "text", text: inline }]);

    // And the guard itself: a line that *does* open with three backticks, whose
    // info string holds one. CommonMark says that is not a fence — it is how an
    // inline code span written with three backticks stays inline.
    const info = "```html id=`x`\n<p>hi";
    expect(streamingSegments(info)).toEqual([{ kind: "text", text: info }]);

    // A tilde fence's info string may hold one, so the same info string that is
    // not a fence above opens one here.
    expect(streamingSegments("~~~html id=side title=`x`\n<p>hi")).toEqual([
      {
        kind: "pending",
        language: "html",
        fileKind: "html",
        deleted: false,
        key: "side",
        title: "`x`",
        lines: 1,
        path: null,
      },
    ]);
  });

  it("reads a tilde fence, whose info string may hold a backtick", () => {
    const segments = streamingSegments("~~~html id=side title=`x`\n<p>hi");

    // The backtick is what makes this a tilde fence's case: the same info string
    // after three backticks is not a fence at all.
    expect(segments).toEqual([
      {
        kind: "pending",
        language: "html",
        fileKind: "html",
        deleted: false,
        key: "side",
        title: "`x`",
        lines: 1,
        path: null,
      },
    ]);
  });

  /**
   * A long file takes a minute to write, and a stub that says only "building"
   * for the whole of it looks stuck (§20).
   */
  it("counts the lines of the file that have arrived", () => {
    const stubOf = (markdown: string) => {
      const segment = streamingSegments(markdown).at(-1);
      if (segment?.kind !== "pending") throw new Error("expected a pending stub");
      return segment.lines;
    };

    expect(stubOf("```html id=side\n")).toBe(0);
    expect(stubOf("```html id=side\n<h1>")).toBe(1);
    expect(stubOf("```html id=side\n<h1>Hej</h1>\n")).toBe(1);
    expect(stubOf("```html id=side\n<h1>Hej</h1>\n<p>Og</p>")).toBe(2);
  });

  it("scans a long buffer without parsing it", () => {
    const body = Array.from({ length: 500 }, (_, at) => `<p>linje ${at}</p>`).join("\n");
    const segments = streamingSegments(`Her er den:\n\`\`\`html id=lang\n${body}`);

    expect(segments.map((segment) => segment.kind)).toEqual(["text", "pending"]);
  });
});

describe("streamingMessageSegments", () => {
  it("carries an open fence across the tool call that split the prose", () => {
    // `StreamingTurn` starts a new text part wherever a tool call landed between
    // two deltas, and a model can call one in the middle of writing a page.
    const [before, after] = streamingMessageSegments([
      'Her er siden:\n```html id=side title="Min side"\n<h1>Hej',
      "</h1>\n```\nFærdig.",
    ]);

    // Scanned apart, the second part had no opening line and the rest of the
    // pupil's page arrived as prose (§13, §20).
    expect(before).toEqual([
      { kind: "text", text: "Her er siden:" },
      // Named rather than still "being built": the fence closed in the part
      // after the tool call, and the stub stays where it opened.
      {
        kind: "artifact",
        artifact: {
          language: "html",
          source: "<h1>Hej</h1>",
          line: 1,
          endLine: -1,
          kind: "html",
          key: "side",
          title: "Min side",
          path: null,
          deleted: false,
          entry: false,
        },
      },
    ]);
    // One artifact is one card, owned by the part that opened it.
    expect(after).toEqual([{ kind: "text", text: "Færdig." }]);
  });

  it("keeps counting the lines while later parts fill the same fence", () => {
    const linesOf = (scans: ReturnType<typeof streamingMessageSegments>) => {
      const segment = scans[0].find((entry) => entry.kind === "pending");
      if (segment?.kind !== "pending") throw new Error("expected a pending stub");
      return segment.lines;
    };

    // The pieces join with nothing, because `StreamingTurn` concatenates deltas
    // — so a boundary that fell mid-line is one line again here.
    expect(linesOf(streamingMessageSegments(["```html id=side\n<h1>He", "j</h1>"]))).toBe(1);
    expect(linesOf(streamingMessageSegments(["```html id=side\n<h1>He", "j</h1>\n<p>Og"]))).toBe(2);
  });

  it("renders nothing for a part wholly inside a carried fence", () => {
    const scans = streamingMessageSegments([
      "```html id=side\n<h1>Hej",
      "<p>mere</p>",
      "</h1>\n```",
    ]);

    // The source is the whole file, gathered from every part it crossed.
    expect(scans[0]).toEqual([
      {
        kind: "artifact",
        artifact: {
          language: "html",
          source: "<h1>Hej<p>mere</p></h1>",
          line: 0,
          endLine: -1,
          kind: "html",
          key: "side",
          title: null,
          path: null,
          deleted: false,
          entry: false,
        },
      },
    ]);
    expect(scans[1]).toEqual([]);
    expect(scans[2]).toEqual([]);
  });

  it("keeps the stub pending while the fence it opened is still open", () => {
    const scans = streamingMessageSegments(["```html id=side\n<h1>Hej", "<p>mere</p>"]);

    expect(scans[0]).toEqual([
      {
        kind: "pending",
        language: "html",
        fileKind: "html",
        deleted: false,
        key: "side",
        title: null,
        lines: 1,
        path: null,
      },
    ]);
    expect(scans[1]).toEqual([]);
  });

  it("does not read a code block's closing line as an opening one in the next part", () => {
    // The `js` block closes in the second part. Carrying only artifact fences
    // left that ``` reading as an *opening* fence, and the html artifact behind
    // it was parsed as the body of a code block and rendered as prose.
    const scans = streamingMessageSegments([
      "Sådan:\n```js\nconst x = 1;",
      "```\n```html id=side\n<p>hi</p>\n```",
    ]);

    expect(scans[1].map((segment) => segment.kind)).toEqual(["text", "artifact"]);
    expect(scans[1][1].kind === "artifact" && scans[1][1].artifact.key).toBe("side");
  });

  it("does not leak the closing fence when a part begins with it", () => {
    const scans = streamingMessageSegments(["```html id=side\n<h1>Hej</h1>", "```\nFærdig."]);

    expect(scans[1]).toEqual([{ kind: "text", text: "Færdig." }]);
  });

  it("scans a part after a closed fence exactly as it would alone", () => {
    const scans = streamingMessageSegments([
      "```html id=en\n<p>en</p>\n```",
      "Og nu:\n```svg id=to\n<svg",
    ]);

    expect(scans[0].map((segment) => segment.kind)).toEqual(["artifact"]);
    expect(scans[1]).toEqual([
      { kind: "text", text: "Og nu:" },
      {
        kind: "pending",
        language: "svg",
        fileKind: "svg",
        deleted: false,
        key: "to",
        title: null,
        lines: 1,
        path: null,
      },
    ]);
  });

  it("leaves an ordinary code block spanning a boundary as prose on both sides", () => {
    // A js block is prose while it streams, and carrying it would change nothing
    // — so it is not carried, and both parts read as they always did.
    const scans = streamingMessageSegments(["Sådan her:\n```js\nconst x = 1;", "\n```\nFærdig."]);

    expect(scans[0]).toEqual([{ kind: "text", text: "Sådan her:\n```js\nconst x = 1;" }]);
    expect(scans[1].map((segment) => segment.kind)).toEqual(["text"]);
  });

  it("keeps an empty carried block as the prose it was written as", () => {
    const texts = ["Her er siden:\n```html id=side", "\n```\nFærdig."];
    const scans = streamingMessageSegments(texts);

    // An empty body is not an artifact: `detectArtifacts` skips it and the
    // settled transcript renders the fence as written, so a card here would be
    // the streaming view and the database disagreeing about what was built.
    expect(scans).toEqual([
      [{ kind: "text", text: "Her er siden:\n```html id=side" }],
      [{ kind: "text", text: "\n```\nFærdig." }],
    ]);

    // Which is the same prose a single scan of the whole message gives, split
    // only where the parts are.
    expect(streamingSegments(texts.join(""))).toEqual([
      { kind: "text", text: "Her er siden:\n```html id=side\n```\nFærdig." },
    ]);
  });

  it("keeps a whitespace-only carried block as prose too", () => {
    const scans = streamingMessageSegments(["```html id=side\n   ", "  \n```\nFærdig."]);

    expect(scans[0]).toEqual([{ kind: "text", text: "```html id=side\n   " }]);
    expect(scans[1].map((segment) => segment.kind)).toEqual(["text"]);
  });

  it("remembers a body that arrived in a middle part", () => {
    // Nothing in the part that opened the fence and nothing in the one that
    // closed it: whether there is a body is the answer over every part, not the
    // answer for the last one the scan happened to see.
    const scans = streamingMessageSegments(["```html id=side", "<p>hi</p>", "\n```\nFærdig."]);

    expect(scans[0]).toEqual([
      {
        kind: "artifact",
        artifact: {
          language: "html",
          source: "<p>hi</p>",
          line: 0,
          endLine: -1,
          kind: "html",
          key: "side",
          title: null,
          path: null,
          deleted: false,
          entry: false,
        },
      },
    ]);
    expect(scans[2]).toEqual([{ kind: "text", text: "Færdig." }]);
  });

  it("is one scan per text, in the order they were given", () => {
    expect(streamingMessageSegments([])).toEqual([]);
    expect(streamingMessageSegments(["en", "to", "tre"])).toHaveLength(3);
  });
});

/**
 * Code the model writes never reaches the transcript as prose (§13, §20).
 *
 * Reported from a classroom: revising an artifact sent its code into the chat.
 * A revision re-emits only the files that changed, and a stylesheet or a data
 * module is an artifact file only by its `id=` and `path=` — which the streaming
 * scan did not read, so a revision's CSS streamed in as text.
 *
 * Checked at every prefix of the stream, because a leak that lasts one delta is
 * still a screenful of code in front of a pupil.
 */
describe("containment", () => {
  /** Every body line of every artifact file, which must never be prose. */
  const CODE = [
    "export default function App() { return <Timeline /> }",
    "#hilsen { color: rgb(128, 0, 128) }",
    "export const events = [{ year: 1958, name: 'Setun' }];",
    '{ "title": "Tidslinje" }',
    "#hilsen { color: rgb(0, 0, 255) }",
  ];

  /** Three writes of one id: the entry and data, then the stylesheet twice. */
  const REVISIONS = [
    "Her er tidslinjen:",
    '```tsx id=tidslinje path=src/App.tsx title="Tidslinje" entry',
    CODE[0],
    "```",
    "```ts id=tidslinje path=src/events.ts",
    CODE[2],
    "```",
    "Jeg har skiftet farven:",
    "```css id=tidslinje path=src/styles.css",
    CODE[1],
    "```",
    "```json id=tidslinje path=src/meta.json",
    CODE[3],
    "```",
    "```ts id=tidslinje path=src/old.ts delete",
    "```",
    "Og en gang til:",
    "```css id=tidslinje path=src/styles.css",
    CODE[4],
    "```",
    "Prøv den nu.",
  ].join("\n");

  function leaks(segments: readonly { kind: string; text?: string }[]): string[] {
    return segments.flatMap((segment) =>
      segment.kind === "text" ? CODE.filter((line) => segment.text?.includes(line)) : [],
    );
  }

  it("keeps every file of repeated revisions out of the prose at every delta", () => {
    for (let end = 0; end <= REVISIONS.length; end++) {
      const prefix = REVISIONS.slice(0, end);
      expect({ end, leaked: leaks(streamingSegments(prefix)) }).toEqual({ end, leaked: [] });
    }
  });

  it("keeps them out when tool calls split the stream into parts", () => {
    // `StreamingTurn` starts a new text part wherever a tool call landed — at a
    // line boundary, or partway through a line of a file's body. (A cut inside
    // a fence's own marker line is the scanner's documented limit, and not
    // where a model stops to call a tool.)
    const lines = REVISIONS.split("\n");
    const cuts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      cuts.push(offset);
      if (CODE.includes(line)) cuts.push(offset + Math.floor(line.length / 2));
      offset += line.length + 1;
    }

    for (const cut of cuts) {
      for (let end = cut; end <= REVISIONS.length; end += 5) {
        const parts = [REVISIONS.slice(0, cut), REVISIONS.slice(cut, end)];
        const leaked = streamingMessageSegments(parts).flatMap(leaks);
        expect({ cut, end, leaked }).toEqual({ cut, end, leaked: [] });
      }
    }
  });

  it("stubs a stylesheet-only revision while it arrives, naming the file", () => {
    const segments = streamingSegments(
      ["Jeg har skiftet farven:", "```css id=projektet path=styles.css", "#hilsen {"].join("\n"),
    );

    expect(segments).toEqual([
      { kind: "text", text: "Jeg har skiftet farven:" },
      {
        kind: "pending",
        language: null,
        fileKind: "css",
        deleted: false,
        key: "projektet",
        title: null,
        lines: 1,
        path: "styles.css",
      },
    ]);
  });

  it("names a deletion, which has no body, rather than putting it back as prose", () => {
    const fence = "```ts id=tidslinje path=src/old.ts delete\n```";
    const whole = streamingSegments(fence);
    expect(whole).toHaveLength(1);
    expect(whole[0].kind === "artifact" && whole[0].artifact.deleted).toBe(true);

    // And across a part boundary, where the closing line lands in the next part.
    const split = streamingMessageSegments(["```ts id=tidslinje path=src/old.ts delete\n", "```"]);
    expect(split[0]).toHaveLength(1);
    expect(split[0][0].kind === "artifact" && split[0][0].artifact.deleted).toBe(true);
  });

  it("leaves a stylesheet with no id and path an ordinary code block", () => {
    // The tag alone still means "example CSS" everywhere outside a project.
    const text = "Sådan:\n```css\np { color: teal }\n```";
    expect(streamingSegments(text)).toEqual([{ kind: "text", text }]);
    expect(artifactSegments(text)).toEqual([{ kind: "text", text }]);
  });

  it("keeps a settled message's unclosed artifact fence out of the prose", () => {
    // A turn stopped mid-file: Stop, a cap, a dropped connection.
    const cut = ["Her er siden:", "```html id=side", "<main>", "<h1>Hej"].join("\n");

    expect(artifactSegments(cut)).toEqual([
      { kind: "text", text: "Her er siden:" },
      {
        kind: "unclosed",
        fence: {
          language: "html",
          kind: "html",
          key: "side",
          title: null,
          path: null,
          deleted: false,
          entry: false,
        },
        raw: ["```html id=side", "<main>", "<h1>Hej"].join("\n"),
      },
    ]);
  });

  it("puts an unclosed fence in the part that opened it, and swallows the parts inside it", () => {
    const parts = artifactMessageSegments([
      "Først:\n```css id=side path=styles.css\np {",
      "color: red",
    ]);

    expect(parts[0].map((segment) => segment.kind)).toEqual(["text", "unclosed"]);
    expect(parts[1]).toEqual([]);
  });

  it("leaves an unclosed ordinary code block to the markdown renderer", () => {
    const text = "Kør:\n```sh\nbun test";
    expect(artifactSegments(text)).toEqual([{ kind: "text", text }]);
  });
});

describe("pairArtifactRefs", () => {
  const ref = (key: string, language = "html") => ({ key, language });

  function cards(markdown: string) {
    return artifactSegments(markdown).filter((segment) => segment.kind === "artifact");
  }

  it("pairs by position when every card has its ref", () => {
    const found = cards("```html id=a\n<p/>\n```\n```svg id=b\n<svg/>\n```");
    expect(pairArtifactRefs(found, [ref("a"), ref("b", "svg")])).toEqual([
      ref("a"),
      ref("b", "svg"),
    ]);
  });

  it("pairs the rest by id when one write recorded no revision", () => {
    // `a` was restated unchanged: it has no ref, and pairing by position would
    // hang `b`'s revision on `a`'s card.
    const found = cards("```html id=a\n<p/>\n```\n```svg id=b\n<svg/>\n```");
    expect(pairArtifactRefs(found, [ref("b", "svg")])).toEqual([null, ref("b", "svg")]);
  });

  it("pairs a stylesheet-only write by the id it names", () => {
    const found = cards("```css id=side path=styles.css\np {}\n```");
    expect(pairArtifactRefs(found, [ref("side")])).toEqual([ref("side")]);
  });

  it("pairs key-less blocks by order and language among unclaimed refs", () => {
    const found = cards(
      "```html\n<p>1</p>\n```\n```svg id=logo\n<svg/>\n```\n```html\n<p>2</p>\n```",
    );
    // One ref for two key-less html blocks: it goes to the first, in order.
    const refs = [ref("logo", "svg"), ref("html-abc")];
    expect(pairArtifactRefs(found, refs)).toEqual([ref("html-abc"), ref("logo", "svg"), null]);
  });

  it("pairs nothing when there are no refs at all", () => {
    expect(pairArtifactRefs(cards("```html id=a\n<p/>\n```"), [])).toEqual([null]);
  });
});

describe("groupStreamingWrites", () => {
  it("folds one id's fences into one write, its files as rows", () => {
    const text = [
      "Her er projektet:",
      '```tsx id=tidslinje path=src/App.tsx title="Tidslinje" entry',
      "export default function App() {}",
      "```",
      "```ts id=tidslinje path=src/old.ts delete",
      "```",
      "```css id=tidslinje path=src/styles.css",
      "p {",
    ].join("\n");

    expect(groupStreamingWrites(streamingSegments(text))).toEqual([
      { kind: "text", text: "Her er projektet:" },
      {
        kind: "write",
        key: "tidslinje",
        title: "Tidslinje",
        language: "tsx",
        fileKind: "tsx",
        writing: true,
        files: [
          { path: "src/App.tsx", fileKind: "tsx", state: "written", deleted: false, lines: 1 },
          { path: "src/old.ts", fileKind: "ts", state: "written", deleted: true, lines: 0 },
          { path: "src/styles.css", fileKind: "css", state: "writing", deleted: false, lines: 1 },
        ],
      },
    ]);
  });

  it("keeps prose between two fences as a boundary between writes", () => {
    const text = [
      "```html id=a\n<p/>\n```",
      "Og stilen:",
      "```css id=a path=styles.css\np {}\n```",
    ].join("\n");

    expect(groupStreamingWrites(streamingSegments(text)).map((item) => item.kind)).toEqual([
      "write",
      "text",
      "write",
    ]);
  });

  it("never merges key-less blocks or different ids", () => {
    const text =
      "```html\n<p>1</p>\n```\n```html\n<p>2</p>\n```\n```svg id=a\n<svg/>\n```\n```svg id=b\n<svg/>\n```";
    expect(groupStreamingWrites(streamingSegments(text))).toHaveLength(4);
  });
});
