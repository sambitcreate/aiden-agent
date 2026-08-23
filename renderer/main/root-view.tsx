import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { appApi, chatsApi, onNotification } from "../lib/ipc";
import { useTheme } from "../lib/use-theme";
import { useActiveWorkspace, WorkspaceProvider } from "../lib/workspace-context";
import { WorkspaceTerminalProvider, useWorkspaceTerminal } from "../components/terminal-drawer";
import { EnvironmentPanelProvider, useEnvironmentPanel } from "../components/environment-panel";
import { toast } from "../components/ui";
import { AssistantDock } from "../components/assistant/assistant-dock";
import { queryKeys } from "../lib/queries";
import {
  consumeRendererLifecycleUnloadApproval,
  rendererLifecycleGuarded,
} from "../lib/lifecycle-guard";
import { CommandSystemProvider, useCommandHandler } from "../lib/command-system";
import { AppCommandPalette } from "../components/command-palette";
import { OnboardingFlow } from "../components/onboarding-flow";
import { workspaceCommandVisibility } from "../lib/command-system-core";
import {
  preferLatestTerminalChat,
  reconcileChatReadUntilAuthoritative,
  subscribeChatReadReconciliations,
  subscribeChatSettlements,
  subscribeDetachedTerminalChats,
} from "../lib/chat-terminal-sync";
import { isChatCacheDeleted } from "../lib/chat-deletion-cache";
import type { Chat } from "../lib/types";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";

export function RootView() {
  useTheme();
  return (
    <WorkspaceProvider>
      <WorkspaceTerminalProvider>
        <EnvironmentPanelProvider>
          <EnvironmentCommandSystemProvider>
            <RootContent />
          </EnvironmentCommandSystemProvider>
        </EnvironmentPanelProvider>
      </WorkspaceTerminalProvider>
    </WorkspaceProvider>
  );
}

function EnvironmentCommandSystemProvider({ children }: React.PropsWithChildren) {
  const { compactModalOpen } = useEnvironmentPanel();
  return (
    <CommandSystemProvider applicationModal={compactModalOpen}>{children}</CommandSystemProvider>
  );
}

function RootContent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const environmentPanel = useEnvironmentPanel();
  const terminal = useWorkspaceTerminal();
  const { activeId } = useActiveWorkspace();
  const appendReconciliationRequired = useAppendReconciliationRequired();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const workspaceCommands = workspaceCommandVisibility(pathname);
  const navigationBlockedReason = environmentPanel.gitOperationBusy
    ? "Wait for the current Git operation to finish before leaving the chat."
    : environmentPanel.editorState.saving
      ? "Wait for the open file to finish saving before leaving the chat."
      : environmentPanel.editorState.dirty
        ? "Save or discard the open file's edits before leaving the chat."
        : null;
  React.useEffect(() => {
    if (!appendReconciliationRequired) return;
    toast.error("Message save status is unknown. Reload Aiden before creating or sending again.", {
      id: "append-reconciliation-required",
      duration: Infinity,
    });
  }, [appendReconciliationRequired]);
  const reconcileChatCacheAfterIdle = React.useCallback(
    async (chatId: string) => {
      const chatKey = queryKeys.chat(chatId);
      await reconcileChatReadUntilAuthoritative({
        isDeleted: () => isChatCacheDeleted(chatId),
        waitUntilIdle: () => chatsApi.waitUntilIdle(chatId),
        refreshChat: async () => {
          await queryClient.cancelQueries({ queryKey: chatKey, exact: true });
          if (isChatCacheDeleted(chatId)) return;
          // Force the exact transcript read even if navigation made its query
          // inactive while the old renderer was draining. A later revisit must
          // never observe the provisional cache entry.
          await queryClient.fetchQuery({
            queryKey: chatKey,
            queryFn: () => chatsApi.get(chatId),
            staleTime: 0,
          });
        },
        refreshChatList: async () => {
          await queryClient.refetchQueries({
            queryKey: queryKeys.chats,
            type: "all",
          });
        },
      });
    },
    [queryClient],
  );

  useCommandHandler(
    "terminal.toggle",
    terminal.toggle,
    workspaceCommands.terminal && (terminal.canOpen || terminal.open),
  );
  useCommandHandler(
    "environment.toggle",
    () => {
      if (environmentPanel.gitOperationBusy) {
        toast.info("Wait for the current Git operation to finish before changing panels.");
        return;
      }
      environmentPanel.toggle("overview");
    },
    workspaceCommands.environment,
  );
  useCommandHandler("settings.open", () => {
    if (navigationBlockedReason) {
      toast.info(navigationBlockedReason);
      return;
    }
    void navigate({ to: "/settings" });
  });
  useCommandHandler(
    "chat.new",
    async () => {
      if (!activeId) return;
      if (navigationBlockedReason) {
        toast.info(navigationBlockedReason);
        return;
      }
      const chat = await chatsApi.create({ workspaceId: activeId });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      await navigate({ to: "/chat/$chatId", params: { chatId: chat.id } });
    },
    Boolean(activeId) && !appendReconciliationRequired,
  );
  React.useEffect(() => {
    void appApi.setCloseGuard({
      dirty: environmentPanel.editorState.dirty,
      gitBusy: environmentPanel.gitOperationBusy,
      path: environmentPanel.editorState.path ?? undefined,
      saving: environmentPanel.editorState.saving,
    });
  }, [
    environmentPanel.editorState.dirty,
    environmentPanel.editorState.path,
    environmentPanel.editorState.saving,
    environmentPanel.gitOperationBusy,
  ]);

  React.useEffect(
    () => () => {
      void appApi.setCloseGuard({ dirty: false, gitBusy: false, saving: false });
    },
    [],
  );

  React.useEffect(() => {
    const preventUnprotectedUnload = (event: BeforeUnloadEvent) => {
      if (consumeRendererLifecycleUnloadApproval()) return;
      if (!rendererLifecycleGuarded()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnprotectedUnload);
    return () => window.removeEventListener("beforeunload", preventUnprotectedUnload);
  }, []);

  React.useEffect(() => {
    return onNotification("schedule:updated", () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks }),
        queryClient.invalidateQueries({ queryKey: ["scheduledRuns"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats }),
      ]);
    });
  }, [queryClient]);

  React.useEffect(() => {
    return onNotification("workspaces:changed", () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats }),
      ]);
    });
  }, [queryClient]);

  React.useEffect(() => {
    return onNotification("chats:changed", () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats }),
        queryClient.invalidateQueries({ queryKey: ["bot-chats"] }),
      ]);
    });
  }, [queryClient]);

  React.useEffect(() => {
    return onNotification("bots:changed", () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.bots }),
        queryClient.invalidateQueries({ queryKey: ["bot"] }),
        queryClient.invalidateQueries({ queryKey: ["bot-chats"] }),
        queryClient.invalidateQueries({ queryKey: ["bot-telegram-binding"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.botTelegramTargets }),
      ]);
    });
  }, [queryClient]);

  React.useEffect(
    () =>
      subscribeDetachedTerminalChats(
        onNotification,
        (chat) => {
          if (isChatCacheDeleted(chat.id)) return;
          void (async () => {
            if (isChatCacheDeleted(chat.id)) return;
            const chatKey = queryKeys.chat(chat.id);
            // A rapid A → B → A revisit can have a stale read in flight when the
            // detached terminal payload arrives. Cancel it before installing the
            // durable main-process result so the old read cannot win afterward.
            await queryClient.cancelQueries({ queryKey: chatKey, exact: true });
            if (isChatCacheDeleted(chat.id)) return;
            queryClient.setQueryData<Chat | null>(chatKey, (current) =>
              isChatCacheDeleted(chat.id) ? current : preferLatestTerminalChat(current, chat),
            );
            await queryClient.invalidateQueries({ queryKey: queryKeys.chats });
          })();
        },
        (owner) => reconcileChatCacheAfterIdle(owner.chatId),
      ),
    [queryClient, reconcileChatCacheAfterIdle],
  );

  React.useEffect(
    () => subscribeChatReadReconciliations((owner) => reconcileChatCacheAfterIdle(owner.chatId)),
    [reconcileChatCacheAfterIdle],
  );

  React.useEffect(
    () =>
      subscribeChatSettlements(onNotification, (settlement) => {
        if (isChatCacheDeleted(settlement.chatId)) return;
        void reconcileChatCacheAfterIdle(settlement.chatId);
      }),
    [reconcileChatCacheAfterIdle],
  );

  React.useEffect(() => {
    // ~/.aiden/config.json was edited outside the app. Only the lists sourced
    // from the portable file are stale; workspaces and UI settings are stored
    // machine-locally and cannot change behind our back.
    return onNotification("app:config-externally-changed", () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers }),
        queryClient.invalidateQueries({ queryKey: queryKeys.skills }),
        queryClient.invalidateQueries({ queryKey: ["skillCatalog"] }),
      ]);
    });
  }, [queryClient]);

  React.useEffect(() => {
    return onNotification<{ path: string }>("app:navigate", (payload) => {
      if (!payload?.path) return;
      if (document.querySelector("[data-onboarding-active='true']")) {
        toast.info("Finish onboarding before opening another part of Aiden.");
        return;
      }
      if (navigationBlockedReason) {
        toast.info(navigationBlockedReason);
        return;
      }
      void navigate({ to: payload.path });
    });
  }, [navigate, navigationBlockedReason]);

  React.useEffect(() => {
    const syncFocus = () =>
      document.documentElement.classList.toggle("window-blurred", !document.hasFocus());
    syncFocus();
    window.addEventListener("focus", syncFocus);
    window.addEventListener("blur", syncFocus);
    return () => {
      window.removeEventListener("focus", syncFocus);
      window.removeEventListener("blur", syncFocus);
    };
  }, []);

  return (
    <div data-app-focus-root tabIndex={-1} className="relative h-full outline-none">
      <Outlet />
      <OnboardingFlow />
      <AssistantDock interactionBlocked={environmentPanel.compactModalOpen} />
      <AppCommandPalette navigationBlockedReason={navigationBlockedReason} />
    </div>
  );
}
