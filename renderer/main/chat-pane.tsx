// The active chat: transcript (ScrollArea) + composer. Generation runs inline
// against a concrete chatId in the active workspace, streams tokens via
// startGeneration, and surfaces tool-approval prompts when the workspace is in
// "ask" mode.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, ScrollArea, Text } from "../components/ui";
import { SlidersHorizontal, SquarePen, TerminalSquare } from "lucide-react";
import { MessageList } from "../components/message-list";
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

export function ChatPane({ chatId }: { chatId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const providers = useProviders();
  const chat = useChat(chatId);
  const { active, activeId } = useActiveWorkspace();
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
  const [toolStatus, setToolStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const generationRef = React.useRef<GenerationHandle | null>(null);
  const mountedRef = React.useRef(true);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);

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
    setToolStatus(null);
    setError(null);
    setApprovals([]);
  }, [chatId]);

  const messages = chat.data?.messages ?? [];
  const isGenerating = streamingText !== null;

  const runGeneration = React.useCallback(
    (history: Chat["messages"]) => {
      setError(null);
      setStreamingText("");
      setToolStatus(null);
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
              setToolStatus(null);
              setStreamingText((prev) => (prev ?? "") + delta);
            }
          },
          onTool: (phase, toolName) => {
            if (!mountedRef.current) return;
            setToolStatus(phase === "call" ? `Using ${toolName}…` : phase === "error" ? `${toolName} failed` : null);
          },
          onApproval: (prompt) => {
            if (mountedRef.current) setApprovals((prev) => [...prev, prompt]);
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
              setToolStatus(null);
              setApprovals([]);
            }
          },
          onError: (message) => {
            generationRef.current = null;
            if (mountedRef.current) {
              setStreamingText(null);
              setToolStatus(null);
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
    (approvalId: string, decision: "allow" | "deny") => {
      void chatsApi.approve(approvalId, decision);
      setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
      if (decision === "allow") setToolStatus("Working…");
    },
    [],
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

  const pending = approvals[0];

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
      autoScrollDeps={[messages.length, streamingText, toolStatus, approvals.length]}
      showScrollToBottomButton
      footer={
        <>
          {pending ? (
            <div className="mx-auto w-full max-w-3xl px-3 pb-2 sm:px-5" role="alert" aria-live="assertive">
              <div className="rounded-card bg-popover p-3 shadow-[var(--shadow-composer)] outline outline-1 outline-field/80">
                <Text variant="small-strong" as="p">
                  Approval needed
                </Text>
                <Text variant="small" color="secondary" as="p" className="mt-0.5 break-words">
                  {pending.summary}
                </Text>
                <div className="mt-2.5 flex justify-end gap-2">
                  <Button variant="transparent" size="small" onClick={() => decideApproval(pending.approvalId, "deny")}>
                    Deny
                  </Button>
                  <Button variant="accent" size="small" onClick={() => decideApproval(pending.approvalId, "allow")}>
                    Allow
                  </Button>
                </div>
              </div>
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
        <MessageList messages={messages} streamingText={streamingText} toolStatus={toolStatus} error={error} />
      )}

    </ScrollArea>
  );
}
