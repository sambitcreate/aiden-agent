// Persistent chat shell: workspace switcher + history sidebar + active chat.
// Selection is route-driven (chatId param); the unified sidebar can open chats
// across registered workspaces while WorkspaceProvider tracks execution context.

import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { SplitView, Text, toast } from "../components/ui";
import { ChatSidebar } from "../components/chat-sidebar";
import { chatsApi, designerApi, onNotification } from "../lib/ipc";
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
import type { DesignProjectSnapshotV1 } from "../shared/design-projects";
import { DesignProjectSidebar } from "../components/design-project-sidebar";
import {
  agentReturnTarget,
  designProjectIdFromPath,
  LAST_AGENT_ROUTE_STORAGE_KEY,
  LAST_DESIGN_PROJECT_STORAGE_KEY,
  parseRememberedDesignProject,
  SHELL_MODE_STORAGE_KEY,
  shellModeForPath,
  type AgentReturnTarget,
  type ShellMode,
} from "../lib/shell-mode";
import { ChatPane } from "./chat-pane";

interface DesignProjectChangeContextValue {
  project?: DesignProjectSnapshotV1;
  onProjectChange: (project: DesignProjectSnapshotV1) => void;
  onProjectUnavailable: (projectId: string) => void;
}

const DesignProjectChangeContext = React.createContext<DesignProjectChangeContextValue>({
  onProjectChange: () => undefined,
  onProjectUnavailable: () => undefined,
});

export function ChatLayout() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { chatId?: string };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  const environmentPanel = useEnvironmentPanel();
  const [titleReveal, setTitleReveal] = React.useState<ChatTitleRevealEvent | null>(null);
  const [designProjectUpdate, setDesignProjectUpdate] = React.useState<DesignProjectSnapshotV1>();
  const [designProjectOverride, setDesignProjectOverride] =
    React.useState<DesignProjectSnapshotV1>();
  const [mode, setMode] = React.useState<ShellMode>(() =>
    shellModeForPath(pathname, localStorage.getItem(SHELL_MODE_STORAGE_KEY)),
  );
  const lastAgentTargetRef = React.useRef<AgentReturnTarget>(
    agentReturnTarget(localStorage.getItem(LAST_AGENT_ROUTE_STORAGE_KEY)),
  );
  const lastDesignProjectRef = React.useRef<string | undefined>(
    parseRememberedDesignProject(localStorage.getItem(LAST_DESIGN_PROJECT_STORAGE_KEY)),
  );
  const handleDesignProjectUnavailable = React.useCallback((projectId: string) => {
    if (lastDesignProjectRef.current === projectId) {
      lastDesignProjectRef.current = undefined;
      localStorage.removeItem(LAST_DESIGN_PROJECT_STORAGE_KEY);
    }
    setDesignProjectUpdate((current) => (current?.id === projectId ? undefined : current));
    setDesignProjectOverride((current) => (current?.id === projectId ? undefined : current));
  }, []);
  const handleSidebarProjectChange = React.useCallback((project: DesignProjectSnapshotV1) => {
    setDesignProjectUpdate(project);
    setDesignProjectOverride(project);
  }, []);

  React.useEffect(() => {
    const routeMode = shellModeForPath(pathname, localStorage.getItem(SHELL_MODE_STORAGE_KEY));
    if (pathname !== "/profile") {
      setMode(routeMode);
      localStorage.setItem(SHELL_MODE_STORAGE_KEY, routeMode);
    }
    if (routeMode === "design") {
      const projectId = designProjectIdFromPath(pathname);
      if (projectId) {
        lastDesignProjectRef.current = projectId;
        localStorage.setItem(LAST_DESIGN_PROJECT_STORAGE_KEY, projectId);
      }
      return;
    }
    if (pathname !== "/profile") {
      const target = agentReturnTarget(pathname);
      lastAgentTargetRef.current = target;
      localStorage.setItem(LAST_AGENT_ROUTE_STORAGE_KEY, target);
    }
  }, [pathname]);

  const switchMode = React.useCallback(
    (nextMode: ShellMode) => {
      if (nextMode === mode) return;
      const blockedReason = environmentPanel.gitOperationBusy
        ? "Wait for the current Git operation to finish"
        : environmentPanel.editorState.saving
          ? "Wait for the open file to finish saving"
          : environmentPanel.editorState.dirty
            ? "Save or discard the open file's edits first"
            : undefined;
      if (blockedReason) {
        toast.info(blockedReason);
        return;
      }
      setMode(nextMode);
      localStorage.setItem(SHELL_MODE_STORAGE_KEY, nextMode);
      if (nextMode === "design") {
        const projectId = lastDesignProjectRef.current;
        if (projectId) {
          void navigate({
            to: "/design/$chatId",
            params: { chatId: projectId },
            search: {},
          });
        } else {
          void navigate({ to: "/design" });
        }
        return;
      }
      const target = lastAgentTargetRef.current;
      const chatMatch = /^\/chat\/([^/]+)$/u.exec(target);
      const botChatMatch = /^\/bots\/([^/]+)\/chat\/([^/]+)$/u.exec(target);
      const botMatch = /^\/bots\/([^/]+)$/u.exec(target);
      if (chatMatch) {
        void navigate({
          to: "/chat/$chatId",
          params: { chatId: decodeURIComponent(chatMatch[1]) },
        });
      } else if (botChatMatch) {
        void navigate({
          to: "/bots/$botId/chat/$chatId",
          params: {
            botId: decodeURIComponent(botChatMatch[1]),
            chatId: decodeURIComponent(botChatMatch[2]),
          },
        });
      } else if (botMatch) {
        void navigate({
          to: "/bots/$botId",
          params: { botId: decodeURIComponent(botMatch[1]) },
        });
      } else if (target === "/scheduled") {
        void navigate({ to: "/scheduled" });
      } else if (target === "/bots") {
        void navigate({ to: "/bots" });
      } else {
        void navigate({ to: "/" });
      }
    },
    [
      environmentPanel.editorState.dirty,
      environmentPanel.editorState.saving,
      environmentPanel.gitOperationBusy,
      mode,
      navigate,
    ],
  );

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
        mode === "design" ? (
          <DesignProjectSidebar
            activeProjectId={designProjectIdFromPath(pathname)}
            projectUpdate={designProjectUpdate}
            mode={mode}
            onModeChange={switchMode}
            onProjectChange={handleSidebarProjectChange}
            onProjectUnavailable={handleDesignProjectUnavailable}
          />
        ) : (
          <ChatSidebar
            activeChatId={params.chatId}
            mode={mode}
            onModeChange={switchMode}
            titleReveal={titleReveal}
          />
        )
      }
      sidebarSize={{ default: 272, min: 236, max: 340 }}
      contentModalOpen={environmentPanel.compactModalOpen}
    >
      <DesignProjectChangeContext.Provider
        value={{
          project: designProjectOverride,
          onProjectChange: setDesignProjectUpdate,
          onProjectUnavailable: handleDesignProjectUnavailable,
        }}
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
      </DesignProjectChangeContext.Provider>
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

export function DesignIndex() {
  return (
    <main className="grid h-full min-h-0 place-items-center bg-well p-8">
      <div className="max-w-lg text-center">
        <Text as="h1" variant="heading1">
          Design
        </Text>
        <Text as="p" color="secondary" className="mt-2">
          Create and refine local Design Projects, then connect a workspace or Git repository when
          you are ready to move into implementation.
        </Text>
        <Text as="p" variant="small" color="tertiary" className="mt-4">
          Choose New Project or open an existing project from the sidebar.
        </Text>
      </div>
    </main>
  );
}

export function DesignProjectRoute({
  projectOrLegacyChatId,
  initialMediaId,
}: {
  projectOrLegacyChatId: string;
  initialMediaId?: string;
}) {
  const navigate = useNavigate();
  const {
    project: projectUpdate,
    onProjectChange,
    onProjectUnavailable,
  } = React.useContext(DesignProjectChangeContext);
  const [project, setProject] = React.useState<DesignProjectSnapshotV1>();
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    if (projectUpdate?.id === projectOrLegacyChatId) setProject(projectUpdate);
  }, [projectOrLegacyChatId, projectUpdate]);

  React.useEffect(() => {
    let cancelled = false;
    setProject(undefined);
    setError(undefined);
    void designerApi
      .openProject(projectOrLegacyChatId)
      .then((opened) => {
        if (cancelled) return;
        if (!opened) {
          onProjectUnavailable(projectOrLegacyChatId);
          toast.error("That Design Project is no longer available.");
          void navigate({ to: "/design", replace: true });
          return;
        }
        setProject(opened);
        onProjectChange(opened);
        if (opened.id !== projectOrLegacyChatId) {
          void navigate({
            to: "/design/$chatId",
            params: { chatId: opened.id },
            search: initialMediaId ? { artifact: initialMediaId } : {},
            replace: true,
          });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Aiden could not open this project.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialMediaId, navigate, onProjectChange, onProjectUnavailable, projectOrLegacyChatId]);

  if (error) {
    return (
      <div className="grid h-full place-items-center p-6">
        <Text color="secondary">{error}</Text>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="grid h-full place-items-center p-6" role="status">
        <Text color="secondary">Opening Design Project…</Text>
      </div>
    );
  }
  return (
    <ChatPane
      chatId={project.chatId}
      presentation="design"
      initialDesignMediaId={initialMediaId}
      designProject={project}
      onDesignProjectChange={onProjectChange}
    />
  );
}
