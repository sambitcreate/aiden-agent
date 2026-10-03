import * as React from "react";
import type { HostChatAdapter } from "./host-chat-adapter";
import { ChatSessionControl, type ChatSessionRef, type ChatSessionSnapshot } from "./chat-session-control";

export interface ChatSession {
  control: ChatSessionControl;
  snapshot: ChatSessionSnapshot;
}

/**
 * Binds a pane to one chat on one host. A new chat or host gets a new
 * control; the previous one is detached, so its in-flight work finishes against
 * the host and chat it started on and never updates the newly shown chat.
 */
export function useChatSession(adapter: HostChatAdapter, ref: ChatSessionRef): ChatSession {
  const { hostId, chatId } = ref;
  const control = React.useMemo(() => new ChatSessionControl(adapter, { hostId, chatId }), [adapter, hostId, chatId]);
  React.useEffect(() => control.attach(), [control]);
  const snapshot = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => control.subscribe(listener), [control]),
    () => control.getSnapshot(),
    () => control.getSnapshot(),
  );
  return { control, snapshot };
}
