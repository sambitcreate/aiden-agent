import type { ChatActivitySnapshot } from "../shared/chat-activity";

export interface ChatActivityState {
  revision: number;
  activeChatIds: ReadonlySet<string>;
}

export const EMPTY_CHAT_ACTIVITY_STATE: ChatActivityState = {
  revision: 0,
  activeChatIds: new Set(),
};

export function applyChatActivitySnapshot(
  current: ChatActivityState,
  snapshot: ChatActivitySnapshot,
): ChatActivityState {
  if (snapshot.revision < current.revision) return current;
  return {
    revision: snapshot.revision,
    activeChatIds: new Set(snapshot.activeChatIds),
  };
}
