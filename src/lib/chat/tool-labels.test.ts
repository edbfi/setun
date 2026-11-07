import { describe, expect, test } from "bun:test";
import { CREATE_DOCUMENT_TOOL, GENERATE_IMAGE_TOOL } from "$lib/server/agent/tools";
import { LOAD_SKILL_TOOL } from "$lib/server/skills/registry";
import {
  CREATE_DOCUMENT_TOOL_NAME,
  GENERATE_IMAGE_TOOL_NAME,
  LOAD_SKILL_TOOL_NAME,
  toolLabel,
} from "./tool-labels";

/**
 * The client cannot import the server's constants without dragging server code
 * into the bundle, so `tool-labels.ts` repeats the identifiers. This is the
 * test that keeps the copy honest: rename a tool on the server and it fails
 * here, rather than in front of a class.
 */
describe("built-in tool names", () => {
  test("match the server's own constants", () => {
    expect(LOAD_SKILL_TOOL_NAME).toBe(LOAD_SKILL_TOOL);
    expect(GENERATE_IMAGE_TOOL_NAME).toBe(GENERATE_IMAGE_TOOL);
    expect(CREATE_DOCUMENT_TOOL_NAME).toBe(CREATE_DOCUMENT_TOOL);
  });
});

describe("toolLabel", () => {
  test("translates Setun's own tools rather than showing the identifier", () => {
    expect(toolLabel(LOAD_SKILL_TOOL_NAME)).not.toBe(LOAD_SKILL_TOOL_NAME);
    expect(toolLabel(GENERATE_IMAGE_TOOL_NAME)).not.toBe(GENERATE_IMAGE_TOOL_NAME);
    expect(toolLabel(LOAD_SKILL_TOOL_NAME)).not.toMatch(/_/);
    expect(toolLabel(GENERATE_IMAGE_TOOL_NAME)).not.toMatch(/_/);
    expect(toolLabel(CREATE_DOCUMENT_TOOL_NAME)).not.toBe(CREATE_DOCUMENT_TOOL_NAME);
    expect(toolLabel(CREATE_DOCUMENT_TOOL_NAME)).not.toMatch(/_/);
  });

  test("leaves an MCP server's tool name alone — it is the operator's word", () => {
    expect(toolLabel("search_library")).toBe("search_library");
    expect(toolLabel("fetch")).toBe("fetch");
  });

  test("leaves a de-duplicated built-in alone rather than mislabelling it", () => {
    // `uniqueName` suffixes a built-in when an MCP server already claims the
    // name; that tool is the MCP one's neighbour, not Setun's tool.
    expect(toolLabel(`${LOAD_SKILL_TOOL_NAME}_2`)).toBe(`${LOAD_SKILL_TOOL_NAME}_2`);
  });
});
