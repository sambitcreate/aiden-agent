// Persistent chat shell: workspace switcher + history sidebar + active chat.
// Selection is route-driven (chatId param); the visible chat list is scoped to
// the active workspace (shared via WorkspaceProvider).

import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { SplitView } from "../components/ui";
import { ChatSidebar } from "../components/chat-sidebar";
import { chatsApi, onNotification } from "../lib/ipc";
import { queryKeys, useChats } from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import { TerminalDrawer } from "../components/terminal-drawer";
import type { Chat, ChatMetadataUpdated, ChatMeta } from "../lib/types";

export function ChatLayout() {
  const params = useParams({ strict: false }) as { chatId?: string };
  const qc = useQueryClient();

  React.useEffect(() => {
    return onNotification<ChatMetadataUpdated>("chats:metadata-updated", (update) => {
      qc.setQueryData<Chat | null>(queryKeys.chat(update.chatId), (current) =>
        current ? { ...current, title: update.title, updatedAt: update.updatedAt } : current,
      );
      qc.setQueriesData<ChatMeta[]>({ queryKey: queryKeys.chats }, (current) => {
        if (!current) return current;
        return current
          .map((chat) =>
            chat.id === update.chatId
              ? { ...chat, title: update.title, updatedAt: update.updatedAt }
              : chat,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt);
      });
    });
  }, [qc]);

  return (
    <SplitView
      storageKey="aiden-agent"
      sidebar={<ChatSidebar activeChatId={params.chatId} />}
      sidebarSize={{ default: 272, min: 236, max: 340 }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden"><Outlet /></div>
        <TerminalDrawer />
      </div>
    </SplitView>
  );
}

/**
 * Index route: send the user to the most recent chat in the active workspace,
 * or create a fresh one so the composer always operates on a concrete chatId.
 */
export function ChatIndex() {
  const navigate = useNavigate();
  const { activeId, isLoading } = useActiveWorkspace();
  const chats = useChats(activeId);
  const startedRef = React.useRef(false);

  React.useEffect(() => {
    if (isLoading || !activeId || chats.isLoading || startedRef.current) return;
    startedRef.current = true;
    const list = chats.data ?? [];
    if (list.length > 0) {
      void navigate({ to: "/chat/$chatId", params: { chatId: list[0].id }, replace: true });
    } else {
      void chatsApi.create({ workspaceId: activeId }).then((chat) => {
        void chats.refetch();
        void navigate({ to: "/chat/$chatId", params: { chatId: chat.id }, replace: true });
      });
    }
  }, [isLoading, activeId, chats.isLoading, chats.data, navigate, chats]);

  return <div className="h-full" />;
}
