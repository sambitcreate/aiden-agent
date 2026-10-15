import type { HostChatAdapter, HostChatApprovalInput, HostChatQuestionInput, HostChatInput, HostChatSendInput, HostChatForkInput } from "../lib/hosts/host-chat-adapter";

/** Saved locally before transmission; contains no credential or transport address. */
export type SavedChatRequest =
  | { kind: "send"; input: HostChatSendInput }
  | { kind: "cancel"; input: { runId: string; idempotencyKey: string } }
  | { kind: "respondApproval"; input: HostChatApprovalInput }
  | { kind: "answerQuestion"; input: HostChatQuestionInput }
  | { kind: "submitInput"; input: HostChatInput }
  | { kind: "fork"; input: HostChatForkInput; signature: string };
export interface SavedChatIntent {
  hostId: string;
  chatId: string;
  idempotencyKey: string;
  createdAt: number;
  request: SavedChatRequest;
}
// Conservatively measured from submission, before the host's 24-hour settlement retention.
export const CHAT_INTENT_RETRY_WINDOW_MS = 23 * 60 * 60 * 1_000;
export function chatIntentRetryAllowed(createdAt: number, now = Date.now()): boolean {
  return Number.isFinite(createdAt) && now >= createdAt && now - createdAt < CHAT_INTENT_RETRY_WINDOW_MS;
}
export function replayChatRequest(adapter: HostChatAdapter, chatId: string, request: SavedChatRequest, savedIntent = false): Promise<unknown> {
  switch (request.kind) {
    case "send": return adapter.send(chatId, { ...request.input, savedIntent });
    case "cancel": return adapter.cancel(chatId, { ...request.input, savedIntent });
    case "respondApproval": return adapter.respondApproval(chatId, { ...request.input, savedIntent });
    case "answerQuestion": return adapter.answerQuestion(chatId, { ...request.input, savedIntent });
    case "submitInput": return adapter.submitInput(chatId, { ...request.input, savedIntent });
    case "fork": {
      if (!adapter.fork) throw new Error("Forking is unavailable on this computer.");
      return adapter.fork(chatId, { ...request.input, savedIntent });
    }
  }
}
