import * as m from "$lib/paraglide/messages";

/**
 * What a pupil is told a tool was (PRD §8, §11, §18).
 *
 * The tool chip above an answer is the most-read line on the most-read surface
 * in the product, and until now it printed the identifier the model calls:
 * "Brugte load_skill", "Brugte generate_image". Those are English snake_case
 * internals in the middle of an otherwise fully Danish page, and they were the
 * only untranslated strings a pupil ever saw.
 *
 * Setun's own tools get a phrase in the pupil's language. Tools from an MCP
 * server keep their own name, deliberately: that name is the operator's, it is
 * what the classroom's tool allowlist calls the same tool, and inventing a
 * translation for it would leave a pupil and their teacher describing the same
 * thing differently.
 *
 * The identifiers are repeated here rather than imported from
 * `$lib/server/...`, because a value imported from a server module travels into
 * the client bundle with everything it pulls in. `tool-labels.test.ts` asserts
 * they stay in step with the server's constants, so the duplication cannot drift
 * silently.
 */

/** Mirrors `LOAD_SKILL_TOOL` in `$lib/server/skills/registry`. */
export const LOAD_SKILL_TOOL_NAME = "load_skill";

/** Mirrors `GENERATE_IMAGE_TOOL` in `$lib/server/agent/tools`. */
export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

/** Mirrors `CREATE_DOCUMENT_TOOL` in `$lib/server/documents/formats`. */
export const CREATE_DOCUMENT_TOOL_NAME = "create_document";

/**
 * The pupil-facing name of a tool.
 *
 * Built-in tools are translated; anything else — an MCP server's tool, or a
 * built-in that has been suffixed to avoid a name collision with one — is
 * returned unchanged.
 */
export function toolLabel(toolName: string): string {
  if (toolName === LOAD_SKILL_TOOL_NAME) return m.chat_tool_name_load_skill();
  if (toolName === GENERATE_IMAGE_TOOL_NAME) return m.chat_tool_name_generate_image();
  if (toolName === CREATE_DOCUMENT_TOOL_NAME) return m.chat_tool_name_create_document();

  return toolName;
}
