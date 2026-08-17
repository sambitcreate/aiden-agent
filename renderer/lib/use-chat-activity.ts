import * as React from "react";
import { chatsApi, onNotification } from "./ipc";
import { applyChatActivitySnapshot, EMPTY_CHAT_ACTIVITY_STATE } from "./chat-activity";
import { parseChatActivitySnapshot } from "../shared/chat-activity";

/** Event-driven activity state: no polling and no animation clock. */
export function useActiveChatIds(): ReadonlySet<string> {
  const [state, setState] = React.useState(EMPTY_CHAT_ACTIVITY_STATE);

  React.useEffect(() => {
    let disposed = false;
    const unsubscribe = onNotification("chats:activity-changed", (payload) => {
      const snapshot = parseChatActivitySnapshot(payload);
      if (snapshot) setState((current) => applyChatActivitySnapshot(current, snapshot));
    });

    void chatsApi
      .activitySnapshot()
      .then((payload) => {
        if (disposed) return;
        const snapshot = parseChatActivitySnapshot(payload);
        if (snapshot) setState((current) => applyChatActivitySnapshot(current, snapshot));
      })
      .catch(() => {
        // Future events still provide authoritative changes. The local active
        // chat state covers immediate foreground feedback if this read fails.
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return state.activeChatIds;
}
