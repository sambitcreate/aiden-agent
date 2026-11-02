import { isChatTriagePatch, type ChatTriagePatch, type ChatTriageResult } from "../../renderer/shared/chat-triage.js";
import { chatSurface, type ChatSurfaceInput } from "../../renderer/shared/chat-visibility.js";

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

/**
 * `chats:setTriage`: refuse a chat this host doesn't have, a Bot's chat and a
 * feature-owned chat, as the Remote route does, before the store keeps an
 * entry nothing lists.
 */
export async function setChatTriageFromRenderer(
  dependencies: {
    chats(): Promise<readonly (ChatSurfaceInput & { id: string })[]>;
    triage: { set(chatId: string, patch: ChatTriagePatch, options: { ifRevision?: number }): Promise<ChatTriageResult> };
  },
  id: unknown,
  patch: unknown,
  ifRevision?: unknown,
): Promise<ChatTriageResult> {
  const request = parseChatTriageRequest(id, patch, ifRevision);
  const chat = (await dependencies.chats()).find((entry) => entry.id === request.chatId);
  const surface = chat ? chatSurface(chat) : undefined;
  if (surface !== "regular" && surface !== "assistant") throw new Error("This chat no longer exists.");
  return dependencies.triage.set(request.chatId, request.patch, { ifRevision: request.ifRevision });
}
