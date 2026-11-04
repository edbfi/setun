import { describe, expect, it } from "bun:test";
import { detectArtifacts } from "../../artifacts/detect";
import { ARTIFACT_INSTRUCTIONS, buildSystemPrompt, FIXED_SYSTEM_PROMPT } from "./system-prompt";

/**
 * System-prompt layering (plan 1.5, PRD §10, §22).
 *
 * Later layers are empty until Phases 2.9 and 3.7; the layering contract is
 * fixed now so neither phase has to revisit it.
 */

describe("buildSystemPrompt", () => {
  it("is the base prompt alone when every optional layer is absent", () => {
    expect(buildSystemPrompt()).toBe(FIXED_SYSTEM_PROMPT);
    expect(buildSystemPrompt({})).toBe(FIXED_SYSTEM_PROMPT);
  });

  it("orders base, then classroom, then student, then the skill index", () => {
    const prompt = buildSystemPrompt({
      classroomInstructions: "Answer in Danish.",
      studentInstructions: "Explain before showing code.",
      skillIndex: [{ name: "essay-feedback", description: "Give feedback on an essay." }],
    });

    const positions = [
      prompt.indexOf(FIXED_SYSTEM_PROMPT),
      prompt.indexOf("Answer in Danish."),
      prompt.indexOf("Explain before showing code."),
      prompt.indexOf("essay-feedback"),
    ];

    expect(positions.every((position) => position >= 0)).toBe(true);
    // The order is the contract: a later layer refines an earlier one (§10).
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("omits a layer that is absent, empty or whitespace rather than emitting an empty heading", () => {
    for (const empty of [undefined, null, "", "   ", "\n\t"]) {
      expect(buildSystemPrompt({ classroomInstructions: empty })).toBe(FIXED_SYSTEM_PROMPT);
      expect(buildSystemPrompt({ studentInstructions: empty })).toBe(FIXED_SYSTEM_PROMPT);
    }
    expect(buildSystemPrompt({ skillIndex: [] })).toBe(FIXED_SYSTEM_PROMPT);
  });

  it("includes a student layer even when the classroom layer is absent", () => {
    const prompt = buildSystemPrompt({ studentInstructions: "Use short sentences." });

    expect(prompt).toContain("Use short sentences.");
    expect(prompt.startsWith(FIXED_SYSTEM_PROMPT)).toBe(true);
  });

  it("lists each skill as a name and one-line description, not a body", () => {
    const prompt = buildSystemPrompt({
      skillIndex: [
        { name: "essay-feedback", description: "Give feedback on an essay." },
        { name: "debug-help", description: "Help find a bug." },
      ],
    });

    expect(prompt).toContain("- essay-feedback: Give feedback on an essay.");
    expect(prompt).toContain("- debug-help: Help find a bug.");
  });

  it("skips a nameless skill entry", () => {
    expect(buildSystemPrompt({ skillIndex: [{ name: "  ", description: "orphan" }] })).toBe(
      FIXED_SYSTEM_PROMPT,
    );
  });
});

describe("the artifact layer", () => {
  it("shows a complete deletion fence that the artifact detector accepts", () => {
    expect(
      detectArtifacts(ARTIFACT_INSTRUCTIONS).some(
        (block) => block.deleted && block.key === "tidslinje" && block.path === "src/old.ts",
      ),
    ).toBe(true);
  });
  it("is part of the fixed prefix, before any educator layer", () => {
    const prompt = buildSystemPrompt({ classroomInstructions: "Svar altid på dansk." });

    // In the fixed prefix itself, not merely somewhere ahead of the classroom
    // layer: appended as a mutable layer it would still order correctly below
    // while breaking the cacheable prefix this names (§10, §13).
    expect(FIXED_SYSTEM_PROMPT).toContain(ARTIFACT_INSTRUCTIONS);
    expect(prompt.indexOf(ARTIFACT_INSTRUCTIONS)).toBeGreaterThan(-1);
    // Platform fact first, pedagogy after: a classroom rule reads as refining a
    // fact already stated, and the cacheable prefix stays identical (§10, §13).
    expect(prompt.indexOf(ARTIFACT_INSTRUCTIONS)).toBeLessThan(
      prompt.indexOf("Svar altid på dansk."),
    );
  });

  it("tells the model what a fenced artifact block does and what replaces it", () => {
    // The failure this exists to stop: a fragment answering "add a quiz", which
    // became the whole new source and took the page with it (§13).
    expect(ARTIFACT_INSTRUCTIONS).toContain("re-emit only the files that change, each complete");
    expect(ARTIFACT_INSTRUCTIONS).toContain("a file block replaces");
    expect(ARTIFACT_INSTRUCTIONS).toContain("id=tidslinje");
  });

  /**
   * The lever, besides the state note's line counts, against a model writing a
   * thousand-line page: it has to be told that files are the shape of the thing
   * and that short ones are what is wanted (§13).
   */
  it("asks for a project of short files rather than one long one", () => {
    expect(ARTIFACT_INSTRUCTIONS).toContain(
      "An artifact is a small project of files, not one file",
    );
    expect(ARTIFACT_INSTRUCTIONS).toContain("aim under 150 lines");
    expect(ARTIFACT_INSTRUCTIONS).toContain("path=src/styles.css");
    // Files it does not mention survive, which is the whole economy of it.
    expect(ARTIFACT_INSTRUCTIONS).toContain("Files you do not mention are kept");
  });

  it("says which tags become project files and which stay code blocks", () => {
    expect(ARTIFACT_INSTRUCTIONS).toContain("With an id and a path, ts, js, css, json and md");
    expect(ARTIFACT_INSTRUCTIONS).toContain("stays an ordinary code block");
  });

  it("states the entry rule and how to delete a file", () => {
    expect(ARTIFACT_INSTRUCTIONS).toContain("The entry is the file that runs");
    expect(ARTIFACT_INSTRUCTIONS).toContain("with the delete flag");
  });

  it("asks for a longer fence around a file that holds a fence of its own", () => {
    // A README's own ``` line closes a three-backtick block early, and the rest
    // of the file lands in the chat as prose (§13).
    expect(ARTIFACT_INSTRUCTIONS).toContain("open and close its block with four (````)");
  });

  it("bounds what an artifact may import", () => {
    expect(ARTIFACT_INSTRUCTIONS).toContain("Imports are relative paths inside the project");
    expect(ARTIFACT_INSTRUCTIONS).toContain("Importable: react, react-dom/client");
  });

  it("asks for a fix when the last run failed or threw", () => {
    // A page that mounted and then threw is on the pupil's screen: the model
    // has to be told to fix that error rather than to rewrite the file (§13).
    // Line-wrapped in the source, so the two halves are asserted apart.
    expect(ARTIFACT_INSTRUCTIONS).toContain("If the last run");
    expect(ARTIFACT_INSTRUCTIONS).toContain("failed or threw, fix that error in the file it names");
  });

  it("does not ask a svelte artifact for a default export", () => {
    // The Svelte compiler refuses a component with one, so following the
    // instruction would have made every svelte artifact fail to build (§13).
    expect(ARTIFACT_INSTRUCTIONS).toContain("jsx and tsx must");
    expect(ARTIFACT_INSTRUCTIONS).toContain("never an export default");
  });
});
