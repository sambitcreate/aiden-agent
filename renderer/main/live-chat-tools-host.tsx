import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "../components/ui";
import { chatsApi, settingsApi, workspacesApi } from "../lib/ipc";
import { liveChatControl } from "../lib/live-chat-control";
import { createLiveChatAccessNotice, createLiveChatToolHandlers } from "../lib/live-chat-tools";
import { LiveChatNoteWatcher, liveChatEnding } from "../lib/live-chat-notes";
import { liveOpenChat } from "../lib/live-open-chat";
import { liveSessionBus } from "../lib/live-session-bus";
import { useNewChatActions } from "../lib/new-chat-actions";
import { queryKeys, useSettings } from "../lib/queries";
import { settingsLocation } from "../lib/settings-section";
import type { AppSettings } from "../lib/types";
import { useChatActivityState } from "../lib/use-chat-activity";
import { useActiveWorkspace } from "../lib/workspace-context";
import { aidenLivePreferences } from "../shared/aiden-live-settings";
import { ASSISTANT_WORKSPACE_ID } from "../shared/assistant";
import { LIVE_CHAT_TOOL_NAMES } from "../shared/live-chat-tools";

/**
 * Gives Aiden Live its chat tools in this window: read, send to and stop the
 * open chat, find and open another, and start a new one. Also turns the
 * activity of chats Live works with into short spoken notes. Mounted once in
 * the app shell; renders nothing.
 */
export function LiveChatToolsHost({
  navigationBlockedReason,
}: {
  navigationBlockedReason: string | null;
}): null {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const newChat = useNewChatActions();
  const settings = useSettings();
  const { activeId } = useActiveWorkspace();
  const preferences = aidenLivePreferences(settings.data);
  const chatAccess = preferences.chatAccess;

  const latest = React.useRef({ navigationBlockedReason, activeId, chatAccess, newChat, navigate });
  latest.current = { navigationBlockedReason, activeId, chatAccess, newChat, navigate };
  const noticeShownRef = React.useRef(preferences.chatAccessNoticeShown);
  noticeShownRef.current = preferences.chatAccessNoticeShown;

  const watcher = React.useMemo(
    () =>
      new LiveChatNoteWatcher({
        note: (text) => void liveSessionBus.note(text),
        ending: async (chatId) => {
          const chat = await chatsApi.get(chatId);
          return chat ? liveChatEnding(chat.messages) : null;
        },
      }),
    [],
  );

  // One-time notice: the first chat tool use shows it and remembers it.
  const used = React.useMemo(
    () =>
      createLiveChatAccessNotice({
        alreadyShown: () => noticeShownRef.current,
        show: (text) =>
          toast.info(text, {
            id: "aiden-live-chat-access",
            duration: 10_000,
            action: {
              label: "Settings",
              onClick: () => void latest.current.navigate(settingsLocation("geminiLive")),
            },
          }),
        remember: () =>
          settingsApi
            .set({ aidenLiveChatAccessNoticeShown: true })
            .then((saved) => queryClient.setQueryData<AppSettings>(queryKeys.settings, saved)),
      }),
    [queryClient],
  );

  React.useEffect(() => {
    if (!chatAccess) return;
    const handlers = createLiveChatToolHandlers({
      enabled: () => latest.current.chatAccess,
      controller: () => liveChatControl.current(),
      waitForController: (predicate, signal) => liveChatControl.waitFor(predicate, signal),
      listChats: async () => {
        const chats = await queryClient.fetchQuery({
          queryKey: queryKeys.chatsIn(undefined),
          queryFn: () => chatsApi.list(),
          staleTime: 5_000,
        });
        return chats
          .filter((chat) => !chat.botId && !chat.owner && chat.workspaceId !== ASSISTANT_WORKSPACE_ID)
          .map((chat) => ({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt }));
      },
      openChat: async (chatId) => {
        if (latest.current.navigationBlockedReason) return false;
        await latest.current.navigate({ to: "/chat/$chatId", params: { chatId } });
        return true;
      },
      listWorkspaces: async () => {
        const workspaces = await queryClient.fetchQuery({
          queryKey: queryKeys.workspaces,
          queryFn: workspacesApi.list,
          staleTime: 5_000,
        });
        return workspaces
          .filter((workspace) => workspace.id !== ASSISTANT_WORKSPACE_ID)
          .map((workspace) => ({ id: workspace.id, name: workspace.name }));
      },
      currentWorkspaceId: () => liveOpenChat.get()?.workspaceId ?? latest.current.activeId ?? null,
      openNewChatIn: async (workspaceId) => {
        if (latest.current.navigationBlockedReason) return false;
        await latest.current.newChat.openNewChatIn(workspaceId);
        return true;
      },
      used,
      watch: (chatId, title) => watcher.watch(chatId, title),
    });
    const unregister = LIVE_CHAT_TOOL_NAMES.map((name) => liveSessionBus.registerTool(name, handlers[name]));
    return () => {
      for (const release of unregister) release();
    };
  }, [chatAccess, queryClient, used, watcher]);

  // Spoken notes: only while a session is on and chat access is allowed.
  const activity = useChatActivityState();
  const [sessionId, setSessionId] = React.useState(() => liveSessionBus.currentSessionId());
  React.useEffect(() => liveSessionBus.onSession(setSessionId), []);
  const watching = Boolean(sessionId) && chatAccess;
  React.useEffect(() => {
    watcher.reset();
    if (!watching) return;
    const syncOpenChat = () => {
      const open = liveOpenChat.get();
      watcher.setOpenChat(open?.chatId ?? null, open?.title ?? "");
    };
    syncOpenChat();
    return liveOpenChat.subscribe(syncOpenChat);
  }, [watcher, watching, sessionId]);
  React.useEffect(() => {
    if (watching) watcher.observe(activity);
  }, [activity, watcher, watching]);

  return null;
}
