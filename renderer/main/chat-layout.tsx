// Persistent chat shell: workspace switcher + history sidebar + active chat.
// Selection is route-driven (chatId param); the visible chat list is scoped to
// the active workspace (shared via WorkspaceProvider).

import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import * as React from "react";
import { SplitView } from "@glaze/core/components";
import { ChatSidebar } from "../components/chat-sidebar";
import { chatsApi } from "../lib/ipc";
import { useChats } from "../lib/queries";
import { WorkspaceProvider, useActiveWorkspace } from "../lib/workspace-context";

export function ChatLayout() {
  const params = useParams({ strict: false }) as { chatId?: string };
  return (
    <WorkspaceProvider>
      <SplitView
        storageKey="aiden-agent"
        sidebar={<ChatSidebar activeChatId={params.chatId} />}
        sidebarSize={{ default: 260, min: 220, max: 340 }}
      >
        <Outlet />
      </SplitView>
    </WorkspaceProvider>
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
