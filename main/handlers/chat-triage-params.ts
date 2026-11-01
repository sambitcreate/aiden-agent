import { isChatTriagePatch, type ChatTriagePatch } from "../../renderer/shared/chat-triage.js";

export interface ChatTriageRequest {
  chatId: string;
  patch: ChatTriagePatch;
  ifRevision?: number;
}

/** Validate a renderer `chats:setTriage` call before it reaches the store. */
export function parseChatTriageRequest(id: unknown, patch: unknown, ifRevision?: unknown): ChatTriageRequest {
  if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(id)) {
    throw new Error('Expected a chat id for "id".');
  }
  if (!isChatTriagePatch(patch)) {
    throw new Error("Expected a triage change with pinned, done or snoozeUntil.");
  }
  if (ifRevision !== undefined && !(typeof ifRevision === "number" && Number.isSafeInteger(ifRevision) && ifRevision >= 0)) {
    throw new Error('Expected a whole number for "ifRevision".');
  }
  const request: ChatTriageRequest = {
    chatId: id,
    patch: {
      ...("pinned" in patch ? { pinned: patch.pinned } : {}),
      ...("done" in patch ? { done: patch.done } : {}),
      ...("snoozeUntil" in patch ? { snoozeUntil: patch.snoozeUntil } : {}),
    },
  };
  if (ifRevision !== undefined) request.ifRevision = ifRevision as number;
  return request;
}
