import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { markArtifactEditsDelivered, outgoingArtifactEditParts } from "$lib/server/agent/artifacts";
import { budgetsOf } from "$lib/server/agent/budgets";
import {
  assertTurnCapacity,
  TurnInFlightError,
  TurnLimitError,
} from "$lib/server/agent/concurrency";
import { executeTurn } from "$lib/server/agent/runner";
import { sseResponse, TURN_ID_HEADER } from "$lib/server/agent/sse-response";
import { streamTurnEvents } from "$lib/server/agent/stream";
import { generateConversationTitle } from "$lib/server/agent/title";
import { prepareTurn } from "$lib/server/agent/turn-setup";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb, getFileStore, getGatewayAdapter, getMcpClient } from "$lib/server/boot";
import { checkModelAccess } from "$lib/server/classroom/enforcement";
import { attachToMessage, listPendingAttachments } from "$lib/server/db/queries/attachments";
import { getOwnedConversation, setActiveLeaf } from "$lib/server/db/queries/conversations";
import { appendMessage, appendSibling, getActivePath } from "$lib/server/db/queries/messages";
import { getAliasById } from "$lib/server/db/queries/model-aliases";
import { createTurn } from "$lib/server/db/queries/turns";
import type { MessagePart } from "$lib/server/db/schema";
import type { RequestHandler } from "./$types";

/**
 * Send a message and stream the answer (PRD §10).
 *
 * Thin by §6.1: parse, authorise, delegate to `$lib/server/agent`, shape the
 * response. The turn runs detached from this request, so the same
 * `streamTurnEvents` serves this response and a later resume — one code path.
 *
 * This is a path that can reach a model, so it passes through the one
 * enforcement guard before anything else happens (§8, §21). The composer's own
 * state is never trusted: a client that never heard about a lock is refused
 * here exactly as one that did.
 */

const SendSchema = v.object({
  conversationId: v.pipe(v.string(), v.uuid()),
  text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32_000)),
  /**
   * Present when editing an existing prompt: the new text is appended as a
   * sibling of that message rather than as a child of the active leaf (§10).
   */
  editOfMessageId: v.optional(v.pipe(v.string(), v.uuid())),
});

export const POST: RequestHandler = async ({ request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const parsed = v.safeParse(SendSchema, await request.json().catch(() => null));
  if (!parsed.success) error(400, "Invalid request");

  const { conversationId, text, editOfMessageId } = parsed.output;

  // Ownership resolved in SQL: another student's conversation is simply absent (§21).
  const conversation = getOwnedConversation(db, { conversationId, studentId: student.id });
  if (!conversation) error(404, "Not found");

  // Availability, the classroom allowlist and the daily budgets, in one guard.
  const access = checkModelAccess({
    db,
    student,
    modelAliasId: conversation.modelAliasId,
  });

  if (!access.allowed) {
    // A machine-readable code, not a sentence: the browser renders its own
    // Paraglide message, so no server string reaches a pupil (§8, §21).
    return json(
      {
        error: access.reason,
        nextOpeningAt: access.availability.nextOpeningAt?.toISOString() ?? null,
      },
      { status: 403 },
    );
  }

  const alias = getAliasById(db, conversation.modelAliasId);
  if (!alias) error(409, "Model unavailable");

  // One answer per conversation, and the classroom's limit across all of a
  // pupil's conversations (§10). Nothing below awaits before the turn row is
  // written, so a second send cannot slip in between the check and the insert.
  try {
    assertTurnCapacity(db, {
      studentId: student.id,
      conversationId,
      limit: access.classroom.maxConcurrentTurns,
    });
  } catch (cause) {
    if (cause instanceof TurnInFlightError) {
      return json({ error: "turn-in-flight", activeTurnId: cause.activeTurnId }, { status: 409 });
    }
    if (cause instanceof TurnLimitError) {
      return json({ error: "turn-limit", limit: cause.limit }, { status: 409 });
    }
    throw cause;
  }

  // Uploads the student made against this conversation and has not yet sent.
  // Text and code files were inlined at upload time; images travel as parts (§10).
  const pending = listPendingAttachments(db, { studentId: student.id, conversationId });
  // Artifacts the student edited since the model last wrote them ride along,
  // marked as theirs, so a pupil can ask about their own broken code without
  // pasting it back in (§13). An edited prompt also re-carries what the message
  // it replaces held, which the new branch would otherwise leave behind.
  const edits = outgoingArtifactEditParts(db, {
    conversationId,
    studentId: student.id,
    editOfMessageId,
  });
  const parts: MessagePart[] = [
    { type: "text", text },
    ...pending.map((file) => ({
      type: "attachment" as const,
      attachmentId: file.id,
      kind: file.kind,
      filename: file.filename,
      mediaType: file.mediaType,
    })),
    ...edits,
  ];

  const prompt = editOfMessageId
    ? appendSibling(db, {
        siblingOfId: editOfMessageId,
        conversationId,
        role: "user",
        parts,
      })
    : appendMessage(db, {
        conversationId,
        parentId: conversation.activeLeafId ?? null,
        role: "user",
        parts,
      });

  if (!prompt) error(404, "Not found");

  attachToMessage(db, {
    attachmentIds: pending.map((file) => file.id),
    messageId: prompt.id,
    studentId: student.id,
  });

  markArtifactEditsDelivered(db, edits);

  setActiveLeaf(db, { conversationId, studentId: student.id, messageId: prompt.id });

  const turn = createTurn(db, {
    conversationId,
    studentId: student.id,
    parentMessageId: prompt.id,
  });

  const path = getActivePath(db, prompt.id);

  // The educator's steering instrument, the classroom's tools and the student's
  // skills, resolved together so the prompt and the tool set cannot disagree
  // about what is available (§10, §11, §12).
  const prepared = await prepareTurn({
    db,
    adapter: getGatewayAdapter(),
    files: getFileStore(),
    mcp: getMcpClient(),
    classroom: access.classroom,
    student,
    conversationId,
    path,
  });

  // Detached on purpose: a closed tab must not cancel the turn, because the
  // student can resume it (§10).
  void executeTurn({
    db,
    adapter: getGatewayAdapter(),
    turnId: turn.id,
    conversationId,
    studentId: student.id,
    classroomId: student.classroomId,
    alias,
    parentMessageId: prompt.id,
    path,
    attachmentPayloads: prepared.attachmentPayloads,
    promptLayers: prepared.promptLayers,
    artifacts: prepared.artifacts,
    budgets: budgetsOf(access.classroom),
    consumed: access.consumed,
    tools: prepared.tools,
    toolContext: prepared.toolContext,
    permissionMode: access.classroom.permissionMode,
    thinkingVisibility: access.classroom.thinkingVisibility,
  });

  // Titles are generated after the first exchange, asynchronously, and never
  // block or break the turn they name (§10).
  if (!conversation.title) {
    void generateConversationTitle({
      db,
      adapter: getGatewayAdapter(),
      conversationId,
      studentId: student.id,
      classroom: access.classroom,
      conversationAlias: alias,
      firstMessage: text,
    });
  }

  return sseResponse(streamTurnEvents(db, turn.id), {
    headers: { [TURN_ID_HEADER]: turn.id },
  });
};
