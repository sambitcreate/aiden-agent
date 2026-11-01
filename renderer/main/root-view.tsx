import {
  createChatDraft,
  discardChatDraft,
  findReusableChatDraft,
  requestChatDraftComposerFocus,
  setChatDraftGitMode,
  type ChatDraftGitMode,
} from "../lib/chat-draft";
import { Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { historyNavigationAvailability } from "../lib/history-navigation";
import { PairingRequestSheet } from "../components/remote-pairing-request-sheet";
import { useQueryClient } from "@tanstack/react-query";
import { appControlsApi } from "../lib/ipc";
import * as React from "react";
import { appApi, chatsApi, localRunsApi, onNotification, settingsApi, workspacesApi } from "../lib/ipc";
import { mirrorNewChatModelToHost, subscribeHostNewChatModel } from "../lib/use-model-selection";
import { useTheme } from "../lib/use-theme";
import { useActiveWorkspace, WorkspaceProvider } from "../lib/workspace-context";
import { WorkspaceTerminalProvider, useWorkspaceTerminal } from "../components/terminal-drawer";
import { EnvironmentPanelProvider, useEnvironmentPanel } from "../components/environment-panel";
import { toast } from "../components/ui";
import { RoutedBotPanelProvider, useBotPanelActions } from "./bots/bot-panel-context";
import { environmentToggleTarget, isBotsPath } from "../lib/bot-routes";
import { AssistantDock } from "../components/assistant/assistant-dock";
import { queryKeys } from "../lib/queries";
import { subscribeGitQuerySync } from "../lib/git-query-sync";
import { subscribeWorkspaceFilesSync } from "../lib/workspace-files-sync";
import {
  consumeRendererLifecycleUnloadApproval,
  rendererLifecycleGuarded,
} from "../lib/lifecycle-guard";
import { CommandSystemProvider, useCommandHandler, useCommandSystem } from "../lib/command-system";
import { NewChatActionsProvider, type NewChatActions } from "../lib/new-chat-actions";
import { chatIdFromPath, draftWorkspaceMenu, requestDraftWorkspaceMenu } from "../lib/draft-workspace-menu";
import { AppCommandPalette } from "../components/command-palette";
import { KeyboardRegions } from "../components/keyboard-regions";
import { KeyboardShortcutsDialog } from "../components/keyboard-shortcuts-dialog";
import { WorkspaceSettingsDialog } from "../components/workspace-settings-dialog";
import { OnboardingFlow } from "../components/onboarding-flow";
import { BotConnectionSetupHost } from "./bots/bot-connection-setup-host";
import { workspaceCommandVisibility } from "../lib/command-system-core";
import { useAppCapabilities } from "../lib/app-capabilities";
import {
  captureDetachedLifecycleChat,
  clearInactiveDetachedLifecycleChat,
  type DetachedLifecycleChatReconciliation,
  pendingDetachedLifecycleChats,
  preferLatestTerminalChat,
  reconcileChatReadUntilAuthoritative,
  releaseSettledDetachedLifecycleStreams,
  subscribeChatReadReconciliations,
  subscribeChatSettlements,
  subscribeDetachedTerminalChats,
} from "../lib/chat-terminal-sync";
import { parseChatActivitySnapshot } from "../shared/chat-activity";
import { isChatCacheDeleted } from "../lib/chat-deletion-cache";
import type { Chat } from "../lib/types";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";
import { useBotNotificationsSync } from "../lib/bot-notifications-sync";
import { subscribeLateReturnedGuidance } from "../lib/composer-draft-store";
import { onAssistantAutomationComposerRequested } from "../lib/assistant-dock";

export function RootView() {
  useTheme();
  return (
    <WorkspaceProvider>
      <WorkspaceTerminalProvider>
        <EnvironmentPanelProvider>
          <RoutedBotPanelProvider>
            <CommandSystemProvider>
              <RootContent />
            </CommandSystemProvider>
          </RoutedBotPanelProvider>
        </EnvironmentPanelProvider>
      </WorkspaceTerminalProvider>
    </WorkspaceProvider>
  );
}

function RootContent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const environmentPanel = useEnvironmentPanel();
  const botPanel = useBotPanelActions();
  const terminal = useWorkspaceTerminal();
  const capabilities = useAppCapabilities();
  const { activeId, select: selectWorkspace } = useActiveWorkspace();
  const { palette } = useCommandSystem();
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
      const outcome = await reconcileChatReadUntilAuthoritative({
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
      if (outcome === "failed" && !isChatCacheDeleted(chatId)) {
        // The read kept failing, so stop polling and drop the provisional
        // transcript. An open pane reloads it and shows its "couldn't be
        // loaded / Try again" state; a later visit reads it afresh.
        await queryClient.resetQueries({ queryKey: chatKey, exact: true }).catch(() => undefined);
      }
    },
    [queryClient],
  );
  const reconcileDetachedLifecycleChat = React.useCallback(
    (
      owner:
        | { chatId: string; workspaceId: string }
        | DetachedLifecycleChatReconciliation,
    ) => {
      const captured = "streamIds" in owner ? owner : captureDetachedLifecycleChat(owner);
      return (async () => {
        try {
          await reconcileChatCacheAfterIdle(owner.chatId);
          const snapshot = parseChatActivitySnapshot(await chatsApi.activitySnapshot());
          if (!snapshot || !captured) return;
          clearInactiveDetachedLifecycleChat(captured, new Set(snapshot.activeChatIds));
        } catch {
          // Failure is not proof of settlement. Retained activity events retry it.
        }
      })();
    },
    [reconcileChatCacheAfterIdle],
  );

  useCommandHandler(
    "terminal.toggle",
    terminal.toggle,
    workspaceCommands.terminal && (terminal.canOpen || terminal.open),
  );
  useCommandHandler(
    "environment.toggle",
    () => {
      // In a Bot chat the shortcut is the Bot panel's; the workspace panel stays as it is.
      const target = environmentToggleTarget(pathname);
      if (target === "bot-panel") {
        botPanel.toggle();
        return;
      }
      if (target === "none") return;
      if (environmentPanel.gitOperationBusy) {
        toast.info("Wait for the current Git operation to finish before changing panels.");
        return;
      }
      environmentPanel.toggleTools();
    },
    workspaceCommands.environment,
  );
  useCommandHandler(
    "quick-view.toggle",
    () => {
      // Quick View is suppressed on Bots pages; toggling it there would change hidden state.
      if (isBotsPath(pathname)) return;
      if (environmentPanel.gitOperationBusy) {
        toast.info("Wait for the current Git operation to finish before changing panels.");
        return;
      }
      environmentPanel.toggleQuickView();
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
  const openStudio = React.useCallback(
    (to: "/design" | "/images") => {
      if (navigationBlockedReason) {
        toast.info(navigationBlockedReason);
        return;
      }
      void navigate({ to });
    },
    [navigate, navigationBlockedReason],
  );
  useCommandHandler("design.open", () => openStudio("/design"), capabilities.designStudio);
  useCommandHandler("images.open", () => openStudio("/images"), capabilities.createImages);
  const goTo = React.useCallback(
    (to: "/bots" | "/scheduled" | "/profile") => {
      if (navigationBlockedReason) {
        toast.info(navigationBlockedReason);
        return;
      }
      void navigate({ to });
    },
    [navigate, navigationBlockedReason],
  );
  useCommandHandler("bots.open", () => goTo("/bots"), capabilities.bots);
  useCommandHandler("scheduled.open", () => goTo("/scheduled"));
  useCommandHandler("profile.open", () => goTo("/profile"));
  // ⌘[ and ⌘] walk the same in-app history as the title bar's arrows.
  const router = useRouter();
  const historyEntryIndex = useRouterState({
    select: (state) => (state.location.state as { __TSR_index?: number }).__TSR_index,
  });
  const { canGoBack, canGoForward } = historyNavigationAvailability(
    historyEntryIndex,
    router.history.length,
  );
  const traverseHistory = (go: () => void) => {
    if (navigationBlockedReason) {
      toast.info(navigationBlockedReason);
      return;
    }
    go();
  };
  useCommandHandler("navigate.back", () => traverseHistory(() => router.history.back()), canGoBack);
  useCommandHandler(
    "navigate.forward",
    () => traverseHistory(() => router.history.forward()),
    canGoForward,
  );
  // Every new-chat entry point lands here: an empty draft already open in the
  // workspace is reused and focused; otherwise a fresh draft opens there.
  const openNewChatIn = React.useCallback(
    async (
      workspaceId: string,
      initialText?: string,
      options: { gitMode?: ChatDraftGitMode } = {},
    ): Promise<string | undefined> => {
      if (appendReconciliationRequired) {
        toast.error("Reload Aiden before creating another chat.");
        return undefined;
      }
      if (navigationBlockedReason) {
        toast.info(navigationBlockedReason);
        return undefined;
      }
      const reusable = initialText ? undefined : findReusableChatDraft(workspaceId);
      if (workspaceId !== activeId && environmentPanel.agentBusy) environmentPanel.cancelAgent?.();
      const chat =
        reusable?.chat ??
        createChatDraft(
          workspaceId,
          undefined,
          initialText,
          options.gitMode ? { gitMode: options.gitMode } : {},
        ).chat;
      if (reusable && options.gitMode) setChatDraftGitMode(reusable.chat.id, options.gitMode);
      const previousWorkspaceId = activeId;
      selectWorkspace(workspaceId);
      try {
        await navigate({ to: "/chat/$chatId", params: { chatId: chat.id } });
      } catch (error) {
        if (!reusable) discardChatDraft(chat.id);
        if (previousWorkspaceId && previousWorkspaceId !== workspaceId) {
          selectWorkspace(previousWorkspaceId);
        }
        throw error;
      }
      requestChatDraftComposerFocus(chat.id);
      return chat.id;
    },
    [
      activeId,
      appendReconciliationRequired,
      environmentPanel.agentBusy,
      environmentPanel.cancelAgent,
      navigate,
      navigationBlockedReason,
      selectWorkspace,
    ],
  );
  const openNewChat = React.useCallback(
    async (initialText?: string) => {
      if (!activeId) {
        toast.info("Choose a workspace before starting a chat.");
        return;
      }
      await openNewChatIn(activeId, initialText);
    },
    [activeId, openNewChatIn],
  );
  const openFolderForNewChat = React.useCallback(async () => {
    if (appendReconciliationRequired) {
      toast.error("Reload Aiden before creating another chat.");
      return;
    }
    if (navigationBlockedReason) {
      toast.info(navigationBlockedReason);
      return;
    }
    const workspace = await workspacesApi.createFromFolder();
    if (!workspace) return;
    // The active-workspace provider only accepts ids it has already listed.
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    await openNewChatIn(workspace.id);
  }, [appendReconciliationRequired, navigationBlockedReason, openNewChatIn, queryClient]);
  // Clone repository… from New chat in…: the draft being viewed (or a new one
  // in the active workspace) opens its workspace menu in the Clone view.
  const cloneRepositoryForNewChat = React.useCallback(async () => {
    const viewedChatId = chatIdFromPath(pathname);
    if (viewedChatId && draftWorkspaceMenu(viewedChatId)) {
      requestDraftWorkspaceMenu(viewedChatId, "clone");
      return;
    }
    if (!activeId) {
      toast.info("Choose a workspace before starting a chat.");
      return;
    }
    const chatId = await openNewChatIn(activeId);
    if (chatId) requestDraftWorkspaceMenu(chatId, "clone");
  }, [activeId, openNewChatIn, pathname]);
  const newChatActions = React.useMemo<NewChatActions>(
    () => ({
      openNewChatIn: async (workspaceId, options) => {
        let gitMode: ChatDraftGitMode | undefined = options?.gitMode;
        if (options?.newWorktree) {
          // ⌥↵: only a repository with a commit can start a new worktree.
          // A local status read; nothing is created until the first send.
          const git = await queryClient
            .fetchQuery({
              queryKey: queryKeys.git(workspaceId),
              queryFn: () => workspacesApi.gitInfo(workspaceId),
              staleTime: 5_000,
            })
            .catch(() => undefined);
          if (git?.isRepo && !git.unborn) gitMode = "worktree";
        }
        await openNewChatIn(workspaceId, options?.initialText || undefined, gitMode ? { gitMode } : {});
      },
      openFolderForNewChat,
      cloneRepositoryForNewChat,
    }),
    [cloneRepositoryForNewChat, openFolderForNewChat, openNewChatIn, queryClient],
  );
  // ⌘⇧O: a draft on screen moves to the chosen folder; anywhere else a new
  // draft opens there.
  useCommandHandler(
    "workspace.openFolder",
    async () => {
      const draftMenu = draftWorkspaceMenu(chatIdFromPath(pathname));
      if (draftMenu) await draftMenu.openFolder();
      else await openFolderForNewChat();
    },
    !appendReconciliationRequired,
  );
  const newChatAvailable = Boolean(activeId) && !appendReconciliationRequired;
  useCommandHandler("chat.new", () => openNewChat(), newChatAvailable);
  useCommandHandler("chat.newIn", () => palette.openMode("newChatIn"), newChatAvailable);
  React.useEffect(
    () =>
      onAssistantAutomationComposerRequested((draft) => {
        void openNewChat(draft);
      }),
    [openNewChat],
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

  React.useEffect(() => subscribeGitQuerySync(queryClient, onNotification), [queryClient]);
  React.useEffect(() => subscribeHostNewChatModel(onNotification), []);
  React.useEffect(() => {
    void mirrorNewChatModelToHost(settingsApi).catch(() => undefined);
  }, []);
  React.useEffect(() => subscribeWorkspaceFilesSync(queryClient, onNotification), [queryClient]);

  React.useEffect(() => {
    return onNotification("chats:changed", () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats }),
        queryClient.invalidateQueries({ queryKey: ["bot-chats"] }),
      ]);
    });
  }, [queryClient]);

  React.useEffect(() => {
    return onNotification("chats:follow-through-changed", (payload: unknown) => {
      const update = payload && typeof payload === "object" ? (payload as { chatId?: unknown; transcript?: unknown }) : {};
      const chatId = typeof update.chatId === "string" && update.chatId ? update.chatId : undefined;
      void queryClient.invalidateQueries({ queryKey: ["chat-follow-through", ...(chatId ? [chatId] : [])] });
      // A follow-up notice was saved without a turn to stream it: re-read the transcript.
      if (chatId && update.transcript === true) void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    });
  }, [queryClient]);

  React.useEffect(() => {
    return onNotification("chats:pull-requests-changed", (payload: unknown) => {
      const chatId =
        payload && typeof payload === "object" && "chatId" in payload
          ? (payload as { chatId?: unknown }).chatId
          : undefined;
      const scoped = typeof chatId === "string" && chatId;
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["chat-pull-requests", ...(scoped ? [chatId] : [])],
        }),
        queryClient.invalidateQueries({
          queryKey: ["chat-current-pull-request", ...(scoped ? [chatId] : [])],
        }),
        queryClient.invalidateQueries({
          queryKey: ["chat-pull-request-pending", ...(scoped ? [chatId] : [])],
        }),
        queryClient.invalidateQueries({ queryKey: ["chat-pull-requests-sidebar"] }),
      ]);
    });
  }, [queryClient]);

  useBotNotificationsSync(queryClient);

  React.useEffect(
    () =>
      subscribeDetachedTerminalChats(
        onNotification,
        (chat) => {
          if (isChatCacheDeleted(chat.id)) return;
          return (async () => {
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

  React.useEffect(() => subscribeLateReturnedGuidance(onNotification), []);

  React.useEffect(
    () => subscribeChatReadReconciliations((owner) => reconcileChatCacheAfterIdle(owner.chatId)),
    [reconcileChatCacheAfterIdle],
  );

  React.useEffect(
    () =>
      subscribeChatSettlements(onNotification, (settlement) => {
        void reconcileDetachedLifecycleChat(settlement);
        // Main settles each stream on its own. One that ended while the chat
        // stays busy (a phone's turn right after it) is released now instead
        // of draining until the whole chat goes idle.
        void releaseSettledDetachedLifecycleStreams(settlement, {
          settled: (streamIds) => localRunsApi.settled(streamIds),
          refreshChat: async (chatId) => {
            const chatKey = queryKeys.chat(chatId);
            if (isChatCacheDeleted(chatId)) return;
            await queryClient.cancelQueries({ queryKey: chatKey, exact: true });
            if (isChatCacheDeleted(chatId)) return;
            await queryClient.fetchQuery({ queryKey: chatKey, queryFn: () => chatsApi.get(chatId), staleTime: 0 });
            await queryClient.refetchQueries({ queryKey: queryKeys.chats, type: "all" });
          },
        }).catch(() => {
          // Not proof of settlement; the chat-level idle path still releases it.
        });
      }),
    [queryClient, reconcileDetachedLifecycleChat],
  );

  React.useEffect(() => {
    let disposed = false;
    const reconcileInactiveOwners = (payload: unknown) => {
      const snapshot = parseChatActivitySnapshot(payload);
      if (!snapshot) return;
      const activeChatIds = new Set(snapshot.activeChatIds);
      for (const owner of pendingDetachedLifecycleChats()) {
        if (!activeChatIds.has(owner.chatId)) void reconcileDetachedLifecycleChat(owner);
      }
    };
    // Subscribe before the bootstrap snapshot so no transition falls in between.
    const unsubscribe = onNotification("chats:activity-changed", reconcileInactiveOwners);
    void chatsApi
      .activitySnapshot()
      .then((payload) => {
        if (!disposed) reconcileInactiveOwners(payload);
      })
      .catch(() => {
        // Future activity or settlement events retry recovery.
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [reconcileDetachedLifecycleChat]);

  React.useEffect(() => appControlsApi.onChanged(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
      queryClient.invalidateQueries({ queryKey: queryKeys.webSearch }),
      // The Web pages row reads whether Web Search is on from its own snapshot.
      queryClient.invalidateQueries({ queryKey: queryKeys.webFetch }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces }),
      queryClient.invalidateQueries({ queryKey: queryKeys.skills }),
      queryClient.invalidateQueries({ queryKey: ["skillCatalog"] }),
    ]);
  }), [queryClient]);

  React.useEffect(() => {
    // ~/.aiden/config.json was edited outside the app. Only the lists sourced
    // from the portable file are stale; workspaces and UI settings are stored
    // machine-locally and cannot change behind our back.
    return onNotification("app:config-externally-changed", () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpPresets }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mcpLaunchApprovals }),
        queryClient.invalidateQueries({ queryKey: queryKeys.skills }),
        queryClient.invalidateQueries({ queryKey: ["skillCatalog"] }),
      ]);
    });
  }, [queryClient]);

  React.useEffect(() => {
    return onNotification<{ path: string; requestId?: string }>("app:navigate", (payload) => {
      const acknowledge = (status: "opened" | "blocked") => { if (payload.requestId) void appControlsApi.acknowledgeNavigation(payload.requestId, status); };
      if (!payload?.path) return;
      if (document.querySelector("[data-onboarding-active='true']")) {
        toast.info("Finish onboarding before opening another part of Aiden.");
        acknowledge("blocked");
        return;
      }
      if (navigationBlockedReason) {
        toast.info(navigationBlockedReason);
        acknowledge("blocked");
        return;
      }
      void navigate({ to: payload.path }).then(() => acknowledge("opened"), () => acknowledge("blocked"));
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
    <NewChatActionsProvider value={newChatActions}>
      <div data-app-focus-root tabIndex={-1} className="relative h-full outline-none">
        <Outlet />
        <OnboardingFlow
          onOpenBotChat={(botId) => void navigate({ to: "/bots/$botId/chat", params: { botId } })}
        />
        <AssistantDock rightInset={environmentPanel.dockRightInset} />
        <AppCommandPalette navigationBlockedReason={navigationBlockedReason} />
        <KeyboardRegions />
        <KeyboardShortcutsDialog />
        <WorkspaceSettingsDialog />
        <PairingRequestSheet />
        {capabilities.bots ? <BotConnectionSetupHost /> : null}
      </div>
    </NewChatActionsProvider>
  );
}
