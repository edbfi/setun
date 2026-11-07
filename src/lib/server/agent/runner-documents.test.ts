import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "../db/queries/conversations";
import { listStudentDocuments } from "../db/queries/documents";
import { appendMessage, listConversationMessages } from "../db/queries/messages";
import { createTurn } from "../db/queries/turns";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { GatewayAdapter } from "../gateway/adapter";
import { streamingResponse, stubFetch } from "../gateway/testing";
import { resolveSkills } from "../skills/registry";
import { FileStore } from "../storage/files";
import { executeTurn } from "./runner";
import { buildToolSet, CREATE_DOCUMENT_TOOL, type ToolContext } from "./tools";

/**
 * A document written during a turn becomes a creation tied to the message that
 * wrote it. The attach is not gated on the turn's reported cost, unlike the
 * image attach beside it; the gateway here reports none at all.
 */

const ROOTS: string[] = [];

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

/** Ask for the document until its result comes back, then answer; no reported usage. */
function gateway() {
  return stubFetch((call) => {
    if (call.url.endsWith("/v1/models")) return Response.json({ data: [] });

    const messages = (call.body as { messages?: { role: string }[] }).messages ?? [];
    const delta = messages.some((message) => message.role === "tool")
      ? { content: "Her er dit arbejdsark." }
      : {
          tool_calls: [
            {
              index: 0,
              id: "call-doc",
              function: {
                name: CREATE_DOCUMENT_TOOL,
                arguments: JSON.stringify({
                  format: "docx",
                  title: "Arbejdsark",
                  markdown: "# Arbejdsark\n\n1. Hvad er fotosyntese?",
                }),
              },
            },
          ],
        };

    return streamingResponse([
      JSON.stringify({ choices: [{ delta }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
      "[DONE]",
    ]);
  });
}

describe("a document written during a turn", () => {
  it("is recorded as a part and attached to the message that wrote it", async () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    const root = mkdtempSync(join(tmpdir(), "setun-runner-documents-"));
    ROOTS.push(root);
    const adapter = new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: gateway().fetch,
    });

    const conversation = createConversation(db, {
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
    });
    const prompt = appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "Lav et arbejdsark" }],
    });
    const turn = createTurn(db, {
      conversationId: conversation.id,
      studentId: fixtures.student.id,
      parentMessageId: prompt.id,
    });

    const toolContext: ToolContext = {
      db,
      adapter,
      files: new FileStore(root),
      mcp: null,
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      conversationId: conversation.id,
      skills: resolveSkills(db, {
        classroomId: fixtures.classroom.id,
        studentId: fixtures.student.id,
        authoringPolicy: "immediate",
      }),
    };

    await executeTurn({
      db,
      adapter,
      turnId: turn.id,
      conversationId: conversation.id,
      studentId: fixtures.student.id,
      classroomId: fixtures.classroom.id,
      alias: fixtures.alias,
      parentMessageId: prompt.id,
      path: [prompt],
      tools: buildToolSet(toolContext),
      toolContext,
      permissionMode: "open",
    });

    const [document] = listStudentDocuments(db, fixtures.student.id);
    expect(document).toMatchObject({ title: "Arbejdsark", format: "docx" });

    const assistant = listConversationMessages(db, conversation.id).find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.parts).toContainEqual({
      type: "generated-document",
      documentId: document?.id,
      title: "Arbejdsark",
      format: "docx",
    });
    expect(document?.messageId).toBe(assistant?.id ?? "missing");
  });
});
