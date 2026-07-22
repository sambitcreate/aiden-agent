// The active chat: transcript (ScrollArea) + composer. Generation runs inline
// against a concrete chatId in the active workspace, streams tokens via
// startGeneration, and surfaces tool-approval prompts when the workspace is in
// "ask" mode.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, ScrollArea, Text, toast } from "../components/ui";
import { ShieldQuestion, SlidersHorizontal, SquarePen, TerminalSquare } from "lucide-react";
import { MessageList, type ToolActivity } from "../components/message-list";
import { Composer } from "../components/composer";
import { ModelPicker } from "../components/model-picker";
import { OpenInEditorPicker } from "../components/open-in-editor-picker";
import {
  chatsApi,
  onNotification,
  startGeneration,
  gitApi,
  workspacesApi,
  type ApprovalPrompt,
  type GenerationHandle,
} from "../lib/ipc";
import {
  queryKeys,
  refreshCodexProviderState,
  useChat,
  useComputerUseStatus,
  useGitInfo,
  useModelInfo,
  useProviders,
  useSettings,
} from "../lib/queries";
import { useModelSelection } from "../lib/use-model-selection";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useWorkspaceTerminal } from "../components/terminal-drawer";
import { EnvironmentPanelToggle, useEnvironmentPanel } from "../components/environment-panel";
import {
  OPENAI_CODEX_PROVIDER_ID,
  type Attachment,
  type Chat,
  type WorkspacePermission,
} from "../lib/types";
import { computerUseReadinessReady } from "../lib/computer-use-control";

const TOOL_LABELS: Record<string, string> = {
  edit_file: "Edit file",
  run_command: "Run command",
  write_file: "Write file",
  computer_use: "Computer Use",
};

function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName.replace(/_/g, " ");
}

export function ChatPane({ chatId }: { chatId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const providers = useProviders();
  const chat = useChat(chatId);
  const settings = useSettings();
  const computerUseGloballyEnabled = settings.data?.computerUseEnabled === true;
  const computerUseStatus = useComputerUseStatus(computerUseGloballyEnabled);
  const { active, activeId, workspaces, select: selectWorkspace } = useActiveWorkspace();
  const terminal = useWorkspaceTerminal();
  const git = useGitInfo(active?.id);
  const environmentPanel = useEnvironmentPanel();
  const settingsBlockedReason = environmentPanel.gitOperationBusy
    ? "Wait for the current Git operation to finish"
    : environmentPanel.editorState.saving
      ? "Wait for the open file to finish saving"
      : environmentPanel.editorState.dirty
        ? "Save or discard the open file's edits first"
        : undefined;
  const { providerId, model, select } = useModelSelection(providers.data);
  const selectedProvider = providers.data?.find((provider) => provider.id === providerId);
  const modelReady = Boolean(
    selectedProvider &&
    model &&
    selectedProvider.models.includes(model) &&
    (selectedProvider.hasKey || !selectedProvider.needsKey),
  );
  const modelReadinessMessage = React.useMemo(() => {
    if (providers.isLoading) return "Loading chat models…";
    if (!selectedProvider) {
      return providerId === OPENAI_CODEX_PROVIDER_ID
        ? "Sign in with ChatGPT in Settings → Providers to use Codex."
        : "Choose a chat model, or add one in Settings → Providers.";
    }
    if (selectedProvider.needsKey && !selectedProvider.hasKey) {
      if (selectedProvider.id === OPENAI_CODEX_PROVIDER_ID) {
        return "Sign in with ChatGPT in Settings → Providers to use Codex.";
      }
      return `${selectedProvider.label} needs an API key. Add one in Settings → Providers.`;
    }
    if (selectedProvider.models.length === 0) {
      return `${selectedProvider.label} has no chat models. In Settings → Providers, discover models, then save.`;
    }
    if (!model || !selectedProvider.models.includes(model))
      return `Choose a model from ${selectedProvider.label}.`;
    return undefined;
  }, [model, providerId, providers.isLoading, selectedProvider]);
  const chatComputerUseEnabled = chat.data?.computerUseEnabled === true;
  const computerUseReady = computerUseReadinessReady(
    computerUseStatus.data?.ready === true,
    computerUseStatus.isError,
  );
  const computerUseStatusDetail = computerUseStatus.isError
    ? "Computer Use readiness check failed. Open Settings → Computer Use and try again."
    : (computerUseStatus.data?.detail ?? "Checking Computer Use readiness…");
  const computerUseReadinessMessage =
    computerUseGloballyEnabled && chatComputerUseEnabled && !computerUseReady
      ? computerUseStatus.isLoading
        ? "Checking Computer Use readiness…"
        : computerUseStatusDetail
      : undefined;
  const ready = modelReady && !computerUseReadinessMessage;
  const readinessMessage = modelReadinessMessage ?? computerUseReadinessMessage;

  const providerModels = React.useMemo(
    () => providers.data?.find((p) => p.id === providerId)?.models ?? [],
    [providers.data, providerId],
  );
  const modelInfo = useModelInfo(providerId, providerModels, selectedProvider);
  const visionSupported = model ? modelInfo.data?.[model]?.vision : undefined;

  const newChat = React.useCallback(async () => {
    const created = await chatsApi.create({ workspaceId: activeId });
    await qc.invalidateQueries({ queryKey: queryKeys.chats });
    void navigate({ to: "/chat/$chatId", params: { chatId: created.id } });
  }, [qc, navigate, activeId]);

  const [streamingText, setStreamingText] = React.useState<string | null>(null);
  const [isStartingGeneration, setIsStartingGeneration] = React.useState(false);
  const [toolActivity, setToolActivity] = React.useState<ToolActivity | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [computerUseSaving, setComputerUseSaving] = React.useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<string | null>(null);
  const generationRef = React.useRef<GenerationHandle | null>(null);
  const generationIntentRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  const chatIdRef = React.useRef(chatId);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const approvalDenyRef = React.useRef<HTMLButtonElement | null>(null);

  chatIdRef.current = chatId;

  // Global shortcut / menu focuses the composer.
  React.useEffect(() => {
    return onNotification("app:focus-composer", () => composerRef.current?.focus());
  }, []);

  // Cancel any in-flight generation when leaving the chat.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationIntentRef.current += 1;
      generationRef.current?.cancel("lifecycle");
      generationRef.current = null;
    };
  }, [chatId]);

  // Reset transient state when switching chats.
  React.useEffect(() => {
    setStreamingText(null);
    setIsStartingGeneration(false);
    setToolActivity(null);
    setError(null);
    setApprovals([]);
    setDecidingApprovalId(null);
  }, [chatId]);

  const messages = chat.data?.messages ?? [];
  const isGenerating = streamingText !== null;
  const isNewChat = !chat.isLoading && messages.length === 0 && !isGenerating;

  React.useLayoutEffect(() => {
    environmentPanel.setAgentBusy(isGenerating || isStartingGeneration);
    return () => environmentPanel.setAgentBusy(false);
  }, [environmentPanel.setAgentBusy, isGenerating, isStartingGeneration]);

  const runGeneration = React.useCallback(
    (history: Chat["messages"]) => {
      const generationIntent = generationIntentRef.current;
      setError(null);
      setStreamingText("");
      setToolActivity(null);
      setApprovals([]);
      const handle = startGeneration(
        {
          chatId,
          workspaceId: activeId,
          providerId,
          model,
          messages: history.map((m) => ({
            role: m.role,
            content: m.content,
            attachments: m.attachments,
          })),
        },
        {
          onDelta: (delta) => {
            if (mountedRef.current && generationIntentRef.current === generationIntent) {
              setToolActivity(null);
              setStreamingText((prev) => (prev ?? "") + delta);
            }
          },
          onTool: (phase, toolName) => {
            if (!mountedRef.current || generationIntentRef.current !== generationIntent) return;
            const label = toolLabel(toolName);
            if (phase === "call") setToolActivity({ state: "running", label: `${label}…` });
            else if (phase === "blocked")
              setToolActivity({ state: "blocked", label: `${label} denied` });
            else if (phase === "error")
              setToolActivity({ state: "failed", label: `${label} failed` });
            else setToolActivity({ state: "finished", label: `${label} finished` });
          },
          onApproval: (prompt) => {
            if (mountedRef.current && generationIntentRef.current === generationIntent) {
              setToolActivity(null);
              setApprovals((prev) => [...prev, prompt]);
            }
          },
          onDone: async (full) => {
            if (generationIntentRef.current !== generationIntent) return;
            generationRef.current = null;
            if (full.trim()) {
              const updated = await chatsApi.appendMessage(
                chatId,
                { role: "assistant", content: full, model },
                { providerId, model },
              );
              qc.setQueryData(queryKeys.chat(chatId), updated);
              void qc.invalidateQueries({ queryKey: queryKeys.chats });
            }
            if (mountedRef.current) {
              setStreamingText(null);
              setToolActivity(null);
              setApprovals([]);
            }
          },
          onError: (message, partialContent) => {
            if (generationIntentRef.current !== generationIntent) return;
            generationRef.current = null;
            if (providerId === OPENAI_CODEX_PROVIDER_ID) {
              void refreshCodexProviderState(qc);
            }
            const partial = partialContent?.trim();
            if (partial) {
              void chatsApi
                .appendMessage(
                  chatId,
                  { role: "assistant", content: partial, model },
                  { providerId, model },
                )
                .then((updated) => {
                  qc.setQueryData(queryKeys.chat(chatId), updated);
                  void qc.invalidateQueries({ queryKey: queryKeys.chats });
                })
                .catch((error: unknown) => {
                  if (mountedRef.current) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Couldn't save the partial assistant response.",
                    );
                  }
                });
            }
            if (mountedRef.current) {
              setStreamingText(null);
              setToolActivity(null);
              setApprovals([]);
              setError(
                partial ? `Generation stopped after a partial response: ${message}` : message,
              );
            }
          },
        },
      );
      generationRef.current = handle;
    },
    [chatId, activeId, providerId, model, qc],
  );

  const handleSend = React.useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (computerUseSaving) {
        throw new Error("Wait for the Computer Use setting to finish saving before sending.");
      }
      const generationIntent = ++generationIntentRef.current;
      setIsStartingGeneration(true);
      try {
        const updated = await chatsApi.appendMessage(
          chatId,
          {
            role: "user",
            content: text,
            attachments: attachments.length ? attachments : undefined,
          },
          { providerId, model, autoTitle: true },
        );
        qc.setQueryData(queryKeys.chat(chatId), updated);
        void qc.invalidateQueries({ queryKey: queryKeys.chats });
        if (generationIntentRef.current !== generationIntent) return;
        runGeneration(updated.messages);
      } finally {
        setIsStartingGeneration(false);
      }
    },
    [chatId, computerUseSaving, providerId, model, qc, runGeneration],
  );

  const handleStop = React.useCallback(() => {
    generationRef.current?.cancel("user_stop");
  }, []);

  const cancelAgentForContextChange = React.useCallback(() => {
    generationIntentRef.current += 1;
    generationRef.current?.cancel("lifecycle");
    generationRef.current = null;
    setStreamingText(null);
    setIsStartingGeneration(false);
    setToolActivity(null);
    setApprovals([]);
    setDecidingApprovalId(null);
  }, []);

  React.useEffect(() => {
    environmentPanel.setCancelAgentHandler(cancelAgentForContextChange);
    return () => environmentPanel.setCancelAgentHandler(null);
  }, [cancelAgentForContextChange, environmentPanel.setCancelAgentHandler]);

  const decideApproval = React.useCallback(
    async (prompt: ApprovalPrompt, decision: "allow" | "deny") => {
      if (decidingApprovalId) return;
      const decisionChatId = chatId;
      setDecidingApprovalId(prompt.approvalId);
      try {
        await chatsApi.approve(prompt.approvalId, decision);
        if (chatIdRef.current !== decisionChatId) return;
        setApprovals((prev) =>
          prev.filter((approval) => approval.approvalId !== prompt.approvalId),
        );
        setToolActivity(
          decision === "allow"
            ? { state: "running", label: `${toolLabel(prompt.toolName)}…` }
            : { state: "blocked", label: `${toolLabel(prompt.toolName)} denied` },
        );
      } catch (approvalError) {
        if (chatIdRef.current !== decisionChatId) return;
        toast.error(
          approvalError instanceof Error
            ? approvalError.message
            : "Couldn't send that approval decision.",
        );
      } finally {
        if (chatIdRef.current === decisionChatId) setDecidingApprovalId(null);
      }
    },
    [chatId, decidingApprovalId],
  );

  const openFolder = React.useCallback(() => {
    if (active?.folderPath) void workspacesApi.openFolder(active.id);
  }, [active?.folderPath, active?.id]);

  const changePermission = React.useCallback(
    async (permission: WorkspacePermission) => {
      if (!active) return;
      if (environmentPanel.gitOperationBusy)
        throw new Error(
          "Wait for the current Git operation to finish before changing workspace access.",
        );
      if (environmentPanel.editorState.saving)
        throw new Error(
          "Wait for the open file to finish saving before changing workspace access.",
        );
      if (environmentPanel.editorState.dirty)
        throw new Error("Save or discard the open file's edits before changing workspace access.");
      if (environmentPanel.agentBusy) environmentPanel.cancelAgent?.();
      await workspacesApi.update(active.id, { permission });
      await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
    [
      active,
      environmentPanel.agentBusy,
      environmentPanel.cancelAgent,
      environmentPanel.editorState.dirty,
      environmentPanel.editorState.saving,
      environmentPanel.gitOperationBusy,
      qc,
    ],
  );

  const changeComputerUse = React.useCallback(
    async (enabled: boolean) => {
      if (computerUseSaving || isStartingGeneration || streamingText !== null) return;
      setComputerUseSaving(true);
      try {
        const updated = await chatsApi.setComputerUse(chatId, enabled);
        qc.setQueryData(queryKeys.chat(chatId), updated);
      } catch (changeError) {
        toast.error(
          changeError instanceof Error
            ? changeError.message
            : "Couldn't change Computer Use for this chat.",
        );
      } finally {
        setComputerUseSaving(false);
      }
    },
    [chatId, computerUseSaving, isStartingGeneration, qc, streamingText],
  );

  const moveNewChatToWorkspace = React.useCallback(
    async (workspaceId: string) => {
      if (!isNewChat) throw new Error("Only a new chat can change workspaces.");
      if (environmentPanel.gitOperationBusy) {
        throw new Error(
          "Wait for the current Git operation to finish before switching workspaces.",
        );
      }
      if (environmentPanel.editorState.saving) {
        throw new Error("Wait for the open file to finish saving before switching workspaces.");
      }
      if (environmentPanel.editorState.dirty) {
        throw new Error("Save or discard the open file's edits before switching workspaces.");
      }
      if (workspaceId === activeId) return;
      const updated = await chatsApi.moveEmptyToWorkspace(chatId, workspaceId);
      qc.setQueryData(queryKeys.chat(chatId), updated);
      selectWorkspace(workspaceId);
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
    },
    [
      activeId,
      chatId,
      environmentPanel.editorState.dirty,
      environmentPanel.editorState.saving,
      environmentPanel.gitOperationBusy,
      isNewChat,
      qc,
      selectWorkspace,
    ],
  );

  const createScratchWorkspace = React.useCallback(async () => {
    if (!isNewChat) throw new Error("Start a new chat before choosing a scratch folder.");
    if (environmentPanel.editorState.dirty)
      throw new Error("Save or discard the open file's edits before creating a scratch workspace.");
    if (environmentPanel.editorState.saving)
      throw new Error(
        "Wait for the open file to finish saving before creating a scratch workspace.",
      );
    if (environmentPanel.gitOperationBusy)
      throw new Error(
        "Wait for the current Git operation to finish before creating a scratch workspace.",
      );
    const workspace = await workspacesApi.createScratch();
    await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    await moveNewChatToWorkspace(workspace.id);
  }, [
    environmentPanel.editorState.dirty,
    environmentPanel.editorState.saving,
    environmentPanel.gitOperationBusy,
    isNewChat,
    moveNewChatToWorkspace,
    qc,
  ]);

  const createGitWorktree = React.useCallback(
    async (branchName: string) => {
      if (!active) throw new Error("Choose a Git workspace first.");
      if (isGenerating || isStartingGeneration)
        throw new Error("Stop the current response before changing Git workspaces.");
      if (environmentPanel.gitOperationBusy)
        throw new Error(
          "Wait for the current Git operation to finish before changing Git workspaces.",
        );
      if (environmentPanel.editorState.saving)
        throw new Error("Wait for the open file to finish saving before changing Git workspaces.");
      if (environmentPanel.editorState.dirty)
        throw new Error("Save or discard the open file's edits before changing Git workspaces.");
      const workspace = await gitApi.createWorktree(active.id, branchName);
      await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      if (isNewChat) {
        await moveNewChatToWorkspace(workspace.id);
        return;
      }
      const created = await chatsApi.create({ workspaceId: workspace.id });
      selectWorkspace(workspace.id);
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
      void navigate({ to: "/chat/$chatId", params: { chatId: created.id } });
    },
    [
      active,
      environmentPanel.editorState.dirty,
      environmentPanel.editorState.saving,
      environmentPanel.gitOperationBusy,
      isGenerating,
      isNewChat,
      isStartingGeneration,
      moveNewChatToWorkspace,
      navigate,
      qc,
      selectWorkspace,
    ],
  );

  React.useEffect(() => {
    environmentPanel.setCreateWorktreeHandler(createGitWorktree);
    return () => environmentPanel.setCreateWorktreeHandler(null);
  }, [createGitWorktree, environmentPanel.setCreateWorktreeHandler]);

  const pending = approvals[0];

  React.useEffect(() => {
    if (!pending) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => approvalDenyRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) requestAnimationFrame(() => previousFocus.focus());
    };
  }, [pending?.approvalId]);

  return (
    <ScrollArea
      className="h-full min-h-0"
      title={chat.data?.title ?? "New chat"}
      actions={
        <>
          <OpenInEditorPicker workspaceId={active?.id} folderPath={active?.folderPath} />
          <Button iconOnly variant="glass" size="large" onClick={newChat} aria-label="New chat">
            <SquarePen />
          </Button>
          <EnvironmentPanelToggle />
          <Button
            iconOnly
            variant="glass"
            size="large"
            onClick={terminal.toggle}
            disabled={!terminal.canOpen}
            aria-label={terminal.open ? "Hide terminal" : "Show terminal"}
            aria-pressed={terminal.open}
            title="Toggle terminal (⌘J)"
            data-terminal-toggle
          >
            <TerminalSquare />
          </Button>
          <Button
            iconOnly
            variant="glass"
            size="large"
            onClick={() => navigate({ to: "/settings" })}
            disabled={Boolean(settingsBlockedReason)}
            aria-label="Settings"
            title={settingsBlockedReason}
          >
            <SlidersHorizontal />
          </Button>
        </>
      }
      autoScrollToBottom
      autoScrollDeps={[messages.length, streamingText, toolActivity, approvals.length]}
      showScrollToBottomButton
      footer={
        <>
          {pending ? (
            <div className="mx-auto w-full max-w-3xl px-3 pb-2 sm:px-5">
              <p className="sr-only" role="status">
                Approval needed for {toolLabel(pending.toolName)}
              </p>
              <section
                aria-labelledby={`approval-title-${pending.approvalId}`}
                aria-describedby={`approval-summary-${pending.approvalId}`}
                className="rounded-card bg-popover p-3 shadow-popover"
              >
                <div className="flex items-start gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-support-warning/10 text-support-warning">
                    <ShieldQuestion className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Text variant="small-strong" as="p" id={`approval-title-${pending.approvalId}`}>
                      {toolLabel(pending.toolName)} needs approval
                    </Text>
                    <Text variant="small" color="secondary" as="p" className="mt-0.5">
                      Review this one action before Aiden continues.
                    </Text>
                  </div>
                </div>
                <Text
                  variant="small"
                  as="p"
                  id={`approval-summary-${pending.approvalId}`}
                  className="mt-2.5 max-h-24 select-text overflow-y-auto rounded-control bg-well px-3 py-2 font-mono break-words"
                >
                  {pending.summary}
                </Text>
                <div className="mt-2.5 flex justify-end gap-2">
                  <Button
                    ref={approvalDenyRef}
                    variant="transparent"
                    size="small"
                    disabled={decidingApprovalId === pending.approvalId}
                    onClick={() => void decideApproval(pending, "deny")}
                  >
                    Deny
                  </Button>
                  <Button
                    variant="accent"
                    size="small"
                    disabled={decidingApprovalId === pending.approvalId}
                    onClick={() => void decideApproval(pending, "allow")}
                  >
                    {decidingApprovalId === pending.approvalId ? "Sending…" : "Allow once"}
                  </Button>
                </div>
              </section>
            </div>
          ) : null}
          <Composer
            ready={ready}
            readinessMessage={readinessMessage}
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={isGenerating}
            inputRef={composerRef}
            workspace={active}
            gitBranch={git.data?.isRepo ? git.data.branch : undefined}
            gitDetached={git.data?.detached}
            gitUnborn={git.data?.unborn}
            onOpenFolder={openFolder}
            onChangePermission={changePermission}
            workspacePickerEnabled={isNewChat}
            workspaces={workspaces}
            onSelectWorkspace={moveNewChatToWorkspace}
            onCreateScratchWorkspace={createScratchWorkspace}
            onCreateGitWorktree={createGitWorktree}
            onGitOperationBusyChange={environmentPanel.setGitOperationBusy}
            gitOperationBusy={environmentPanel.gitOperationBusy}
            workspaceChangeBlockedReason={settingsBlockedReason}
            gitMutationBlockedReason={environmentPanel.gitMutationBlockedReason ?? undefined}
            gitWorktreeDescription={
              isNewChat
                ? "Creates a separate workspace and moves this empty chat there. This checkout stays unchanged."
                : "Creates a separate workspace and opens a new chat. This conversation stays here."
            }
            visionSupported={visionSupported}
            computerUse={
              computerUseGloballyEnabled
                ? {
                    enabled: chatComputerUseEnabled,
                    ready: computerUseReady,
                    checking: computerUseStatus.isLoading || computerUseStatus.isFetching,
                    saving: computerUseSaving,
                    detail: computerUseStatusDetail,
                  }
                : undefined
            }
            onChangeComputerUse={changeComputerUse}
            modelPicker={
              <ModelPicker
                providers={providers.data ?? []}
                providerId={providerId}
                model={model}
                onChange={select}
                disabled={isGenerating}
              />
            }
          />
        </>
      }
    >
      {chat.isLoading || providers.isLoading ? (
        <div
          className="flex min-h-full items-center justify-center"
          aria-label="Loading conversation"
        >
          <Text variant="small" color="secondary">
            Loading…
          </Text>
        </div>
      ) : messages.length === 0 && streamingText === null ? (
        <div className="flex min-h-full items-center justify-center">
          <EmptyState
            title="What would you like to work on?"
            description={
              (providers.data ?? []).some((p) => p.models.length > 0 && (p.hasKey || !p.needsKey))
                ? undefined
                : "Set up a provider in Settings to start."
            }
          />
        </div>
      ) : (
        <MessageList
          messages={messages}
          streamingText={streamingText}
          toolActivity={toolActivity}
          error={error}
        />
      )}
    </ScrollArea>
  );
}
