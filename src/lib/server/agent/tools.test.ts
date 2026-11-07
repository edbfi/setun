import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppDatabase } from "../db/client";
import { allowAlias } from "../db/queries/classroom-aliases";
import { createConversation } from "../db/queries/conversations";
import {
  allowTool,
  listAllowedTools,
  listMcpTools,
  setMcpServerEnabled,
  setMcpToolFlags,
  syncMcpTools,
  upsertMcpServer,
} from "../db/queries/mcp";
import { createAlias } from "../db/queries/model-aliases";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { GatewayAdapter } from "../gateway/adapter";
import { stubFetch } from "../gateway/testing";
import { McpClient } from "../mcp/client";
import type { McpServerConfig } from "../mcp/config";
import { resolveSkills } from "../skills/registry";
import { FileStore } from "../storage/files";
import { requiresPermission } from "./permissions";
import {
  buildToolSet,
  CREATE_DOCUMENT_TOOL,
  executeTool,
  GENERATE_IMAGE_TOOL,
  type ToolContext,
} from "./tools";

/**
 * The turn's tool set and the permission modes (plan 3.3, 3.4, PRD §11, §12,
 * §15, §22).
 *
 * §21 requires that "tool allowlists and permission modes… are enforced
 * server-side and verified against direct API access". The allowlist half is
 * asserted here at its source: a tool absent from the classroom's allowlist is
 * absent from the set, so it is neither offered to a model nor reachable by name.
 */

const SERVER_CONFIG: McpServerConfig = {
  key: "docs",
  label: "Skolens dokumenter",
  url: "http://mcp.test/mcp",
  headers: {},
  parameterHeaderAllowlist: [],
};

/**
 * Documents are on by default in a real classroom; these tests about the MCP
 * allowlist assert the exact set, so they leave the document writer out unless
 * a test asks for it.
 */
function contextFor(
  db: AppDatabase,
  fixtures: ReturnType<typeof seedTestFixtures>,
  options: { documents?: boolean; storageRoot?: string } = {},
): ToolContext {
  return {
    db,
    adapter: new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: stubFetch(() => new Response("{}")).fetch,
    }),
    files: new FileStore(options.storageRoot ?? "/tmp/setun-test-does-not-exist"),
    mcp: new McpClient([SERVER_CONFIG]),
    classroom: { ...fixtures.classroom, documentsEnabled: options.documents ?? false },
    studentId: fixtures.student.id,
    conversationId: crypto.randomUUID(),
    skills: resolveSkills(db, {
      classroomId: fixtures.classroom.id,
      studentId: fixtures.student.id,
      authoringPolicy: "immediate",
    }),
  };
}

/** A registered server with one enabled tool, ready to be allowlisted. */
function seedTool(db: AppDatabase, options: { sensitive?: boolean } = {}) {
  const server = upsertMcpServer(db, { configKey: "docs", label: "Skolens dokumenter" });
  setMcpServerEnabled(db, { serverId: server.id, enabled: true });
  syncMcpTools(db, {
    serverId: server.id,
    tools: [{ name: "search", description: "Find things", inputSchema: { type: "object" } }],
  });

  const tool = listMcpTools(db, server.id)[0];
  setMcpToolFlags(db, { toolId: tool.id, enabled: true, sensitive: options.sensitive ?? false });

  return { server, tool };
}

describe("the turn's tool set", () => {
  it("offers a tool the classroom allowlists", () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    const { tool } = seedTool(db);
    allowTool(db, { classroomId: fixtures.classroom.id, mcpToolId: tool.id });

    const tools = buildToolSet(contextFor(db, fixtures));

    expect(tools.all.map((entry) => entry.name)).toEqual(["docs__search"]);
    expect(tools.definitions()[0]).toEqual({
      name: "docs__search",
      description: "Find things",
      inputSchema: { type: "object" },
    });
  });

  it("omits a tool the classroom has not allowlisted (§11, §21)", () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    seedTool(db);

    expect(buildToolSet(contextFor(db, fixtures)).size).toBe(0);
  });

  it("omits an allowlisted tool once the educator disables it", () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    const { tool } = seedTool(db);
    allowTool(db, { classroomId: fixtures.classroom.id, mcpToolId: tool.id });

    setMcpToolFlags(db, { toolId: tool.id, enabled: false });
    expect(buildToolSet(contextFor(db, fixtures)).size).toBe(0);
  });

  it("omits every tool of a server the educator switched off", () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    const { server, tool } = seedTool(db);
    allowTool(db, { classroomId: fixtures.classroom.id, mcpToolId: tool.id });

    setMcpServerEnabled(db, { serverId: server.id, enabled: false });
    expect(listAllowedTools(db, fixtures.classroom.id)).toEqual([]);
    expect(buildToolSet(contextFor(db, fixtures)).size).toBe(0);
  });

  it("keeps one classroom's allowlist out of another's", () => {
    const db = createTestDatabase();
    const first = seedTestFixtures(db, { label: "brave-otter", digest: "a" });
    const second = seedTestFixtures(db, { label: "keen-lynx", digest: "b" });
    const { tool } = seedTool(db);
    allowTool(db, { classroomId: first.classroom.id, mcpToolId: tool.id });

    expect(buildToolSet(contextFor(db, first)).size).toBe(1);
    expect(buildToolSet(contextFor(db, second)).size).toBe(0);
  });

  it("offers the image generator only where a generation-capable alias is allowlisted (§15)", () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);

    expect(buildToolSet(contextFor(db, fixtures)).find(GENERATE_IMAGE_TOOL)).toBeUndefined();

    const painter = createAlias(db, {
      name: "Painter",
      gatewayModelId: "image-model",
      dialect: "openai",
      supportsImageGeneration: true,
    });
    allowAlias(db, { classroomId: fixtures.classroom.id, modelAliasId: painter.id });

    expect(buildToolSet(contextFor(db, fixtures)).find(GENERATE_IMAGE_TOOL)).toBeDefined();
  });

  it("gives every tool a name both dialects accept, breaking collisions", () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    const server = upsertMcpServer(db, { configKey: "docs", label: "Docs" });
    setMcpServerEnabled(db, { serverId: server.id, enabled: true });
    syncMcpTools(db, {
      serverId: server.id,
      tools: [
        { name: "a b/c", description: null, inputSchema: null },
        { name: "a_b_c", description: null, inputSchema: null },
      ],
    });

    for (const tool of listMcpTools(db, server.id)) {
      setMcpToolFlags(db, { toolId: tool.id, enabled: true });
      allowTool(db, { classroomId: fixtures.classroom.id, mcpToolId: tool.id });
    }

    const names = buildToolSet(contextFor(db, fixtures)).all.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  /**
   * The OpenAI dialect prefixes every name with `setun_` on the wire, so the
   * limit that matters is the one the provider enforces on what it receives (§9).
   */
  it("leaves room for the wire prefix in the longest name it will build", () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    const server = upsertMcpServer(db, { configKey: "docs", label: "Docs" });
    setMcpServerEnabled(db, { serverId: server.id, enabled: true });
    syncMcpTools(db, {
      serverId: server.id,
      tools: [{ name: "x".repeat(120), description: null, inputSchema: null }],
    });

    for (const tool of listMcpTools(db, server.id)) {
      setMcpToolFlags(db, { toolId: tool.id, enabled: true });
      allowTool(db, { classroomId: fixtures.classroom.id, mcpToolId: tool.id });
    }

    const [name] = buildToolSet(contextFor(db, fixtures)).all.map((tool) => tool.name);
    expect(name.length).toBe(54);
    expect(`setun_${name}`.length).toBeLessThanOrEqual(60);
  });
});

describe("permission modes (§11)", () => {
  const mcp = { kind: "mcp" as const, sensitive: false };
  const sensitive = { kind: "mcp" as const, sensitive: true };
  const skillLoad = { kind: "skill-load" as const, sensitive: false };
  const image = { kind: "generate-image" as const, sensitive: false };
  const document = { kind: "create-document" as const, sensitive: false };

  it("strict asks about every tool call", () => {
    expect(requiresPermission("strict", mcp)).toBe(true);
    expect(requiresPermission("strict", sensitive)).toBe(true);
    expect(requiresPermission("strict", image)).toBe(true);
    expect(requiresPermission("strict", document)).toBe(true);
  });

  it("treats the document writer as an ordinary tool in standard and open", () => {
    expect(requiresPermission("standard", document)).toBe(false);
    expect(requiresPermission("open", document)).toBe(false);
  });

  it("standard runs enabled tools and asks only about the sensitive ones", () => {
    expect(requiresPermission("standard", mcp)).toBe(false);
    expect(requiresPermission("standard", sensitive)).toBe(true);
  });

  it("open never asks", () => {
    expect(requiresPermission("open", mcp)).toBe(false);
    expect(requiresPermission("open", sensitive)).toBe(false);
    expect(requiresPermission("open", image)).toBe(false);
  });

  it("never prompts for the internal skill loader, in any mode (§12)", () => {
    for (const mode of ["strict", "standard", "open"] as const) {
      expect(requiresPermission(mode, skillLoad)).toBe(false);
    }
  });
});

const ROOTS: string[] = [];

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

describe("the document writer", () => {
  it("is offered while the classroom allows documents, and not otherwise", () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);

    // A new classroom allows them: the switch defaults to on.
    expect(fixtures.classroom.documentsEnabled).toBe(true);
    const offered = buildToolSet(contextFor(db, fixtures, { documents: true }));
    expect(offered.find(CREATE_DOCUMENT_TOOL)).toMatchObject({
      kind: "create-document",
      sensitive: false,
      serverLabel: null,
    });
    expect(buildToolSet(contextFor(db, fixtures)).find(CREATE_DOCUMENT_TOOL)).toBeUndefined();
  });

  it("returns a document only on success, and never on an error result", async () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    const storageRoot = mkdtempSync(join(tmpdir(), "setun-tool-documents-"));
    ROOTS.push(storageRoot);
    const conversation = createConversation(db, {
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
    });
    const context = {
      ...contextFor(db, fixtures, { documents: true, storageRoot }),
      conversationId: conversation.id,
    };
    const tool = buildToolSet(context).find(CREATE_DOCUMENT_TOOL);
    if (!tool) throw new Error("expected the document tool");

    const written = await executeTool({
      context,
      tool,
      arguments: { format: "docx", title: "Fotosyntese", markdown: "# Fotosyntese\n\nTekst" },
    });
    expect(written.isError).toBe(false);
    expect(written.document).toMatchObject({ title: "Fotosyntese", format: "docx" });
    // The model is told it worked, never where the file lives.
    expect(written.text).not.toContain("/api/documents");

    for (const args of [
      { format: "pdf", title: "T", markdown: "Text" },
      { format: "docx", title: 5, markdown: "Text" },
      { format: "csv", title: "T", markdown: "no table here" },
    ]) {
      const refused = await executeTool({ context, tool, arguments: args });
      expect(refused.isError).toBe(true);
      expect(refused.document).toBeUndefined();
    }
  });
});
