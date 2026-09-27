import type { ChatActivitySnapshot } from "../shared/chat-activity";
import { chatRowState, type ChatRowState } from "../shared/chat-row-state";

export interface ChatActivityState {
  revision: number;
  activeChatIds: ReadonlySet<string>;
  approvalChatIds: ReadonlySet<string>;
  inputChatIds: ReadonlySet<string>;
}

export const EMPTY_CHAT_ACTIVITY_STATE: ChatActivityState = {
  revision: 0,
  activeChatIds: new Set(),
  approvalChatIds: new Set(),
  inputChatIds: new Set(),
};

export function applyChatActivitySnapshot(
  current: ChatActivityState,
  snapshot: ChatActivitySnapshot,
): ChatActivityState {
  if (snapshot.revision < current.revision) return current;
  return {
    revision: snapshot.revision,
    activeChatIds: new Set(snapshot.activeChatIds),
    approvalChatIds: new Set(snapshot.approvalChatIds ?? []),
    inputChatIds: new Set(snapshot.inputChatIds ?? []),
  };
}

/**
 * Row state for one chat. `locallyBusy` covers the foreground chat before the
 * main-process activity event arrives.
 */
export function chatRowStateFor(
  state: ChatActivityState,
  chatId: string,
  locallyBusy = false,
): ChatRowState {
  return chatRowState({
    active: locallyBusy || state.activeChatIds.has(chatId),
    needsApproval: state.approvalChatIds.has(chatId),
    needsInput: state.inputChatIds.has(chatId),
  });
}
