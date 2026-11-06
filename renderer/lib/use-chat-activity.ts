import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "./queries";
import type { ChatMeta } from "./types";
import { chatsApi, onNotification } from "./ipc";
import {
  applyChatActivitySnapshot,
  EMPTY_CHAT_ACTIVITY_STATE,
  type ChatActivityState,
} from "./chat-activity";
import { applyChatReadMarkersSnapshot } from "./chat-read-markers";
import { parseChatActivitySnapshot } from "../shared/chat-activity";
import { parseChatReadMarkersSnapshot, type ChatReadMarkersSnapshot } from "../shared/chat-row-state";
import { parseChatTriageSnapshot, type ChatTriageSnapshot } from "../shared/chat-triage";

function selectChatIds(chats: ChatMeta[]): string[] {
  return chats.map((chat) => chat.id);
}

/** A host-listed chat may have an older UUID that trips the child privacy filter. */
function useLocalChatActivityParser(paneChatId?: string) {
  const { data: ids } = useQuery({
    queryKey: queryKeys.chatsIn(undefined),
    queryFn: () => chatsApi.list(),
    enabled: false, // Observe the sidebar's local index, including its initial load.
    select: selectChatIds,
  });
  return React.useMemo(() => {
    const known = new Set(ids);
    if (paneChatId) known.add(paneChatId);
    return (payload: unknown) => parseChatActivitySnapshot(payload, known);
  }, [ids, paneChatId]);
}

/** Event-driven activity state: no polling and no animation clock. */
export function useChatActivityState(paneChatId?: string): ChatActivityState {
  const parseActivity = useLocalChatActivityParser(paneChatId);
  const [state, setState] = React.useState(EMPTY_CHAT_ACTIVITY_STATE);

  React.useEffect(() => {
    let disposed = false;
    const unsubscribe = onNotification("chats:activity-changed", (payload) => {
      const snapshot = parseActivity(payload);
      if (snapshot) setState((current) => applyChatActivitySnapshot(current, snapshot));
    });

    void chatsApi
      .activitySnapshot()
      .then((payload) => {
        if (disposed) return;
        const snapshot = parseActivity(payload);
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
  }, [parseActivity]);

  return state;
}

export function useActiveChatIds(paneChatId?: string): ReadonlySet<string> {
  return useChatActivityState(paneChatId).activeChatIds;
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

/**
 * Inbox triage (Pin, Done, Snooze) for this Mac's chats. Null until the first
 * snapshot arrives; a late initial read never undoes a newer change event.
 */
export function useChatTriage(): ChatTriageSnapshot | null {
  const [triage, setTriage] = React.useState<ChatTriageSnapshot | null>(null);

  React.useEffect(() => {
    let disposed = false;
    const apply = (payload: unknown) => {
      const snapshot = parseChatTriageSnapshot(payload);
      if (snapshot) setTriage((current) => (current && snapshot.revision < current.revision ? current : snapshot));
    };
    const unsubscribe = onNotification("chats:triage-changed", apply);
    void chatsApi
      .triage()
      .then((payload) => {
        if (!disposed) apply(payload);
      })
      .catch(() => {
        // Rows show untriaged until a change event arrives.
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return triage;
}
