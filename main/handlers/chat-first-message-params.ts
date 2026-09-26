import { parseChatAppend, type ParsedChatAppend } from "./chat-append-params.js";
import { parseChatCreate } from "./chat-create-params.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";

const KEYS = new Set([
  "draftId", "workspaceId", "providerId", "model", "computerUseEnabled", "title",
  "turnId", "message", "skillInvocation",
]);

export interface ParsedChatFirstMessage extends ParsedChatAppend {
  title?: string;
  workspaceId: string;
  computerUseEnabled: boolean;
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
  if (record.computerUseEnabled !== undefined && typeof record.computerUseEnabled !== "boolean") {
    throw new Error("Invalid Computer Use setting.");
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
  return {
    ...append,
    title: create.title,
    workspaceId: create.workspaceId,
    computerUseEnabled: record.computerUseEnabled === true,
    retainedBytes: append.retainedBytes + Buffer.byteLength(create.workspaceId, "utf8") + Buffer.byteLength(create.title ?? "", "utf8") + 64,
  };
}
