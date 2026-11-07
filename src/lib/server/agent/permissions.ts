import type { PermissionMode } from "../db/schema";

/**
 * Tool permission modes (PRD §11).
 *
 * "Each classroom runs in one of three modes, applied by the agent loop before
 * any tool executes:
 *
 *  - Strict — every tool call pauses as a permission request the student
 *    approves or declines.
 *  - Standard (default) — enabled tools run automatically, except tools the
 *    educator has flagged as sensitive at enablement time, which ask.
 *  - Open — everything runs without confirmation."
 *
 * One function, called by the loop and by nothing else. It is deliberately pure:
 * whether a tool may run is a policy question, and mixing it with the machinery
 * of *asking* would make the policy untestable without a student to answer.
 */

/** What kind of tool this is — the one distinction the modes do not apply to. */
export type ToolKind =
  /** A tool from a configured MCP server (§11). */
  | "mcp"
  /**
   * The internal skill loader (§12).
   *
   * "The load tool is internal, not an MCP tool: it never triggers a permission
   * prompt in any permission mode, though a load does consume a per-turn
   * tool-call step like any other tool invocation."
   */
  | "skill-load"
  /** The internal image generator, which the modes *do* apply to (§15). */
  | "generate-image"
  /** The internal document writer; the modes apply to it as to images. */
  | "create-document";

export interface PermissionSubject {
  readonly kind: ToolKind;
  /** Set by the educator at enablement time; only consulted in standard mode (§11). */
  readonly sensitive: boolean;
}

/**
 * Whether this call must pause and ask the student.
 *
 * The skill loader is exempt in every mode, by §12. Image generation is not:
 * §15 says it is offered "subject to the classroom's permission mode like any
 * other tool", and it spends the class's tokens.
 */
export function requiresPermission(mode: PermissionMode, subject: PermissionSubject): boolean {
  if (subject.kind === "skill-load") return false;

  switch (mode) {
    case "strict":
      return true;
    case "standard":
      return subject.sensitive;
    case "open":
      return false;
  }
}

/** What the student decided, or what happened instead of a decision. */
export type PermissionDecision = "approved" | "declined" | "unanswered";

/**
 * The result a declined call returns to the model (§11).
 *
 * "A declined tool call returns a refusal result to the model and the loop
 * continues." Phrased for the model, not for the student: the student already
 * knows what they declined, and the model needs to be told plainly enough that
 * it stops trying the same call again.
 */
export const DECLINED_RESULT =
  "The student declined this tool call. Do not retry it. Continue without it, and say what you can without the tool.";

/** The result an unanswered request returns, so a silent tab does not hang a turn. */
export const UNANSWERED_RESULT =
  "The student did not answer the permission request in time, so the tool was not run. Continue without it.";
