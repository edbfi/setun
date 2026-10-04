import { redirect } from "@sveltejs/kit";
import { effectiveArtifactKey, effectiveLanguage } from "$lib/artifacts/identity";
import { diffFileLists } from "$lib/artifacts/project";
import type { ArtifactLanguage, BuildStatus } from "$lib/artifacts/types";
import { generationAliases } from "$lib/server/agent/image-generation";
import { requireStudentPage } from "$lib/server/auth/guards";
import { destroySession, SESSION_COOKIE_NAME } from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";
import { classroomAvailability } from "$lib/server/classroom/enforcement";
import { resolveClassroomStatus } from "$lib/server/classroom/status";
import { getConfig } from "$lib/server/config";
import { cookieDeletion } from "$lib/server/cookies";
import {
  attachSnapshots,
  listConversationArtifacts,
  listVersionFiles,
  previousVersionIds,
  versionsByMessage,
} from "$lib/server/db/queries/artifacts";
import { listPendingAttachments } from "$lib/server/db/queries/attachments";
import { listClassroomAliases } from "$lib/server/db/queries/classroom-aliases";
import { getClassroom } from "$lib/server/db/queries/classrooms";
import {
  createConversation,
  getOwnedConversation,
  listConversations,
} from "$lib/server/db/queries/conversations";
import { getActivePath, listSiblings } from "$lib/server/db/queries/messages";
import { findActiveTurn } from "$lib/server/db/queries/turns";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The chat route's data (PRD §10).
 *
 * Thin by §6.1: authorise, delegate to the query modules, shape the response.
 * Everything returned is already owner-scoped in SQL.
 *
 * The classroom status travels with the page so a pupil arriving out of hours
 * sees the status screen rather than a composer that will be refused (§8). It is
 * presentation only — the API refuses regardless of what this said.
 */
export const load: PageServerLoad = ({ locals, url }) => {
  const student = requireStudentPage(locals);
  const db = getDb();

  const conversations = listConversations(db, student.id);
  const requestedId = url.searchParams.get("c");

  const active = requestedId
    ? getOwnedConversation(db, { conversationId: requestedId, studentId: student.id })
    : conversations[0];

  // The parts travel whole: tool calls, generated images and attachments are as
  // much of the transcript as the prose is, and the same component renders a
  // reloaded message and a streaming one (§10, §11, §15).
  const conversationId = active?.id;
  const path = active?.activeLeafId ? getActivePath(db, active.activeLeafId) : [];

  /**
   * The artifacts each message produced, so the transcript can show a card that
   * opens one rather than the markup it was written as (§13, §20).
   *
   * Read for the whole path in one query and grouped here: one query per message
   * would be a query per artifact block in a lesson-long thread.
   */
  const messageArtifacts = new Map<
    string,
    {
      artifactId: string;
      versionId: string;
      revision: number;
      key: string;
      language: ArtifactLanguage;
      title: string | null;
      buildStatus: BuildStatus | null;
      entry: string;
      fileCount: number;
      added: number;
      modified: number;
    }[]
  >();
  const written = versionsByMessage(
    db,
    path.map((message) => message.id),
  );
  /**
   * What each revision holds and what it changed, without its content (§13).
   *
   * The transcript's card says "3 files · +1 ~2", which is the whole of what a
   * pupil needs to see from a message that revised one file of a project — and
   * none of it needs the sources.
   */
  const filesByVersion = new Map<string, { path: string; hash: string }[]>();
  const writtenIds = written.map(({ version }) => version.id);
  const predecessors = previousVersionIds(db, writtenIds);
  for (const file of listVersionFiles(db, [
    ...new Set([...writtenIds, ...predecessors.values()]),
  ])) {
    filesByVersion.set(file.versionId, [...(filesByVersion.get(file.versionId) ?? []), file]);
  }

  for (const { artifact, version } of written) {
    if (!version.messageId) continue;

    const files = filesByVersion.get(version.id) ?? [];
    const previousId = predecessors.get(version.id);
    const previous = previousId ? (filesByVersion.get(previousId) ?? []) : [];
    const changes = diffFileLists(previous, files);

    const held = messageArtifacts.get(version.messageId) ?? [];
    held.push({
      artifactId: artifact.id,
      versionId: version.id,
      revision: version.revision,
      key: effectiveArtifactKey(artifact),
      // The tag the block in this message was written under, which is not
      // necessarily the tag the row answers to now (§13).
      language: effectiveLanguage(artifact, version),
      title: artifact.title,
      buildStatus: version.buildStatus,
      entry: version.entryPath,
      fileCount: files.length,
      added: changes.filter((change) => change.change === "added").length,
      modified: changes.filter((change) => change.change === "modified").length,
    });
    messageArtifacts.set(version.messageId, held);
  }

  const messages = conversationId
    ? path.map((message) => {
        // A branch point is a message with siblings — the variants an edit or
        // a regenerate left addressable but off-screen. The picker needs only
        // this message's position and the neighbours to step to; the switch
        // endpoint resolves each neighbour to its branch tip.
        const siblings = listSiblings(db, conversationId, message.parentId);
        const index = siblings.findIndex((sibling) => sibling.id === message.id);
        const branch =
          siblings.length > 1 && index !== -1
            ? {
                index,
                total: siblings.length,
                prevId: index > 0 ? siblings[index - 1].id : null,
                nextId: index < siblings.length - 1 ? siblings[index + 1].id : null,
              }
            : null;

        return {
          id: message.id,
          role: message.role,
          parts: message.parts,
          branch,
          // In recording order — which is the order the blocks were written,
          // so the transcript's cards line up with the prose around them.
          artifacts: messageArtifacts.get(message.id) ?? [],
        };
      })
    : [];

  // A turn still streaming when this tab reloaded: the client resumes it from
  // the buffer rather than losing the answer (§10).
  const activeTurn = findActiveTurn(db, student.id);
  const classroom = getClassroom(db, student.classroomId);
  const aliases = listClassroomAliases(db, student.classroomId);

  return {
    student: {
      label: student.label,
      displayName: student.displayName,
      interfaceLanguage: student.interfaceLanguage,
    },
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
    })),
    conversation: active ? { id: active.id, title: active.title } : null,
    messages,
    resumeTurnId: activeTurn?.conversationId === active?.id ? (activeTurn?.id ?? null) : null,
    // Only what this classroom is allowed to use — students never see an alias
    // their educator has not allowlisted, and never the gateway identifier
    // behind it (§8, §9, §21).
    aliases: aliases.map((alias) => ({ id: alias.id, name: alias.name })),
    hasModel: aliases.length > 0,
    /** Which model answered in this conversation; null before there is one. */
    modelAliasId: active?.modelAliasId ?? null,
    // Presentation only: the upload endpoint refuses on its own policy read, and
    // hiding a control is never access control (§8, §10, §21).
    attachmentsEnabled: student.attachmentsEnabled ?? classroom?.attachmentsEnabled ?? false,
    imageModeAvailable: generationAliases(db, student.classroomId).length > 0,
    /**
     * Whether this classroom lets the pupil see the model reason (§20).
     *
     * Presentation only: `hidden` is enforced in the runner, which drops the
     * events before the turn is buffered, so a pupil cannot reach the reasoning
     * by any route whatever this value says (§21).
     */
    thinkingVisibility: classroom?.thinkingVisibility ?? "student",
    // Uploads the pupil made before this reload; the composer shows them again.
    pendingAttachments: active
      ? listPendingAttachments(db, { studentId: student.id, conversationId: active.id }).map(
          (file) => ({
            id: file.id,
            filename: file.filename,
            kind: file.kind,
            mediaType: file.mediaType,
            byteSize: file.byteSize,
          }),
        )
      : [],
    status: resolveClassroomStatus(db, student),
    // Artifacts this conversation produced, each with the revision on screen.
    // Creations outlive conversations, so the gallery reads them separately (§16).
    artifacts: active
      ? attachSnapshots(
          db,
          listConversationArtifacts(db, { conversationId: active.id, studentId: student.id }),
        ).map(({ artifact, latest, source, snapshot }) => ({
          id: artifact.id,
          language: artifact.language,
          title: artifact.title,
          key: effectiveArtifactKey(artifact),
          latest: {
            id: latest.id,
            revision: latest.revision,
            source,
            entry: snapshot.entry,
            files: snapshot.files,
            language: latest.language,
            authoredBy: latest.authoredBy,
            buildStatus: latest.buildStatus,
            buildMessage: latest.buildMessage,
            createdAt: latest.createdAt.toISOString(),
          },
        }))
      : [],
    // A distinct hostname, and the only other thing Caddy exposes: artifacts are
    // isolated by origin, not by path (§6, §14). Public, not a secret.
    sandboxOrigin: getConfig().sandboxOrigin,
  };
};

export const actions: Actions = {
  /**
   * Start a new conversation — by clearing the active one, not by creating a row.
   *
   * The conversation is minted on the first send (§10), so this leaves the pupil
   * with an empty composer and, while nothing is bound yet, a choice of model.
   * Creating an empty conversation here would spend that choice before they made
   * it, and leave a row behind for every pupil who opened the page and left.
   *
   * Still a form action, so it works without JavaScript.
   */
  create: async ({ request, locals }) => {
    const student = requireStudentPage(locals);
    const db = getDb();

    // Closed or out-of-hours: redirect lands on the ClassroomClosed screen.
    const availability = classroomAvailability(db, student.classroomId);
    if (!availability?.open) redirect(303, "/chat");

    const allowed = listClassroomAliases(db, student.classroomId);
    if (allowed.length === 0) redirect(303, "/chat");

    // The model the pupil picked, when they picked one. An alias is bound to a
    // conversation the moment it is created and every message in one was
    // answered by that model, so this is where the choice belongs (§9). Anything
    // the classroom has not allowlisted falls back to the first alias it has:
    // hiding a control is never access control, and neither is trusting one (§8).
    const requested = (await request.formData()).get("modelAliasId");
    const alias = allowed.find((candidate) => candidate.id === requested) ?? allowed[0];

    const conversation = createConversation(db, {
      studentId: student.id,
      modelAliasId: alias.id,
    });

    redirect(303, `/chat?c=${conversation.id}`);
  },

  logout: async ({ locals, cookies, url }) => {
    if (locals.sessionToken) destroySession(getDb(), locals.sessionToken);
    cookies.delete(SESSION_COOKIE_NAME, cookieDeletion(url, "/"));

    redirect(303, "/login");
  },
};
