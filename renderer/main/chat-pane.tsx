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
  workspacesApi,
  type ApprovalPrompt,
  type GenerationHandle,
} from "../lib/ipc";
import { queryKeys, useChat, useGitInfo, useModelInfo, useProviders } from "../lib/queries";
import { useModelSelection } from "../lib/use-model-selection";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useWorkspaceTerminal } from "../components/terminal-drawer";
import type { Attachment, Chat, WorkspacePermission } from "../lib/types";

const TOOL_LABELS: Record<string, string> = {
  edit_file: "Edit file",
  run_command: "Run command",
  write_file: "Write file",
};

function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName.replace(/_/g, " ");
}

export function ChatPane({ chatId }: { chatId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const providers = useProviders();
  const chat = useChat(chatId);
  const { active, activeId, workspaces, select: selectWorkspace } = useActiveWorkspace();
  const terminal = useWorkspaceTerminal();
  const git = useGitInfo(active?.folderPath);
  const { providerId, model, select } = useModelSelection(providers.data);
  const selectedProvider = providers.data?.find((provider) => provider.id === providerId);
  const ready = Boolean(
    selectedProvider &&
      model &&
      selectedProvider.models.includes(model) &&
      (selectedProvider.hasKey || !selectedProvider.needsKey),
  );

  const providerModels = React.useMemo(
    () => providers.data?.find((p) => p.id === providerId)?.models ?? [],
    [providers.data, providerId],
  );
  const modelInfo = useModelInfo(providerId, providerModels);
  const visionSupported = model && modelInfo.data?.[model] ? Boolean(modelInfo.data[model].vision) : undefined;

  const newChat = React.useCallback(async () => {
    const created = await chatsApi.create({ workspaceId: activeId });
    await qc.invalidateQueries({ queryKey: queryKeys.chats });
    void navigate({ to: "/chat/$chatId", params: { chatId: created.id } });
  }, [qc, navigate, activeId]);

  const [streamingText, setStreamingText] = React.useState<string | null>(null);
  const [toolActivity, setToolActivity] = React.useState<ToolActivity | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<string | null>(null);
  const generationRef = React.useRef<GenerationHandle | null>(null);
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
      generationRef.current?.cancel();
      generationRef.current = null;
    };
  }, [chatId]);

  // Reset transient state when switching chats.
  React.useEffect(() => {
    setStreamingText(null);
    setToolActivity(null);
    setError(null);
    setApprovals([]);
    setDecidingApprovalId(null);
  }, [chatId]);

  const messages = chat.data?.messages ?? [];
  const isGenerating = streamingText !== null;
  const isNewChat = !chat.isLoading && messages.length === 0 && !isGenerating;

  const runGeneration = React.useCallback(
    (history: Chat["messages"]) => {
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
          messages: history.map((m) => ({ role: m.role, content: m.content, attachments: m.attachments })),
        },
        {
          onDelta: (delta) => {
            if (mountedRef.current) {
              setToolActivity(null);
              setStreamingText((prev) => (prev ?? "") + delta);
            }
          },
          onTool: (phase, toolName) => {
            if (!mountedRef.current) return;
            const label = toolLabel(toolName);
            if (phase === "call") setToolActivity({ state: "running", label: `${label}…` });
            else if (phase === "blocked") setToolActivity({ state: "blocked", label: `${label} denied` });
            else if (phase === "error") setToolActivity({ state: "failed", label: `${label} failed` });
            else setToolActivity({ state: "finished", label: `${label} finished` });
          },
          onApproval: (prompt) => {
            if (mountedRef.current) {
              setToolActivity(null);
              setApprovals((prev) => [...prev, prompt]);
            }
          },
          onDone: async (full) => {
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
          onError: (message) => {
            generationRef.current = null;
            if (mountedRef.current) {
              setStreamingText(null);
              setToolActivity(null);
              setApprovals([]);
              setError(message);
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
      const updated = await chatsApi.appendMessage(
        chatId,
        { role: "user", content: text, attachments: attachments.length ? attachments : undefined },
        { providerId, model, autoTitle: true },
      );
      qc.setQueryData(queryKeys.chat(chatId), updated);
      void qc.invalidateQueries({ queryKey: queryKeys.chats });
      runGeneration(updated.messages);
    },
    [chatId, providerId, model, qc, runGeneration],
  );

  const handleStop = React.useCallback(() => {
    generationRef.current?.cancel();
  }, []);

  const decideApproval = React.useCallback(
    async (prompt: ApprovalPrompt, decision: "allow" | "deny") => {
      if (decidingApprovalId) return;
      const decisionChatId = chatId;
      setDecidingApprovalId(prompt.approvalId);
      try {
        await chatsApi.approve(prompt.approvalId, decision);
        if (chatIdRef.current !== decisionChatId) return;
        setApprovals((prev) => prev.filter((approval) => approval.approvalId !== prompt.approvalId));
        setToolActivity(
          decision === "allow"
            ? { state: "running", label: `${toolLabel(prompt.toolName)}…` }
            : { state: "blocked", label: `${toolLabel(prompt.toolName)} denied` },
        );
      } catch (approvalError) {
        if (chatIdRef.current !== decisionChatId) return;
        toast.error(approvalError instanceof Error ? approvalError.message : "Couldn't send that approval decision.");
      } finally {
        if (chatIdRef.current === decisionChatId) setDecidingApprovalId(null);
      }
    },
    [chatId, decidingApprovalId],
  );

  const openFolder = React.useCallback(() => {
    if (active?.folderPath) void workspacesApi.openFolder(active.folderPath);
  }, [active?.folderPath]);

  const changePermission = React.useCallback(
    async (permission: WorkspacePermission) => {
      if (!active) return;
      await workspacesApi.update(active.id, { permission });
      await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
    [active, qc],
  );

  const moveNewChatToWorkspace = React.useCallback(
    async (workspaceId: string) => {
      if (!isNewChat) throw new Error("Only a new chat can change workspaces.");
      if (workspaceId === activeId) return;
      const updated = await chatsApi.moveEmptyToWorkspace(chatId, workspaceId);
      qc.setQueryData(queryKeys.chat(chatId), updated);
      selectWorkspace(workspaceId);
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
    },
    [activeId, chatId, isNewChat, qc, selectWorkspace],
  );

  const createScratchWorkspace = React.useCallback(async () => {
    if (!isNewChat) throw new Error("Start a new chat before choosing a scratch folder.");
    const workspace = await workspacesApi.createScratch();
    await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    await moveNewChatToWorkspace(workspace.id);
  }, [isNewChat, moveNewChatToWorkspace, qc]);

  const pending = approvals[0];

  React.useEffect(() => {
    if (!pending) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
            aria-label="Settings"
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
              <p className="sr-only" role="status">Approval needed for {toolLabel(pending.toolName)}</p>
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
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={isGenerating}
            inputRef={composerRef}
            workspace={active}
            gitBranch={git.data?.isRepo ? git.data.branch : undefined}
            onOpenFolder={openFolder}
            onChangePermission={changePermission}
            workspacePickerEnabled={isNewChat}
            workspaces={workspaces}
            onSelectWorkspace={moveNewChatToWorkspace}
            onCreateScratchWorkspace={createScratchWorkspace}
            visionSupported={visionSupported}
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
        <div className="flex min-h-full items-center justify-center" aria-label="Loading conversation">
          <Text variant="small" color="secondary">Loading…</Text>
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
        <MessageList messages={messages} streamingText={streamingText} toolActivity={toolActivity} error={error} />
      )}

    </ScrollArea>
  );
}
