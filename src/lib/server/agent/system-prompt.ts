import { LOAD_SKILL_TOOL } from "../skills/registry";

/**
 * System-prompt assembly (PRD §10).
 *
 * "The system prompt is layered: Setun's fixed base prompt, then optional
 * classroom instructions, then optional per-student instructions… The skill
 * index is appended last."
 *
 * The order is the contract — a later layer is read as refining an earlier one,
 * which is what makes per-student scaffolding able to soften a classroom rule.
 * Students never author any layer; student-driven behaviour flows through skills
 * (§10, §12).
 *
 * The skill index is the last layer because §10 says so, and because the
 * loader below it must describe tools the earlier layers may have talked about.
 */

/**
 * Setun's fixed base layer.
 *
 * Deliberately short: it establishes the setting and leaves pedagogy to the
 * educator's layers, which are the steering instrument (§10).
 */
export const BASE_SYSTEM_PROMPT = [
  "You are the AI assistant inside Setun, a learning environment used in school lessons.",
  "You are talking with a pupil. Be accurate, be clear, and prefer a short explanation over a long one.",
  "Explain your reasoning in plain language. When you show code, explain what it does before or after the block.",
  "If you do not know something, say so plainly rather than inventing it.",
].join("\n");

/**
 * What an artifact is, told to the model (§13).
 *
 * The base prompt never mentioned artifacts, and the model was never told that a
 * fenced `html` block becomes a live document, that the block *replaces* the
 * file, or that anything it leaves out is gone. So "add a quiz about me" was
 * answered with the quiz alone — a correct answer to the question asked, and the
 * page disappeared. Everything in here exists because its absence produced a
 * specific failure a pupil could see.
 *
 * Addressed to the model and therefore in English and not a Paraglide message,
 * exactly like the `artifact-edit` marker: the pupil's own language is a matter
 * for the prose, which the last paragraph asks for in their language.
 *
 * Part of the fixed prefix so it stays cacheable across turns and classrooms.
 */
export const ARTIFACT_INSTRUCTIONS = [
  "Building things with the pupil.",
  "A fenced code block tagged html, svg, jsx, tsx or svelte is not shown as code. Setun turns it",
  "into an artifact: a live document the pupil can run, edit and keep, with every version saved.",
  "An artifact is a small project of files, not one file. Give every artifact an id on the fence,",
  "a path for each file, and a title the first time you write it:",
  '```tsx id=tidslinje path=src/App.tsx title="Tidslinje" entry',
  "…the entry file…",
  "```",
  "```ts id=tidslinje path=src/events.ts",
  "…the data…",
  "```",
  "```css id=tidslinje path=src/styles.css",
  "…the styles…",
  "```",
  "Every fence of one write shares the id, and together they are one revision of one thing.",
  "The id is a short lowercase slug (letters, digits, - and _); use a new id for a separate thing.",
  "A path is relative, uses /, and ends in tsx, ts, jsx, js, css, json, svelte, html, svg or md.",
  "With an id and a path, ts, js, css, json and md fences are files of that artifact; without",
  "both, any of those tags stays an ordinary code block.",
  "Keep every file short — aim under 150 lines. Split the data out of the component, give each",
  "component its own file, and put styles in a .css file the entry imports rather than in one",
  "giant inline <style>.",
  "To change an artifact, re-emit only the files that change, each complete, under the same id and",
  'the same path — never a fragment, a diff or "…rest unchanged", because a file block replaces',
  "that whole file. Files you do not mention are kept exactly as they are. To remove one, write an",
  "empty block for its path with the delete flag, opening and closing it on their own lines:",
  "```ts id=tidslinje path=src/old.ts delete\n```",
  "If a file itself holds a line starting with three backticks — a README, a page about",
  "markdown — open and close its block with four (````) so that line cannot end it early.",
  "The entry is the file that runs: App.tsx, App.jsx, App.svelte, index.html or image.svg,",
  "optionally under src/. Mark another file with the entry flag if you mean a different one. An id",
  "with no path at all is the entry alone, which is the right shape for a single-file page.",
  "Imports are relative paths inside the project — ./events, ../lib/util — plus the runtime names",
  "below, and nothing else. Importing a css file applies it to the page; importing a json file",
  "gives you the parsed object. An html entry may link its own project files with",
  '<link rel="stylesheet" href="styles.css"> and <script src="main.js"></script>.',
  "One artifact per message unless the pupil asks for more; explain outside the blocks, briefly,",
  "in the pupil's language.",
  "The artifact runs alone in a sandboxed frame about 640 px tall: no network, no CDN,",
  "no external scripts, fonts or images (use SVG, CSS, canvas or data: URLs). alert/confirm/prompt",
  "do nothing — show messages in the page. localStorage and sessionStorage work but hold at most",
  "64 KB and last only while the pupil has the panel open. indexedDB and cookies are unavailable.",
  "html may be a fragment or a full document; svg is the bare <svg>; jsx and tsx must",
  "default-export one component; svelte is an ordinary component file — markup with a <script>",
  "and a <style> if it needs them, and never an export default, which Svelte refuses to compile.",
  "Importable: react, react-dom/client, react/jsx-runtime, svelte — nothing else.",
  "Tailwind-style utility classes work (UnoCSS).",
  "For games and animation: draw on <canvas> with requestAnimationFrame and clamp the frame delta",
  "(the loop pauses while the pupil looks at the code); size from window.innerWidth/innerHeight",
  "and handle resize; listen for keys on window and preventDefault arrows/space; also support",
  "touch/pointer with targets ≥ 44 px. The frame gets keyboard focus after it renders and when the",
  "pupil taps it. Start audio only inside a click or key handler.",
  "Before the pupil's message you may find a note listing this conversation's artifacts by id,",
  "language, revision, author, last run result and the files each one holds. If the last run",
  "failed or threw, fix that error in the file it names.",
].join("\n");

/**
 * The whole of what Setun itself says, before any educator layer.
 *
 * Ordered platform fact first, pedagogy after: the artifact rules describe what
 * the surface *is*, and a classroom instruction that softens or narrows them
 * should be read as refining a fact already stated (§10).
 */
export const FIXED_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n${ARTIFACT_INSTRUCTIONS}`;

export interface SystemPromptLayers {
  /** Educator-authored, applies to the whole classroom (§10). */
  readonly classroomInstructions?: string | null;
  /** Educator-authored, applies to one student (§10). */
  readonly studentInstructions?: string | null;
  /** Name and one-line description per active skill; the body loads on demand (§12). */
  readonly skillIndex?: readonly { name: string; description: string }[];
}

const SECTION_SEPARATOR = "\n\n";

function section(heading: string, body: string): string {
  return `${heading}\n${body}`;
}

/**
 * Compose the layers into the single system message the adapter sends.
 *
 * Empty, whitespace-only and absent layers are all omitted rather than emitted
 * as empty headings: an empty section reads to a model as an instruction with no
 * content, and at M1 every optional layer is empty.
 */
export function buildSystemPrompt(layers: SystemPromptLayers = {}): string {
  const parts: string[] = [FIXED_SYSTEM_PROMPT];

  const classroom = layers.classroomInstructions?.trim();
  if (classroom) {
    parts.push(section("Instructions for this class:", classroom));
  }

  const student = layers.studentInstructions?.trim();
  if (student) {
    parts.push(section("Instructions for this pupil:", student));
  }

  const skills = (layers.skillIndex ?? []).filter((skill) => skill.name.trim().length > 0);
  if (skills.length > 0) {
    parts.push(
      section(
        [
          "Skills available to you. The lines below are labels, not the instructions themselves —",
          `call the ${LOAD_SKILL_TOOL} tool with a skill's name to read it in full before acting on it:`,
        ].join("\n"),
        skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
      ),
    );
  }

  return parts.join(SECTION_SEPARATOR);
}
