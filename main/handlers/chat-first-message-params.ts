import { parseChatAppend, type ParsedChatAppend } from "./chat-append-params.js";
import { parseChatCreate } from "./chat-create-params.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import {
  parseFirstMessageWorktreeRequest,
  type FirstMessageWorktreeRequest,
} from "../../renderer/shared/worktree-on-send.js";

const KEYS = new Set([
  "draftId", "workspaceId", "providerId", "model", "title",
  "turnId", "message", "skillInvocation", "worktree",
]);

export interface ParsedChatFirstMessage extends ParsedChatAppend {
  title?: string;
  workspaceId: string;
  /** Create a managed worktree from the draft's workspace and save the chat there. */
  worktree?: FirstMessageWorktreeRequest;
  /**
   * Set only by the worktree commit path, never parsed from IPC: the workspace
   * a skill selection was minted in when it differs from the chat's workspace.
   */
  skillWorkspaceId?: string;
}

/** Project the complete untrusted envelope before retaining it across awaits. */
export function parseChatFirstMessage(input: unknown): ParsedChatFirstMessage {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid first-message request.");
  }
  const record = input as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (!KEYS.has(key)) throw new Error("Invalid first-message fields.");
  }
  // A dedicated UUID namespace prevents a draft from impersonating bot,
  // Assistant, scheduled, or imported chat identities.
  if (typeof record.draftId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.draftId)) {
    throw new Error("Invalid draft identifier.");
  }
  const create = parseChatCreate({
    title: record.title,
    workspaceId: record.workspaceId,
    providerId: record.providerId,
    model: record.model,
  });
  if (create.workspaceId === ASSISTANT_WORKSPACE_ID) {
    throw new Error("Assistant chats require the Assistant chat creation path.");
  }
  const append = parseChatAppend(record.draftId, record.message, {
    turnId: record.turnId,
    providerId: create.providerId,
    model: create.model,
    autoTitle: true,
    skillInvocation: record.skillInvocation,
  });
  if (!append.content.trim() && !append.attachments?.length) {
    throw new Error("Add a message or attachment before sending.");
  }
  let worktree: FirstMessageWorktreeRequest | undefined;
  if (record.worktree !== undefined) {
    worktree = parseFirstMessageWorktreeRequest(record.worktree);
    if (worktree.sourceWorkspaceId !== create.workspaceId) {
      throw new Error("A new worktree must start from the draft's workspace.");
    }
    if (worktree.idempotencyKey !== record.draftId.toLowerCase()) {
      throw new Error("The worktree request does not belong to this draft.");
    }
  }
  return {
    ...append,
    title: create.title,
    workspaceId: create.workspaceId,
    ...(worktree ? { worktree } : {}),
    // The small, bounded worktree request is left out so the chat commit that
    // follows it fingerprints the same message whatever base was chosen.
    retainedBytes: append.retainedBytes + Buffer.byteLength(create.workspaceId, "utf8") + Buffer.byteLength(create.title ?? "", "utf8") + 64,
  };
}
