import * as React from "react";
import { chatsApi, onNotification } from "./ipc";
import {
  applyChatActivitySnapshot,
  EMPTY_CHAT_ACTIVITY_STATE,
  type ChatActivityState,
} from "./chat-activity";
import { applyChatReadMarkersSnapshot } from "./chat-read-markers";
import { parseChatActivitySnapshot } from "../shared/chat-activity";
import { parseChatReadMarkersSnapshot, type ChatReadMarkersSnapshot } from "../shared/chat-row-state";

/** Event-driven activity state: no polling and no animation clock. */
export function useChatActivityState(): ChatActivityState {
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

  return state;
}

export function useActiveChatIds(): ReadonlySet<string> {
  return useChatActivityState().activeChatIds;
}

/**
 * Shared read markers. Null until the first snapshot arrives, and unread dots
 * stay hidden while null so a slow read never flashes every chat as unread.
 */
export function useChatReadMarkers(): ChatReadMarkersSnapshot | null {
  const [markers, setMarkers] = React.useState<ChatReadMarkersSnapshot | null>(null);

  React.useEffect(() => {
    let disposed = false;
    const apply = (payload: unknown) => {
      const snapshot = parseChatReadMarkersSnapshot(payload);
      if (snapshot) setMarkers((current) => applyChatReadMarkersSnapshot(current, snapshot));
    };
    const unsubscribe = onNotification("chats:read-markers-changed", apply);
    void chatsApi
      .readMarkers()
      .then((payload) => {
        if (!disposed) apply(payload);
      })
      .catch(() => {
        // Unread dots stay hidden until a change event arrives.
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return markers;
}
