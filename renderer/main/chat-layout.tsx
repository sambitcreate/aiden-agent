// Persistent chat shell: workspace switcher + history sidebar + active chat.
// Selection is route-driven (chatId param); the visible chat list is scoped to
// the active workspace (shared via WorkspaceProvider).

import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { SplitView, Text, toast } from "../components/ui";
import { ChatSidebar } from "../components/chat-sidebar";
import { chatsApi, onNotification } from "../lib/ipc";
import {
  CHAT_TITLE_FADE_OUT_MS,
  CHAT_TITLE_REVEAL_DURATION_MS,
  type ChatTitleRevealEvent,
} from "../lib/chat-title-reveal";
import { queryKeys, useChats } from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import { TerminalDrawer } from "../components/terminal-drawer";
import { EnvironmentWorkbench, useEnvironmentPanel } from "../components/environment-panel";
import type { Chat, ChatMetadataUpdated, ChatMeta } from "../lib/types";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";

export function ChatLayout() {
  const params = useParams({ strict: false }) as { chatId?: string };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  const environmentPanel = useEnvironmentPanel();
  const [titleReveal, setTitleReveal] = React.useState<ChatTitleRevealEvent | null>(null);

  React.useLayoutEffect(() => {
    if (pathname.startsWith("/design") && environmentPanel.open) environmentPanel.close();
  }, [environmentPanel.close, environmentPanel.open, pathname]);

  React.useEffect(() => {
    let clearReveal: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onNotification<ChatMetadataUpdated>("chats:metadata-updated", (update) => {
      const previousTitle =
        qc.getQueryData<Chat | null>(queryKeys.chat(update.chatId))?.title ??
        qc
          .getQueriesData<ChatMeta[]>({ queryKey: queryKeys.chats })
          .flatMap(([, chats]) => chats ?? [])
          .find((chat) => chat.id === update.chatId)?.title ??
        update.title;
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
      const reveal = { chatId: update.chatId, version: update.updatedAt, previousTitle };
      setTitleReveal(reveal);
      clearTimeout(clearReveal);
      clearReveal = setTimeout(
        () => {
          setTitleReveal((current) => (current?.version === reveal.version ? null : current));
        },
        CHAT_TITLE_FADE_OUT_MS + CHAT_TITLE_REVEAL_DURATION_MS + 50,
      );
    });

    return () => {
      unsubscribe();
      clearTimeout(clearReveal);
    };
  }, [qc]);

  return (
    <SplitView
      storageKey="aiden-agent"
      sidebar={
        <ChatSidebar
          activeChatId={pathname.startsWith("/design") ? undefined : params.chatId}
          designChatId={params.chatId}
          titleReveal={titleReveal}
        />
      }
      sidebarSize={{ default: 272, min: 236, max: 340 }}
      contentModalOpen={environmentPanel.compactModalOpen}
    >
      <EnvironmentWorkbench>
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <Outlet />
          </div>
          {pathname === "/profile" ||
          pathname === "/scheduled" ||
          pathname.startsWith("/design") ||
          (pathname.startsWith("/bots") && !params.chatId) ? null : (
            <TerminalDrawer />
          )}
        </div>
      </EnvironmentWorkbench>
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
  const appendReconciliationRequired = useAppendReconciliationRequired();

  React.useEffect(() => {
    if (
      appendReconciliationRequired ||
      isLoading ||
      !activeId ||
      chats.isLoading ||
      startedRef.current
    ) {
      return;
    }
    startedRef.current = true;
    const list = chats.data ?? [];
    if (list.length > 0) {
      void navigate({ to: "/chat/$chatId", params: { chatId: list[0].id }, replace: true });
    } else {
      void chatsApi
        .create({ workspaceId: activeId })
        .then((chat) => {
          void chats.refetch();
          void navigate({ to: "/chat/$chatId", params: { chatId: chat.id }, replace: true });
        })
        .catch((error: unknown) => {
          startedRef.current = false;
          toast.error(error instanceof Error ? error.message : "Aiden could not create a chat.");
        });
    }
  }, [
    appendReconciliationRequired,
    isLoading,
    activeId,
    chats.isLoading,
    chats.data,
    navigate,
    chats,
  ]);

  return appendReconciliationRequired ? (
    <div className="flex h-full items-center justify-center p-6" role="status">
      <Text color="secondary">
        Reload Aiden to reconcile the previous message before continuing.
      </Text>
    </div>
  ) : (
    <div className="h-full" />
  );
}

/**
 * Design is a first-class destination backed by an ordinary eligible chat.
 * Reuse the newest chat in the active workspace, or create one when the
 * workspace has no non-Bot conversation yet.
 */
export function DesignIndex() {
  const navigate = useNavigate();
  const { activeId, isLoading } = useActiveWorkspace();
  const chats = useChats(activeId);
  const startedRef = React.useRef(false);
  const appendReconciliationRequired = useAppendReconciliationRequired();

  React.useEffect(() => {
    if (
      appendReconciliationRequired ||
      isLoading ||
      !activeId ||
      chats.isLoading ||
      startedRef.current
    ) {
      return;
    }
    startedRef.current = true;
    const existing = (chats.data ?? []).find((chat) => !chat.botId);
    if (existing) {
      void navigate({
        to: "/design/$chatId",
        params: { chatId: existing.id },
        search: {},
        replace: true,
      });
      return;
    }
    void chatsApi
      .create({ workspaceId: activeId })
      .then((chat) => {
        void chats.refetch();
        void navigate({
          to: "/design/$chatId",
          params: { chatId: chat.id },
          search: {},
          replace: true,
        });
      })
      .catch((error: unknown) => {
        startedRef.current = false;
        toast.error(error instanceof Error ? error.message : "Aiden could not open Design.");
      });
  }, [appendReconciliationRequired, isLoading, activeId, chats, navigate]);

  return (
    <div className="flex h-full items-center justify-center p-6" role="status">
      <Text color="secondary">
        {appendReconciliationRequired
          ? "Reload Aiden to reconcile the previous message before opening Design."
          : "Opening Design…"}
      </Text>
    </div>
  );
}
