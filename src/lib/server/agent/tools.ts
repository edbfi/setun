import type { AppDatabase } from "../db/client";
import { listAllowedTools } from "../db/queries/mcp";
import type { Classroom } from "../db/schema";
import { createDocument, type DocumentRefusal } from "../documents/create";
import {
  CREATE_DOCUMENT_TOOL,
  DOCUMENT_LIMITS,
  type DocumentFormat,
  isDocumentFormat,
} from "../documents/formats";
import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "../documents/markdown";
import type { GatewayAdapter } from "../gateway/adapter";
import type { GatewayToolDefinition } from "../gateway/dialect";
import type { ElicitationFieldSpec } from "../gateway/events";
import { describeCause, log } from "../logging";
import type { McpClient } from "../mcp/client";
import type { McpToolResult } from "../mcp/legacy/results";
import { McpError } from "../mcp/protocol";
import {
  LOAD_SKILL_TOOL,
  loadSkill,
  loadSkillSchema,
  type ResolvedSkills,
} from "../skills/registry";
import type { FileStore } from "../storage/files";
import { generateImage, generationAliases } from "./image-generation";
import type { ToolKind } from "./permissions";

/**
 * The tools one turn may use (PRD §11, §12, §15).
 *
 * Three sources, one list: the MCP tools this classroom allowlists, the internal
 * skill loader, and the internal image generator. The loop sees one kind of
 * thing, which is what lets the permission modes, the step cap and the
 * transcript treat them identically — "they travel through the same registry,
 * allowlist, and execution path as MCP tools" (§12).
 *
 * The list is built from the database, never from anything the client sent: a
 * tool absent from the classroom's allowlist is absent from the model's options
 * *and* unreachable by name (§11, §21).
 */

export const GENERATE_IMAGE_TOOL = "generate_image";
export { CREATE_DOCUMENT_TOOL };

export interface TurnTool {
  /** The name the model calls. Unique within a turn, and valid for both dialects. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly kind: ToolKind;
  readonly sensitive: boolean;
  /** Shown to the student with the permission prompt and the elicitation (§11). */
  readonly serverLabel: string | null;
  /** Where an MCP tool actually lives; absent for the internal tools. */
  readonly mcp?: { readonly serverKey: string; readonly toolName: string };
}

export interface ToolExecution {
  /** What the model is told. Untrusted input as far as everything else goes (§11). */
  readonly text: string;
  readonly isError: boolean;
  /** Present when the tool asked the student a question before it can finish (§11). */
  readonly elicitation?: {
    readonly message: string;
    readonly fields: readonly ElicitationFieldSpec[];
  } | null;
  /** Present when this call produced an image the student should be shown (§15). */
  readonly imageId?: string;
  readonly prompt?: string;
  /** Present only when this call wrote a document; an error result never carries one. */
  readonly document?: {
    readonly id: string;
    readonly title: string;
    readonly format: DocumentFormat;
  };
}

export interface ToolContext {
  readonly db: AppDatabase;
  readonly adapter: GatewayAdapter;
  readonly files: FileStore;
  /** Null when the deployment configures no MCP servers, which is a valid pilot. */
  readonly mcp: McpClient | null;
  readonly classroom: Classroom;
  readonly studentId: string;
  readonly conversationId: string;
  readonly skills: ResolvedSkills;
}

/**
 * The tool set for one turn.
 *
 * A class rather than a bare array so the name-to-tool lookup and the gateway
 * definitions come from the same construction — a model that calls a name this
 * object does not know is refused, and there is no second list to fall out of
 * step with the first.
 */
export class ToolSet {
  readonly #tools: ReadonlyMap<string, TurnTool>;

  constructor(tools: readonly TurnTool[]) {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  get size(): number {
    return this.#tools.size;
  }

  get all(): TurnTool[] {
    return [...this.#tools.values()];
  }

  find(name: string): TurnTool | undefined {
    return this.#tools.get(name);
  }

  /** What the adapter sends upstream. Empty when the turn has no tools at all. */
  definitions(): GatewayToolDefinition[] {
    return this.all.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
}

/** Assemble the tool set for one turn, from the classroom's own configuration. */
export function buildToolSet(context: ToolContext): ToolSet {
  const tools: TurnTool[] = [];
  const taken = new Set<string>();

  for (const allowed of listAllowedTools(context.db, context.classroom.id)) {
    const server = context.mcp?.server(allowed.server.configKey);
    // A row whose configuration entry has been removed is inert: the endpoint
    // lives in the file, and without it there is nothing to call (§11).
    if (!server) continue;

    const name = uniqueName(`${allowed.server.configKey}__${allowed.tool.name}`, taken);
    tools.push({
      name,
      description: allowed.tool.description ?? allowed.tool.name,
      inputSchema: allowed.tool.inputSchema ?? EMPTY_SCHEMA,
      kind: "mcp",
      sensitive: allowed.tool.sensitive,
      serverLabel: allowed.server.label,
      mcp: { serverKey: allowed.server.configKey, toolName: allowed.tool.name },
    });
  }

  if (context.skills.skills.length > 0) {
    tools.push({
      name: uniqueName(LOAD_SKILL_TOOL, taken),
      description:
        "Read the full instructions of one of the skills listed in your system prompt. " +
        "Do this before acting on a skill; the list only gives its name and one line.",
      inputSchema: loadSkillSchema(context.skills),
      kind: "skill-load",
      // Never asks, in any mode (§12).
      sensitive: false,
      serverLabel: null,
    });
  }

  // Offered "whenever the classroom allowlists a generation-capable alias" (§15).
  if (generationAliases(context.db, context.classroom.id).length > 0) {
    tools.push({
      name: uniqueName(GENERATE_IMAGE_TOOL, taken),
      description:
        "Generate an image from a description and show it to the pupil. " +
        "Use it when they ask for a picture, a diagram or an illustration.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What the image should show, in English, as a single description.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      kind: "generate-image",
      sensitive: false,
      serverLabel: null,
    });
  }

  // Offered while the classroom allows documents; the switch is read again at
  // the moment of writing, in `createDocument`.
  if (context.classroom.documentsEnabled) {
    tools.push({
      name: uniqueName(CREATE_DOCUMENT_TOOL, taken),
      description:
        "Create a Word document (docx) or a spreadsheet file (csv) the pupil can download. " +
        "Use it when they ask for a document, worksheet, handout or a table as a file. " +
        "Write the content as Markdown: headings, paragraphs, lists, quotes, code blocks and tables. " +
        "A csv must contain exactly one Markdown table. Images, HTML and hyperlinks are not kept.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["docx", "csv"], description: "The file type." },
          title: {
            type: "string",
            maxLength: DOCUMENT_LIMITS.titleMaxChars,
            description: "A short title. It names the file the pupil downloads.",
          },
          markdown: {
            type: "string",
            maxLength: DOCUMENT_LIMITS.markdownMaxChars,
            description: "The whole document, as Markdown.",
          },
        },
        required: ["format", "title", "markdown"],
        additionalProperties: false,
      },
      kind: "create-document",
      sensitive: false,
      serverLabel: null,
    });
  }

  return new ToolSet(tools);
}

const EMPTY_SCHEMA = { type: "object", properties: {} } as const;

/**
 * A model-facing name both dialects accept.
 *
 * Letters, digits, underscores and hyphens only, and short enough for the
 * stricter of the two. Collisions after truncation are broken by a counter
 * rather than left to silently shadow one another.
 *
 * 54 rather than 60, because the OpenAI dialect prefixes every name with
 * `setun_` on the wire and the limit that matters is the one the provider
 * enforces on what it actually receives.
 */
function uniqueName(raw: string, taken: Set<string>): string {
  const base = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 54) || "tool";

  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) candidate = `${base}_${counter++}`;

  taken.add(candidate);
  return candidate;
}

/**
 * Execute one permitted call.
 *
 * The permission decision has already been made by the loop; this runs what it
 * is given. Nothing student-specific is passed to an MCP server — "no student
 * credential is ever passed into a tool call" (§11) — and the arguments are the
 * model's own, sanitised of any header injection by the client (§11).
 */
export async function executeTool(input: {
  context: ToolContext;
  tool: TurnTool;
  arguments: Record<string, unknown>;
  /** Answers to a previous interim result, attached to the retry (§11). */
  elicitationResponse?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ToolExecution> {
  const { context, tool } = input;

  switch (tool.kind) {
    case "skill-load": {
      const name = typeof input.arguments.name === "string" ? input.arguments.name : "";
      const loaded = loadSkill(context.skills, name);
      return { text: loaded.text, isError: !loaded.ok };
    }

    case "generate-image": {
      const prompt =
        typeof input.arguments.prompt === "string" ? input.arguments.prompt.trim() : "";
      if (!prompt) {
        return { text: "No prompt was given, so no image was generated.", isError: true };
      }

      let result: Awaited<ReturnType<typeof generateImage>>;
      try {
        result = await generateImage({
          db: context.db,
          adapter: context.adapter,
          files: context.files,
          classroom: context.classroom,
          studentId: context.studentId,
          conversationId: context.conversationId,
          prompt,
          signal: input.signal,
        });
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") throw cause;

        // Storing the image failed. That is the tool's problem to report, not
        // the turn's to die of — the pupil keeps the conversation (§10, §21).
        log.warn("image generation failed to store", { cause: describeCause(cause) });
        return { text: imageRefusalForModel("unavailable"), isError: true };
      }

      if (!result.ok) {
        return { text: imageRefusalForModel(result.refusal), isError: true };
      }

      return {
        text: "The image was generated and is now shown to the pupil. Do not describe it in detail; ask what they would like changed.",
        isError: false,
        imageId: result.image.id,
        prompt,
      };
    }

    case "create-document": {
      const { format, title, markdown } = input.arguments;
      if (!isDocumentFormat(format) || typeof title !== "string" || typeof markdown !== "string") {
        return { text: documentRefusalForModel("invalid"), isError: true };
      }

      let result: Awaited<ReturnType<typeof createDocument>>;
      try {
        result = await createDocument({
          db: context.db,
          files: context.files,
          classroomId: context.classroom.id,
          studentId: context.studentId,
          conversationId: context.conversationId,
          format,
          title,
          markdown,
        });
      } catch (cause) {
        // Rendering or storing failed. The tool's problem to report, not the
        // turn's to die of; no document content reaches the log (§21).
        log.warn("document creation failed", { cause: describeCause(cause) });
        return { text: "The document could not be saved. Continue without it.", isError: true };
      }

      if (!result.ok) return { text: documentRefusalForModel(result.refusal), isError: true };

      const { document } = result;
      return {
        text:
          `Created '${document.title}' (${document.format}, ${formatSize(result.byteLength)}). ` +
          "The pupil sees a download card in the chat and the document is saved in their Creations. " +
          "Do not repeat its content; ask whether they would like anything changed.",
        isError: false,
        document: { id: document.id, title: document.title, format: document.format },
      };
    }

    case "mcp": {
      if (!context.mcp || !tool.mcp) {
        return { text: "This tool is not available right now.", isError: true };
      }

      try {
        const result = await context.mcp.callTool(tool.mcp.serverKey, {
          name: tool.mcp.toolName,
          arguments: input.arguments,
          elicitationResponse: input.elicitationResponse,
          signal: input.signal,
        });

        return normaliseExecution(result);
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") throw cause;

        // The tool's failure is the model's problem to work around, not the
        // turn's to die of. No endpoint, credential or stack trace travels in
        // the text the model is given (§21).
        log.warn("mcp tool call failed", {
          server: tool.mcp.serverKey,
          tool: tool.mcp.toolName,
          kind: cause instanceof McpError ? cause.kind : "unknown",
        });
        return { text: "The tool could not be reached. Continue without it.", isError: true };
      }
    }
  }
}

/** Render an MCP result as the text the model reads. */
function normaliseExecution(result: McpToolResult): ToolExecution {
  const text = result.content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "resource") return item.text ?? `[resource ${item.uri}]`;
      // Images returned by a tool are not forwarded upstream in the pilot; the
      // model is told one exists rather than being handed bytes it may not take.
      return "[the tool returned an image]";
    })
    .filter((entry) => entry.length > 0)
    .join("\n\n");

  const structured = result.structured ? `\n\n${JSON.stringify(result.structured)}` : "";

  return {
    text: `${text}${structured}` || "The tool returned nothing.",
    isError: result.isError,
    elicitation: result.elicitation,
  };
}

/** What the model is told when generation was refused (§15). */
function imageRefusalForModel(
  refusal: "no-generation-alias" | "alias-not-capable" | "unavailable",
) {
  switch (refusal) {
    case "unavailable":
      return "Image generation is temporarily unavailable. Continue without it.";
    default:
      return "Image generation is not available in this class. Tell the pupil you cannot make pictures here.";
  }
}

/** What the model is told when a document was refused. Phrased so it can retry. */
function documentRefusalForModel(refusal: DocumentRefusal): string {
  switch (refusal) {
    case "disabled":
      return "Documents are switched off in this classroom. Answer in the chat instead.";
    case "invalid":
      return (
        "The call needs format 'docx' or 'csv', a title of at most " +
        `${DOCUMENT_LIMITS.titleMaxChars} characters and Markdown of at most ` +
        `${DOCUMENT_LIMITS.markdownMaxChars} characters. Try again with those.`
      );
    case "empty":
      return "Nothing in that Markdown can go into a document. Write text, lists or tables.";
    case "table-too-large":
      return `A table may have at most ${TABLE_MAX_ROWS} rows and ${TABLE_MAX_COLUMNS} columns. Split it or shorten it.`;
    case "needs-one-table":
      return "A csv must contain exactly one Markdown table. Send just that table.";
    case "too-large":
      return "That document is too large to save. Make it shorter.";
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}
