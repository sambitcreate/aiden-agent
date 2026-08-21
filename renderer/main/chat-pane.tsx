// The active chat: transcript (ScrollArea) + composer. Generation runs inline
// against a concrete chatId in the active workspace, streams tokens via
// startGeneration, and surfaces tool-approval prompts when the workspace is in
// "ask" mode.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, ScrollArea, Text, toast } from "../components/ui";
import { ShieldQuestion, TerminalSquare } from "lucide-react";
import { MessageList } from "../components/message-list";
import { Composer } from "../components/composer";
import { ModelPicker } from "../components/model-picker";
import { OpenInEditorPicker } from "../components/open-in-editor-picker";
import { useCommandHandler, useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";
import { ThinkingControl } from "../components/thinking-control";
import { ReasoningVisibilityControl } from "../components/reasoning-visibility-control";
import {
  SubagentWorkspaceWriteApproval,
  subagentWorkspaceWriteOperationLabel,
} from "../components/subagent-workspace-write-approval";
import {
  SubagentMcpMutationApproval,
  subagentMcpMutationAllowLabel,
} from "../components/subagent-mcp-mutation-approval";
import { SubagentShellApproval } from "../components/subagent-shell-approval";
import {
  chatsApi,
  createChatTurnId,
  settingsApi,
  startGeneration,
  gitApi,
  workspacesApi,
  type ApprovalPrompt,
  type GenerationHandle,
} from "../lib/ipc";
import {
  queryKeys,
  logoutBuiltinProvider,
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
import { EventPresence } from "../components/event-presence";
import {
  OPENAI_CODEX_PROVIDER_ID,
  type Attachment,
  type Chat,
  type ChatMeta,
  type Workspace,
  type WorkspacePermission,
} from "../lib/types";
import { computerUseReadinessReady } from "../lib/computer-use-control";
import { resolveAgentActivity, type ToolActivity } from "../lib/agent-activity";
import { STREAMING_REVEAL_FALLBACK_MS } from "../lib/streaming-reveal";
import { latestActiveAgentStep, type GenerationTimeline } from "../shared/generation-timeline";
import { GOOGLE_PROVIDER_ID } from "../shared/google-provider";
import {
  CODEX_THINKING_LEVELS,
  normalizeCodexThinkingLevel,
  type CodexThinkingLevel,
} from "../shared/codex-thinking";
import {
  GOOGLE_THINKING_LEVELS,
  normalizeGoogleThinkingLevel,
  type GoogleThinkingLevel,
} from "../shared/google-thinking";
import {
  ANTHROPIC_THINKING_LEVELS,
  normalizeAnthropicThinkingLevel,
  type AnthropicThinkingLevel,
} from "../shared/anthropic-thinking";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import type { SkillInvocationV1 } from "../shared/slash-commands";
import { mergeSubagentSnapshots } from "../lib/subagent-view-state";
import { visibleSubagentReferences } from "../lib/subagent-feature-gate";
import { persistedChatWorkspaceId } from "../shared/chat-workspace";
import {
  isDetachedLifecycleChatDraining,
  subscribeDetachedLifecycleStreams,
} from "../lib/chat-terminal-sync";
import {
  isSubagentMcpMutationApprovalDetails,
  isSubagentShellApprovalDetails,
  isSubagentWorkspaceWriteApprovalDetails,
} from "../shared/assistant";
import { isAppendReconciliationRequired } from "../shared/chat-message-contract";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";
import { isLocalProviderDeployment } from "../shared/provider-deployment";

const ANTHROPIC_PROVIDER_ID = "anthropic";

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
  const documentAppendReconciliationRequired = useAppendReconciliationRequired();
  const chat = useChat(chatId);
  const settings = useSettings();
  const computerUseGloballyEnabled = settings.data?.computerUseEnabled === true;
  const computerUseStatus = useComputerUseStatus(computerUseGloballyEnabled);
  const { activeId, workspaces, select: selectWorkspace } = useActiveWorkspace();
  const [appendReconciliationRequiredChats, setAppendReconciliationRequiredChats] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  const chatWorkspaceId = chat.data?.workspaceId;
  const effectiveWorkspaceId = chat.data ? persistedChatWorkspaceId(chatWorkspaceId) : undefined;
  const effectiveWorkspace = workspaces.find((workspace) => workspace.id === effectiveWorkspaceId);
  const detachedGenerationDraining = React.useSyncExternalStore(
    subscribeDetachedLifecycleStreams,
    () => isDetachedLifecycleChatDraining(chatId, effectiveWorkspaceId),
    () => false,
  );
  const terminal = useWorkspaceTerminal();
  const git = useGitInfo(effectiveWorkspace?.id);
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
  const chatReadinessMessage = chat.isLoading
    ? "Loading chat…"
    : chat.isError
      ? "This chat could not be loaded. Try again."
      : documentAppendReconciliationRequired || appendReconciliationRequiredChats.has(chatId)
        ? "Message save status is unknown. Reload Aiden before sending another message."
        : detachedGenerationDraining
          ? "Finishing the previous response…"
          : undefined;
  const ready = modelReady && !computerUseReadinessMessage && !chatReadinessMessage;
  const readinessMessage =
    chatReadinessMessage ?? modelReadinessMessage ?? computerUseReadinessMessage;

  const providerModels = React.useMemo(
    () => providers.data?.find((p) => p.id === providerId)?.models ?? [],
    [providers.data, providerId],
  );
  const modelInfo = useModelInfo(providerId, providerModels, selectedProvider);
  const visionSupported = model ? modelInfo.data?.[model]?.vision : undefined;
  const googleThinkingSupported =
    providerId === GOOGLE_PROVIDER_ID &&
    Boolean(model) &&
    modelInfo.data?.[model]?.reasoning === true;
  const thinkingMetadata = model ? selectedProvider?.modelMetadata?.[model] : undefined;
  const googleThinkingLevels = React.useMemo<GoogleThinkingLevel[]>(() => {
    const declared = thinkingMetadata?.thinkingLevels;
    if (!declared?.length) return [...GOOGLE_THINKING_LEVELS];
    const supported = GOOGLE_THINKING_LEVELS.filter((level) => declared.includes(level));
    return supported.includes("off") ? supported : ["off", ...supported];
  }, [thinkingMetadata?.thinkingLevels]);
  const storedGoogleThinkingLevel = model
    ? settings.data?.googleThinkingByModel?.[model]
    : undefined;
  const googleThinkingLevel = normalizeGoogleThinkingLevel(
    googleThinkingLevels,
    storedGoogleThinkingLevel,
  );
  const codexThinkingLevels = React.useMemo<CodexThinkingLevel[]>(() => {
    const declared = thinkingMetadata?.thinkingLevels;
    if (!declared?.length) return [];
    return CODEX_THINKING_LEVELS.filter((level) => declared.includes(level));
  }, [thinkingMetadata?.thinkingLevels]);
  const codexThinkingSupported =
    providerId === OPENAI_CODEX_PROVIDER_ID &&
    Boolean(model) &&
    modelInfo.data?.[model]?.reasoning === true &&
    codexThinkingLevels.length > 0;
  const storedCodexThinkingLevel = model ? settings.data?.codexThinkingByModel?.[model] : undefined;
  const codexThinkingLevel = normalizeCodexThinkingLevel(
    codexThinkingLevels,
    storedCodexThinkingLevel,
  );
  const anthropicThinkingLevels = React.useMemo<AnthropicThinkingLevel[]>(() => {
    const declared = thinkingMetadata?.thinkingLevels;
    if (!declared?.length) return [];
    return ANTHROPIC_THINKING_LEVELS.filter((level) => declared.includes(level));
  }, [thinkingMetadata?.thinkingLevels]);
  const anthropicThinkingSupported =
    providerId === ANTHROPIC_PROVIDER_ID &&
    Boolean(model) &&
    modelInfo.data?.[model]?.reasoning === true &&
    anthropicThinkingLevels.length > 0;
  const storedAnthropicThinkingLevel = model
    ? settings.data?.anthropicThinkingByModel?.[model]
    : undefined;
  const anthropicThinkingLevel = normalizeAnthropicThinkingLevel(
    anthropicThinkingLevels,
    storedAnthropicThinkingLevel,
  );
  const localReasoningVisibilitySupported = Boolean(
    selectedProvider && isLocalProviderDeployment(selectedProvider),
  );
  const showLocalModelReasoning = settings.data?.showLocalModelReasoning !== false;

  React.useEffect(() => {
    if (chat.data && effectiveWorkspaceId && effectiveWorkspaceId !== activeId) {
      selectWorkspace(effectiveWorkspaceId);
    }
  }, [activeId, chat.data, effectiveWorkspaceId, selectWorkspace]);

  React.useEffect(() => {
    if (!chat.data || effectiveWorkspace) return;
    if (terminal.open) terminal.toggle();
    environmentPanel.close();
  }, [chat.data, effectiveWorkspace, environmentPanel.close, terminal.open, terminal.toggle]);

  const [streamingText, setStreamingText] = React.useState<string | null>(null);
  const [streamingReasoning, setStreamingReasoning] = React.useState<string | null>(null);
  const [streamComplete, setStreamComplete] = React.useState(false);
  const [isStartingGeneration, setIsStartingGeneration] = React.useState(false);
  const [isStoppingGeneration, setIsStoppingGeneration] = React.useState(false);
  const [isModelLoading, setIsModelLoading] = React.useState(false);
  const [canStopGeneration, setCanStopGeneration] = React.useState(false);
  const [hasUnpersistedResponse, setHasUnpersistedResponse] = React.useState(false);
  const [generationTimeline, setGenerationTimeline] = React.useState<GenerationTimeline | null>(
    null,
  );
  const [liveSubagents, setLiveSubagents] = React.useState<SubagentRunSnapshot[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [computerUseSaving, setComputerUseSaving] = React.useState(false);
  const [thinkingSaving, setThinkingSaving] = React.useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<string | null>(null);
  const decidingApprovalRef = React.useRef<string | null>(null);
  const generationRef = React.useRef<GenerationHandle | null>(null);
  const generationChatIdRef = React.useRef<string | null>(null);
  const generationIntentRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  const chatIdRef = React.useRef(chatId);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  useCommandHandler("composer.focus", () => composerRef.current?.focus());
  const terminalShortcut = useShortcutLabel("terminal.toggle");
  const terminalShortcutBinding = useShortcutBinding("terminal.toggle");
  const approvalDenyRef = React.useRef<HTMLButtonElement | null>(null);
  const approvalCardRef = React.useRef<HTMLElement | null>(null);
  const pendingDeltaRef = React.useRef("");
  const pendingReasoningDeltaRef = React.useRef("");
  const streamedTextRef = React.useRef("");
  const streamedReasoningRef = React.useRef("");
  const deltaFrameRef = React.useRef<number | null>(null);
  const streamHandoffRef = React.useRef<(() => void) | null>(null);
  const generationTimelineRef = React.useRef<GenerationTimeline | null>(null);

  chatIdRef.current = chatId;

  // Detach only the generation owned by the departing chat. The main process
  // keeps that operation alive and reconciles its durable terminal state.
  React.useEffect(() => {
    const departingChatId = chatId;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationIntentRef.current += 1;
      if (generationChatIdRef.current === departingChatId) {
        generationRef.current?.cancel("lifecycle");
        generationRef.current = null;
        generationChatIdRef.current = null;
      }
      if (deltaFrameRef.current !== null) window.cancelAnimationFrame(deltaFrameRef.current);
      deltaFrameRef.current = null;
      pendingDeltaRef.current = "";
      pendingReasoningDeltaRef.current = "";
      streamedTextRef.current = "";
      streamedReasoningRef.current = "";
      streamHandoffRef.current?.();
      streamHandoffRef.current = null;
    };
  }, [chatId]);

  // Reset transient state when switching chats. This runs as a layout effect so
  // the incoming chatId never paints a frame carrying the outgoing chat's
  // stream, timeline, or approvals.
  React.useLayoutEffect(() => {
    setStreamingText(null);
    setStreamingReasoning(null);
    setStreamComplete(false);
    setIsStartingGeneration(false);
    setIsStoppingGeneration(false);
    setIsModelLoading(false);
    setCanStopGeneration(false);
    setHasUnpersistedResponse(false);
    setGenerationTimeline(null);
    generationTimelineRef.current = null;
    setLiveSubagents([]);
    setError(null);
    setApprovals([]);
    decidingApprovalRef.current = null;
    setDecidingApprovalId(null);
  }, [chatId]);

  const messages = React.useMemo(() => chat.data?.messages ?? [], [chat.data?.messages]);
  const latestAssistantResponse = React.useMemo(
    () =>
      [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.content.trim())?.content,
    [messages],
  );
  const subagentReferences = React.useMemo(
    () => visibleSubagentReferences(messages, environmentPanel.subagentsEnabled),
    [environmentPanel.subagentsEnabled, messages],
  );
  const hasMessages = messages.length > 0;
  const isGenerating = streamingText !== null && !hasUnpersistedResponse;
  const isNewChat = !chat.isLoading && !hasMessages && !isGenerating;

  const renameChat = React.useCallback(
    async (title: string) => {
      await chatsApi.rename(chatId, title);
      qc.setQueryData<Chat | null>(queryKeys.chat(chatId), (current) =>
        current ? { ...current, title } : current,
      );
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
    },
    [chatId, qc],
  );

  const copyChat = React.useCallback(
    async (throughAssistantMessageId?: string) => {
      if (documentAppendReconciliationRequired) {
        throw new Error("Reload Aiden before copying this chat.");
      }
      if (isGenerating || isStartingGeneration || approvals.length > 0) {
        throw new Error("Finish the current response or approval before copying this chat.");
      }
      const sourceChatId = chatId;
      const copied = await chatsApi.copyVisibleHistory(sourceChatId, throughAssistantMessageId);
      const copiedWorkspaceId = persistedChatWorkspaceId(copied.workspaceId);
      qc.setQueryData(queryKeys.chat(copied.id), copied);
      qc.setQueryData<ChatMeta[]>(queryKeys.chatsIn(copiedWorkspaceId), (current) => [
        {
          id: copied.id,
          title: copied.title,
          workspaceId: copiedWorkspaceId,
          providerId: copied.providerId,
          model: copied.model,
          createdAt: copied.createdAt,
          updatedAt: copied.updatedAt,
        },
        ...(current ?? []).filter((entry) => entry.id !== copied.id),
      ]);
      void qc.invalidateQueries({ queryKey: queryKeys.chats }).catch(() => {
        toast.info("The chat was copied, but chat history could not refresh yet.");
      });
      if (!mountedRef.current || chatIdRef.current !== sourceChatId) return;
      selectWorkspace(copiedWorkspaceId);
      try {
        await navigate({ to: "/chat/$chatId", params: { chatId: copied.id } });
        requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
      } catch {
        toast.info("The chat was copied, but Aiden could not open it automatically.");
      }
    },
    [
      approvals.length,
      chatId,
      documentAppendReconciliationRequired,
      isGenerating,
      isStartingGeneration,
      navigate,
      qc,
      selectWorkspace,
    ],
  );

  const exportChat = React.useCallback(async () => {
    const result = await chatsApi.export(chatId);
    return result.status;
  }, [chatId]);

  const logoutProvider = React.useCallback(
    async (providerId: string) => {
      return logoutBuiltinProvider(qc, providerId);
    },
    [qc],
  );

  const authenticatedProviders = React.useMemo(
    () =>
      (providers.data ?? [])
        .filter(
          (provider) =>
            provider.canLogout === true &&
            (provider.isBuiltin === true || provider.id === OPENAI_CODEX_PROVIDER_ID),
        )
        .slice(0, 100)
        .map((provider) => ({
          id: provider.id,
          label: provider.label,
          detail:
            provider.id === OPENAI_CODEX_PROVIDER_ID
              ? "OpenAI Codex OAuth"
              : "Aiden-managed Pi credential",
        })),
    [providers.data],
  );

  React.useLayoutEffect(() => {
    if (!effectiveWorkspaceId) return;
    return () => environmentPanel.releaseSubagents(chatId, effectiveWorkspaceId);
  }, [chatId, effectiveWorkspaceId, environmentPanel.releaseSubagents]);

  React.useLayoutEffect(() => {
    if (!environmentPanel.subagentsEnabled || !effectiveWorkspaceId) return;
    environmentPanel.syncSubagents(chatId, effectiveWorkspaceId, subagentReferences, liveSubagents);
  }, [
    chatId,
    effectiveWorkspaceId,
    environmentPanel.subagentsEnabled,
    environmentPanel.syncSubagents,
    liveSubagents,
    subagentReferences,
  ]);

  React.useLayoutEffect(() => {
    environmentPanel.setAgentBusy(isGenerating || isStartingGeneration);
    return () => environmentPanel.setAgentBusy(false);
  }, [environmentPanel.setAgentBusy, isGenerating, isStartingGeneration]);

  const waitForStreamHandoff = React.useCallback(async (hasContent: boolean) => {
    const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
    if (reduceMotion || !hasContent) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallback);
        if (streamHandoffRef.current === finish) streamHandoffRef.current = null;
        resolve();
      };
      const fallback = window.setTimeout(finish, STREAMING_REVEAL_FALLBACK_MS);
      streamHandoffRef.current = finish;
    });
  }, []);

  const runGeneration = React.useCallback(
    (messageTurnId: string) => {
      const generationIntent = generationIntentRef.current;
      setError(null);
      setIsStoppingGeneration(false);
      setCanStopGeneration(true);
      setIsModelLoading(false);
      setHasUnpersistedResponse(false);
      setStreamingText("");
      setStreamingReasoning(null);
      setStreamComplete(false);
      pendingDeltaRef.current = "";
      pendingReasoningDeltaRef.current = "";
      streamedTextRef.current = "";
      streamedReasoningRef.current = "";
      streamHandoffRef.current?.();
      streamHandoffRef.current = null;
      setGenerationTimeline(null);
      generationTimelineRef.current = null;
      setLiveSubagents([]);
      setApprovals([]);
      const scheduleStreamFlush = () => {
        if (deltaFrameRef.current !== null) return;
        deltaFrameRef.current = window.requestAnimationFrame(() => {
          deltaFrameRef.current = null;
          const pendingDelta = pendingDeltaRef.current;
          const pendingReasoningDelta = pendingReasoningDeltaRef.current;
          pendingDeltaRef.current = "";
          pendingReasoningDeltaRef.current = "";
          if (!mountedRef.current || generationIntentRef.current !== generationIntent) return;
          if (pendingDelta) {
            streamedTextRef.current += pendingDelta;
            setStreamingText(streamedTextRef.current);
          }
          if (pendingReasoningDelta) {
            streamedReasoningRef.current += pendingReasoningDelta;
            setStreamingReasoning(streamedReasoningRef.current);
          }
        });
      };
      const handle = startGeneration(
        {
          chatId,
          workspaceId: effectiveWorkspaceId,
          providerId,
          model,
          thinkingLevel: googleThinkingSupported
            ? googleThinkingLevel
            : codexThinkingSupported
              ? codexThinkingLevel
              : anthropicThinkingSupported
                ? anthropicThinkingLevel
                : undefined,
        },
        {
          onDelta: (delta) => {
            if (mountedRef.current && generationIntentRef.current === generationIntent) {
              setIsModelLoading(false);
              pendingDeltaRef.current += delta;
              scheduleStreamFlush();
            }
          },
          onReset: () => {
            if (!mountedRef.current || generationIntentRef.current !== generationIntent) return;
            if (deltaFrameRef.current !== null) {
              window.cancelAnimationFrame(deltaFrameRef.current);
            }
            deltaFrameRef.current = null;
            pendingDeltaRef.current = "";
            pendingReasoningDeltaRef.current = "";
            streamedTextRef.current = "";
            streamedReasoningRef.current = "";
            setStreamingText("");
            setStreamingReasoning(null);
            setStreamComplete(false);
          },
          onReasoningDelta: (delta) => {
            if (mountedRef.current && generationIntentRef.current === generationIntent) {
              setIsModelLoading(false);
              pendingReasoningDeltaRef.current += delta;
              scheduleStreamFlush();
            }
          },
          onStatus: (phase) => {
            if (!mountedRef.current || generationIntentRef.current !== generationIntent) return;
            if (phase === "model_loading") setIsModelLoading(true);
            else if (phase === "model_ready") setIsModelLoading(false);
          },
          ...(environmentPanel.subagentsEnabled
            ? {
                onSubagents: (snapshot: SubagentRunSnapshot) => {
                  if (
                    !mountedRef.current ||
                    generationIntentRef.current !== generationIntent ||
                    chatIdRef.current !== chatId ||
                    snapshot.chatId !== chatId ||
                    snapshot.workspaceId !== effectiveWorkspaceId
                  ) {
                    return;
                  }
                  setLiveSubagents((current) =>
                    mergeSubagentSnapshots(current, [snapshot], {
                      chatId,
                      workspaceId: effectiveWorkspaceId,
                    }),
                  );
                },
              }
            : {}),
          onTimeline: (timeline) => {
            if (mountedRef.current && generationIntentRef.current === generationIntent) {
              generationTimelineRef.current = timeline;
              setGenerationTimeline(timeline);
            }
          },
          onApproval: (prompt) => {
            if (mountedRef.current && generationIntentRef.current === generationIntent) {
              setApprovals((prev) => [...prev, prompt]);
            }
          },
          onDone: async (full, finalTimeline, updatedChat, finalReasoning) => {
            if (generationIntentRef.current !== generationIntent) return;
            generationRef.current = null;
            generationChatIdRef.current = null;
            setCanStopGeneration(false);
            if (deltaFrameRef.current !== null) window.cancelAnimationFrame(deltaFrameRef.current);
            deltaFrameRef.current = null;
            pendingDeltaRef.current = "";
            pendingReasoningDeltaRef.current = "";
            streamedTextRef.current = full;
            streamedReasoningRef.current = finalReasoning ?? "";
            setStreamingText(full);
            setStreamingReasoning(finalReasoning?.trim() ? finalReasoning : null);
            setStreamComplete(true);
            if (finalTimeline) {
              generationTimelineRef.current = finalTimeline;
              setGenerationTimeline(finalTimeline);
            }
            if (updatedChat) {
              qc.setQueryData(queryKeys.chat(chatId), updatedChat);
              void qc.invalidateQueries({ queryKey: queryKeys.chats });
            }
            await waitForStreamHandoff(Boolean(full.trim()));
            if (generationIntentRef.current !== generationIntent) return;
            if (mountedRef.current) {
              setLiveSubagents([]);
              setStreamingText(null);
              setStreamingReasoning(null);
              streamedTextRef.current = "";
              streamedReasoningRef.current = "";
              setStreamComplete(false);
              setIsStoppingGeneration(false);
              setIsModelLoading(false);
              setGenerationTimeline(null);
              generationTimelineRef.current = null;
              setApprovals([]);
            }
          },
          onError: (message, partialContent, finalTimeline, updatedChat, finalReasoning) => {
            void (async () => {
              if (generationIntentRef.current !== generationIntent) return;
              generationRef.current = null;
              generationChatIdRef.current = null;
              setCanStopGeneration(false);
              if (deltaFrameRef.current !== null) {
                window.cancelAnimationFrame(deltaFrameRef.current);
              }
              deltaFrameRef.current = null;
              const bufferedPartial = streamedTextRef.current + pendingDeltaRef.current;
              const bufferedReasoning =
                streamedReasoningRef.current + pendingReasoningDeltaRef.current;
              pendingDeltaRef.current = "";
              pendingReasoningDeltaRef.current = "";
              const resolvedPartialContent = partialContent ?? bufferedPartial;
              const resolvedReasoning = finalReasoning ?? bufferedReasoning;
              streamedTextRef.current = resolvedPartialContent;
              streamedReasoningRef.current = resolvedReasoning;
              setStreamingReasoning(resolvedReasoning.trim() ? resolvedReasoning : null);
              setStreamComplete(true);
              if (finalTimeline) {
                generationTimelineRef.current = finalTimeline;
                setGenerationTimeline(finalTimeline);
              }
              if (providerId === OPENAI_CODEX_PROVIDER_ID) {
                void refreshCodexProviderState(qc);
              }
              const partial = resolvedPartialContent.trim();
              if (updatedChat) {
                qc.setQueryData(queryKeys.chat(chatId), updatedChat);
                void qc.invalidateQueries({ queryKey: queryKeys.chats });
              }
              if (partial) {
                setStreamingText(resolvedPartialContent);
                setStreamComplete(true);
                await waitForStreamHandoff(true);
                if (generationIntentRef.current !== generationIntent) return;
              }
              if (mountedRef.current) {
                if (updatedChat || !partial) setLiveSubagents([]);
                if (!partial || updatedChat) {
                  setStreamingText(null);
                  setStreamingReasoning(null);
                  streamedTextRef.current = "";
                  streamedReasoningRef.current = "";
                  setStreamComplete(false);
                }
                setHasUnpersistedResponse(Boolean(partial && !updatedChat));
                setIsStoppingGeneration(false);
                setIsModelLoading(false);
                if (!partial || updatedChat) {
                  setGenerationTimeline(null);
                  generationTimelineRef.current = null;
                }
                setApprovals([]);
                const persistedFailure =
                  updatedChat?.messages[updatedChat.messages.length - 1]?.role ===
                    "assistant" &&
                  updatedChat.messages[updatedChat.messages.length - 1]
                    ?.providerFailure;
                setError(
                  persistedFailure
                    ? null
                    : partial
                      ? `Generation stopped after a partial response: ${message}`
                      : message,
                );
              }
            })();
          },
        },
        messageTurnId,
      );
      generationRef.current = handle;
      generationChatIdRef.current = chatId;
      return handle.started;
    },
    [
      chatId,
      codexThinkingLevel,
      codexThinkingSupported,
      effectiveWorkspaceId,
      environmentPanel.subagentsEnabled,
      googleThinkingLevel,
      googleThinkingSupported,
      providerId,
      model,
      qc,
      waitForStreamHandoff,
    ],
  );

  const handleSend = React.useCallback(
    async (text: string, attachments: Attachment[], skillInvocation?: SkillInvocationV1) => {
      if (computerUseSaving) {
        throw new Error("Wait for the Computer Use setting to finish saving before sending.");
      }
      if (detachedGenerationDraining) {
        throw new Error("Wait for the previous response to finish saving before sending again.");
      }
      const generationIntent = ++generationIntentRef.current;
      const messageTurnId = createChatTurnId();
      setIsStoppingGeneration(false);
      setIsStartingGeneration(true);
      try {
        let updated: Chat;
        try {
          updated = await chatsApi.appendMessage(
            chatId,
            {
              role: "user",
              content: text,
              attachments: attachments.length ? attachments : undefined,
            },
            {
              providerId,
              model,
              autoTitle: true,
              turnId: messageTurnId,
              skillInvocation,
            },
          );
        } catch (appendError) {
          if (isAppendReconciliationRequired(appendError)) {
            setAppendReconciliationRequiredChats((current) => new Set(current).add(chatId));
            void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
          }
          throw appendError;
        }
        qc.setQueryData(queryKeys.chat(chatId), updated);
        void qc.invalidateQueries({ queryKey: queryKeys.chats });
        if (generationIntentRef.current !== generationIntent) {
          try {
            await chatsApi.abandonTurn(chatId, messageTurnId);
          } catch (error) {
            if (mountedRef.current) {
              setError(error instanceof Error ? error.message : String(error));
            }
          }
          return;
        }
        const started = await runGeneration(messageTurnId);
        // The user message crossed its durability barrier in appendMessage.
        // Start rejection is surfaced by the stream callback but cannot turn
        // that committed message back into an unsent composer payload.
        if (!started.ok && mountedRef.current) setError(started.error.message);
      } finally {
        if (
          mountedRef.current &&
          chatIdRef.current === chatId &&
          generationIntentRef.current === generationIntent
        ) {
          setIsStartingGeneration(false);
        }
      }
    },
    [chatId, computerUseSaving, detachedGenerationDraining, providerId, model, qc, runGeneration],
  );

  const handleStop = React.useCallback(() => {
    if (!generationRef.current || !canStopGeneration) return;
    setIsStoppingGeneration(true);
    setCanStopGeneration(false);
    generationRef.current.cancel("user_stop");
  }, [canStopGeneration]);

  const cancelAgentForContextChange = React.useCallback(() => {
    generationIntentRef.current += 1;
    generationRef.current?.cancel("lifecycle");
    generationRef.current = null;
    generationChatIdRef.current = null;
    if (deltaFrameRef.current !== null) window.cancelAnimationFrame(deltaFrameRef.current);
    deltaFrameRef.current = null;
    pendingDeltaRef.current = "";
    pendingReasoningDeltaRef.current = "";
    streamedTextRef.current = "";
    streamedReasoningRef.current = "";
    streamHandoffRef.current?.();
    streamHandoffRef.current = null;
    setStreamingText(null);
    setStreamingReasoning(null);
    setStreamComplete(false);
    setIsStartingGeneration(false);
    setIsStoppingGeneration(false);
    setIsModelLoading(false);
    setCanStopGeneration(false);
    setGenerationTimeline(null);
    generationTimelineRef.current = null;
    setLiveSubagents([]);
    setApprovals([]);
    decidingApprovalRef.current = null;
    setDecidingApprovalId(null);
  }, []);

  React.useEffect(() => {
    environmentPanel.setCancelAgentHandler(cancelAgentForContextChange);
    return () => environmentPanel.setCancelAgentHandler(null);
  }, [cancelAgentForContextChange, environmentPanel.setCancelAgentHandler]);

  const decideApproval = React.useCallback(
    async (prompt: ApprovalPrompt, decision: "allow" | "deny") => {
      if (decidingApprovalRef.current) return;
      const decisionChatId = chatId;
      decidingApprovalRef.current = prompt.approvalId;
      setDecidingApprovalId(prompt.approvalId);
      try {
        await chatsApi.approve(prompt.approvalId, decision);
        if (chatIdRef.current !== decisionChatId) return;
        setApprovals((prev) =>
          prev.filter((approval) => approval.approvalId !== prompt.approvalId),
        );
      } catch (approvalError) {
        if (chatIdRef.current !== decisionChatId) return;
        toast.error(
          approvalError instanceof Error
            ? approvalError.message
            : "Couldn't send that approval decision.",
        );
      } finally {
        if (decidingApprovalRef.current === prompt.approvalId) {
          decidingApprovalRef.current = null;
          if (chatIdRef.current === decisionChatId) setDecidingApprovalId(null);
        }
      }
    },
    [chatId],
  );

  const openFolder = React.useCallback(() => {
    if (effectiveWorkspace?.folderPath) void workspacesApi.openFolder(effectiveWorkspace.id);
  }, [effectiveWorkspace?.folderPath, effectiveWorkspace?.id]);

  const changePermission = React.useCallback(
    async (permission: WorkspacePermission) => {
      if (!effectiveWorkspace) return;
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
      await workspacesApi.update(effectiveWorkspace.id, { permission });
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.workspaces }),
        qc.invalidateQueries({
          queryKey: queryKeys.skillCatalog(effectiveWorkspace.id),
        }),
      ]);
    },
    [
      effectiveWorkspace,
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
      if (computerUseSaving || isStartingGeneration || isGenerating) return;
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
    [chatId, computerUseSaving, isGenerating, isStartingGeneration, qc],
  );

  const changeGoogleThinking = React.useCallback(
    async (level: GoogleThinkingLevel) => {
      if (
        !model ||
        !googleThinkingSupported ||
        thinkingSaving ||
        isStartingGeneration ||
        isGenerating
      ) {
        return;
      }
      setThinkingSaving(true);
      try {
        const updated = await settingsApi.setGoogleThinking(model, level);
        qc.setQueryData(queryKeys.settings, updated);
      } catch (changeError) {
        toast.error(
          changeError instanceof Error
            ? changeError.message
            : "Couldn't save the Gemini thinking level.",
        );
      } finally {
        setThinkingSaving(false);
      }
    },
    [googleThinkingSupported, isGenerating, isStartingGeneration, model, qc, thinkingSaving],
  );

  const changeCodexThinking = React.useCallback(
    async (level: CodexThinkingLevel) => {
      if (
        !model ||
        !codexThinkingSupported ||
        thinkingSaving ||
        isStartingGeneration ||
        isGenerating
      ) {
        return;
      }
      setThinkingSaving(true);
      try {
        const updated = await settingsApi.setCodexThinking(model, level);
        qc.setQueryData(queryKeys.settings, updated);
      } catch (changeError) {
        toast.error(
          changeError instanceof Error
            ? changeError.message
            : "Couldn't save the Codex thinking level.",
        );
      } finally {
        setThinkingSaving(false);
      }
    },
    [codexThinkingSupported, isGenerating, isStartingGeneration, model, qc, thinkingSaving],
  );

  const changeAnthropicThinking = React.useCallback(
    async (level: AnthropicThinkingLevel) => {
      if (
        !model ||
        !anthropicThinkingSupported ||
        thinkingSaving ||
        isStartingGeneration ||
        isGenerating
      ) {
        return;
      }
      setThinkingSaving(true);
      try {
        const updated = await settingsApi.setAnthropicThinking(model, level);
        qc.setQueryData(queryKeys.settings, updated);
      } catch (changeError) {
        toast.error(
          changeError instanceof Error
            ? changeError.message
            : "Couldn't save the Claude thinking level.",
        );
      } finally {
        setThinkingSaving(false);
      }
    },
    [anthropicThinkingSupported, isGenerating, isStartingGeneration, model, qc, thinkingSaving],
  );

  const changeLocalReasoningVisibility = React.useCallback(
    async (visible: boolean) => {
      if (
        !localReasoningVisibilitySupported ||
        thinkingSaving ||
        isStartingGeneration ||
        isGenerating
      ) {
        return;
      }
      setThinkingSaving(true);
      try {
        const updated = await settingsApi.set({ showLocalModelReasoning: visible });
        qc.setQueryData(queryKeys.settings, updated);
      } catch (changeError) {
        toast.error(
          changeError instanceof Error
            ? changeError.message
            : "Couldn't save the local reasoning visibility.",
        );
      } finally {
        setThinkingSaving(false);
      }
    },
    [
      isGenerating,
      isStartingGeneration,
      localReasoningVisibilitySupported,
      qc,
      thinkingSaving,
    ],
  );

  const moveNewChatToWorkspace = React.useCallback(
    async (workspaceId: string) => {
      if (documentAppendReconciliationRequired) {
        throw new Error("Reload Aiden before changing this chat's workspace.");
      }
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
      if (workspaceId === effectiveWorkspaceId) return;
      const updated = await chatsApi.moveEmptyToWorkspace(chatId, workspaceId);
      qc.setQueryData(queryKeys.chat(chatId), updated);
      selectWorkspace(workspaceId);
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
    },
    [
      effectiveWorkspaceId,
      chatId,
      documentAppendReconciliationRequired,
      environmentPanel.editorState.dirty,
      environmentPanel.editorState.saving,
      environmentPanel.gitOperationBusy,
      isNewChat,
      qc,
      selectWorkspace,
    ],
  );

  const createScratchWorkspace = React.useCallback(async () => {
    if (documentAppendReconciliationRequired) {
      throw new Error("Reload Aiden before creating a scratch workspace from this chat.");
    }
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
    documentAppendReconciliationRequired,
    environmentPanel.editorState.dirty,
    environmentPanel.editorState.saving,
    environmentPanel.gitOperationBusy,
    isNewChat,
    moveNewChatToWorkspace,
    qc,
  ]);

  const createGitWorktree = React.useCallback(
    async (branchName: string) => {
      const sourceChatId = chatId;
      if (documentAppendReconciliationRequired) {
        throw new Error("Reload Aiden before creating a worktree from this chat.");
      }
      if (!effectiveWorkspace) throw new Error("Choose a Git workspace first.");
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
      const workspace = await gitApi.createWorktree(effectiveWorkspace.id, branchName);
      qc.setQueryData<Workspace[]>(queryKeys.workspaces, (current) => [
        workspace,
        ...(current ?? []).filter((entry) => entry.id !== workspace.id),
      ]);
      void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      if (!mountedRef.current || chatIdRef.current !== sourceChatId) return;
      if (isNewChat) {
        try {
          await moveNewChatToWorkspace(workspace.id);
        } catch (error) {
          toast.info(
            error instanceof Error
              ? `The worktree was created, but this chat could not move to it: ${error.message}`
              : "The worktree was created, but this chat could not move to it.",
          );
        }
        return;
      }
      let created: Chat;
      try {
        created = await chatsApi.create({ workspaceId: workspace.id });
      } catch (error) {
        toast.info(
          error instanceof Error
            ? `The worktree was created, but its chat could not be created: ${error.message}`
            : "The worktree was created, but its chat could not be created.",
        );
        return;
      }
      qc.setQueryData(queryKeys.chat(created.id), created);
      qc.setQueryData<ChatMeta[]>(queryKeys.chatsIn(workspace.id), (current) => [
        {
          id: created.id,
          title: created.title,
          workspaceId: workspace.id,
          providerId: created.providerId,
          model: created.model,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
        ...(current ?? []).filter((entry) => entry.id !== created.id),
      ]);
      if (!mountedRef.current || chatIdRef.current !== sourceChatId) return;
      selectWorkspace(workspace.id);
      void qc.invalidateQueries({ queryKey: queryKeys.chats });
      try {
        await navigate({ to: "/chat/$chatId", params: { chatId: created.id } });
        requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
      } catch {
        selectWorkspace(effectiveWorkspace.id);
        toast.info(
          "The worktree and chat were created, but Aiden could not open them automatically.",
        );
      }
    },
    [
      effectiveWorkspace,
      chatId,
      documentAppendReconciliationRequired,
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
  const pendingDetails = pending?.details as unknown;
  const pendingWorkspaceWriteClaim =
    typeof pendingDetails === "object" &&
    pendingDetails !== null &&
    !Array.isArray(pendingDetails) &&
    (pendingDetails as Record<string, unknown>).kind === "subagent-workspace-write";
  const pendingWorkspaceWrite =
    pending && isSubagentWorkspaceWriteApprovalDetails(pending.details)
      ? pending.details
      : undefined;
  const invalidPendingWorkspaceWrite =
    pendingWorkspaceWriteClaim && pendingWorkspaceWrite === undefined;
  const pendingMcpMutationClaim =
    typeof pendingDetails === "object" &&
    pendingDetails !== null &&
    !Array.isArray(pendingDetails) &&
    (pendingDetails as Record<string, unknown>).kind === "subagent-mcp-mutation";
  const pendingMcpMutation =
    pending && isSubagentMcpMutationApprovalDetails(pending.details) ? pending.details : undefined;
  const invalidPendingMcpMutation = pendingMcpMutationClaim && pendingMcpMutation === undefined;
  const pendingShellClaim =
    typeof pendingDetails === "object" &&
    pendingDetails !== null &&
    !Array.isArray(pendingDetails) &&
    (pendingDetails as Record<string, unknown>).kind === "subagent-shell";
  const pendingShell =
    pending && isSubagentShellApprovalDetails(pending.details) ? pending.details : undefined;
  const invalidPendingShell = pendingShellClaim && pendingShell === undefined;
  const invalidPendingPrivilegedApproval =
    invalidPendingWorkspaceWrite || invalidPendingMcpMutation || invalidPendingShell;
  const activeStep = latestActiveAgentStep(generationTimeline);
  const toolActivity: ToolActivity | null = activeStep
    ? {
        state: "running",
        label: activeStep.label,
        toolName: activeStep.toolName,
      }
    : null;
  const agentActivity = resolveAgentActivity({
    isStarting: isStartingGeneration,
    isStopping: isStoppingGeneration,
    isModelLoading,
    streamingText: canStopGeneration || isStoppingGeneration ? streamingText : null,
    pendingApproval: Boolean(pending),
    toolActivity,
  });
  const visibleAgentActivity =
    streamingReasoning &&
    (agentActivity?.phase === "thinking" || agentActivity?.phase === "loading")
      ? null
      : agentActivity;

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

  React.useLayoutEffect(() => {
    if (pending) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && approvalCardRef.current?.contains(focused)) {
      composerRef.current?.focus({ preventScroll: true });
    }
  }, [pending]);

  return (
    <ScrollArea
      className="h-full min-h-0"
      title={chat.data?.title ?? "New agent"}
      actions={
        <>
          <OpenInEditorPicker
            workspaceId={effectiveWorkspace?.id}
            folderPath={effectiveWorkspace?.folderPath}
          />
          <EnvironmentPanelToggle disabled={!effectiveWorkspace} />
          <Button
            iconOnly
            variant="toolbar"
            size="large"
            onClick={terminal.toggle}
            disabled={!effectiveWorkspace?.folderPath || !terminal.canOpen}
            aria-label={terminal.open ? "Hide terminal" : "Show terminal"}
            aria-keyshortcuts={ariaKeyShortcut(terminalShortcutBinding)}
            aria-pressed={terminal.open}
            title={`Toggle terminal (${terminalShortcut})`}
            data-terminal-toggle
          >
            <TerminalSquare />
          </Button>
        </>
      }
      autoScrollToBottom
      autoScrollDeps={[
        messages.length,
        streamingText,
        streamingReasoning,
        generationTimeline,
        agentActivity?.phase,
        approvals.length,
      ]}
      showScrollToBottomButton
      footer={
        <>
          <EventPresence
            present={Boolean(pending)}
            className="aiden-dock-inset chat-content-column pb-2"
          >
            {pending ? (
              <div>
                <p className="sr-only" role="status">
                  {invalidPendingPrivilegedApproval
                    ? "Invalid privileged approval blocked"
                    : `Approval needed for ${pendingWorkspaceWrite?.childLabel ?? pendingMcpMutation?.childLabel ?? pendingShell?.childLabel ?? toolLabel(pending.toolName)}`}
                </p>
                <section
                  ref={approvalCardRef}
                  aria-labelledby={`approval-title-${pending.approvalId}`}
                  aria-describedby={`approval-summary-${pending.approvalId}`}
                  className="rounded-card bg-popover p-3 shadow-popover"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-support-warning/10 text-support-warning">
                      <ShieldQuestion className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <Text
                        variant="small-strong"
                        as="p"
                        id={`approval-title-${pending.approvalId}`}
                      >
                        {invalidPendingPrivilegedApproval
                          ? "Invalid privileged approval blocked"
                          : pendingWorkspaceWrite
                            ? `${pendingWorkspaceWrite.childLabel} wants to ${subagentWorkspaceWriteOperationLabel(
                                pendingWorkspaceWrite.operation,
                              ).toLocaleLowerCase("en-US")}`
                            : pendingMcpMutation
                              ? `${pendingMcpMutation.childLabel} wants to call ${pendingMcpMutation.serverId}:${pendingMcpMutation.toolName}`
                              : pendingShell
                                ? `${pendingShell.childLabel} wants to run a full-host command`
                                : `${toolLabel(pending.toolName)} needs approval`}
                      </Text>
                      <Text variant="small" color="secondary" as="p" className="mt-0.5">
                        {invalidPendingPrivilegedApproval
                          ? "This malformed privileged action cannot be allowed. Deny it to continue."
                          : pendingWorkspaceWrite
                            ? "Review this one exact file change before Aiden continues."
                            : pendingMcpMutation
                              ? "Review this one exact external mutation before Aiden continues."
                              : pendingShell
                                ? "Review this one exact full-host command before Aiden continues."
                                : "Review this one action before Aiden continues."}
                      </Text>
                    </div>
                  </div>
                  {invalidPendingPrivilegedApproval ? (
                    <Text
                      variant="small"
                      as="p"
                      id={`approval-summary-${pending.approvalId}`}
                      className="mt-2.5 rounded-control bg-well px-3 py-2"
                    >
                      Aiden could not verify the exact target, arguments, or safety profile for this
                      request.
                    </Text>
                  ) : pendingWorkspaceWrite ? (
                    <SubagentWorkspaceWriteApproval
                      details={pendingWorkspaceWrite}
                      descriptionId={`approval-summary-${pending.approvalId}`}
                    />
                  ) : pendingMcpMutation ? (
                    <SubagentMcpMutationApproval
                      details={pendingMcpMutation}
                      descriptionId={`approval-summary-${pending.approvalId}`}
                    />
                  ) : pendingShell ? (
                    <SubagentShellApproval
                      details={pendingShell}
                      descriptionId={`approval-summary-${pending.approvalId}`}
                    />
                  ) : (
                    <Text
                      variant="small"
                      as="p"
                      id={`approval-summary-${pending.approvalId}`}
                      className="mt-2.5 max-h-24 select-text overflow-y-auto rounded-control bg-well px-3 py-2 font-mono break-words"
                    >
                      {pending.summary}
                    </Text>
                  )}
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
                    {invalidPendingPrivilegedApproval ? null : (
                      <Button
                        variant="accent"
                        size="small"
                        disabled={decidingApprovalId === pending.approvalId}
                        onClick={() => void decideApproval(pending, "allow")}
                      >
                        {decidingApprovalId === pending.approvalId
                          ? "Sending…"
                          : pendingMcpMutation
                            ? subagentMcpMutationAllowLabel(pendingMcpMutation)
                            : "Allow once"}
                      </Button>
                    )}
                  </div>
                </section>
              </div>
            ) : null}
          </EventPresence>
          <Composer
            // Keyed so the draft and attachments stay scoped to one chat. The
            // route no longer remounts the pane, and Composer owns that text
            // without a chatId reset of its own.
            key={chatId}
            ready={ready}
            readinessMessage={readinessMessage}
            hasMessages={hasMessages}
            chatId={chatId}
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={isGenerating}
            canStopGeneration={canStopGeneration}
            configurationBusy={thinkingSaving}
            inputRef={composerRef}
            workspace={effectiveWorkspace}
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
            workspaceChangeBlockedReason={
              documentAppendReconciliationRequired
                ? "Reload Aiden before changing this chat's workspace."
                : settingsBlockedReason
            }
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
            currentChatTitle={chat.data?.title}
            latestAssistantResponse={latestAssistantResponse}
            slashNavigationBlockedReason={settingsBlockedReason}
            slashSessionBlockedReason={
              documentAppendReconciliationRequired
                ? "Reload Aiden before copying this chat."
                : undefined
            }
            slashPaletteBlocked={Boolean(pending)}
            slashActionBusy={isGenerating || isStartingGeneration}
            onOpenSettings={(section) =>
              void navigate({
                to: "/settings",
                search: section ? { section } : {},
              })
            }
            onRenameChat={renameChat}
            onOpenReview={() => environmentPanel.openReview("changes")}
            sessionChat={chat.data ?? undefined}
            authenticatedProviders={authenticatedProviders}
            onCloneChat={() => copyChat()}
            onForkChat={(throughAssistantMessageId) => copyChat(throughAssistantMessageId)}
            onExportChat={exportChat}
            onLogoutProvider={logoutProvider}
            thinkingControl={
              googleThinkingSupported ? (
                <ThinkingControl
                  level={googleThinkingLevel}
                  levels={googleThinkingLevels}
                  canDisable={thinkingMetadata?.thinkingCanDisable !== false}
                  disabled={thinkingSaving || isStartingGeneration || isGenerating}
                  onChange={(level) => void changeGoogleThinking(level)}
                />
              ) : codexThinkingSupported ? (
                <ThinkingControl
                  providerLabel="Codex"
                  level={codexThinkingLevel}
                  levels={codexThinkingLevels}
                  disabled={thinkingSaving || isStartingGeneration || isGenerating}
                  onChange={(level) => void changeCodexThinking(level)}
                />
              ) : anthropicThinkingSupported ? (
                <ThinkingControl
                  providerLabel="Claude"
                  level={anthropicThinkingLevel}
                  levels={anthropicThinkingLevels}
                  canDisable={thinkingMetadata?.thinkingCanDisable !== false}
                  disabled={thinkingSaving || isStartingGeneration || isGenerating}
                  onChange={(level) => void changeAnthropicThinking(level)}
                />
              ) : localReasoningVisibilitySupported ? (
                <ReasoningVisibilityControl
                  visible={showLocalModelReasoning}
                  disabled={thinkingSaving || isStartingGeneration || isGenerating}
                  onChange={(visible) => void changeLocalReasoningVisibility(visible)}
                />
              ) : undefined
            }
            modelPicker={
              <ModelPicker
                providers={providers.data ?? []}
                providerId={providerId}
                model={model}
                onChange={select}
                disabled={isGenerating || thinkingSaving}
                settingsBlockedReason={settingsBlockedReason}
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
          streamingReasoning={streamingReasoning}
          streamComplete={streamComplete}
          onStreamHandoffComplete={() => streamHandoffRef.current?.()}
          timeline={generationTimeline}
          liveSubagents={liveSubagents}
          subagentsEnabled={environmentPanel.subagentsEnabled}
          onOpenSubagent={environmentPanel.openSubagent}
          agentActivity={visibleAgentActivity}
          error={error}
        />
      )}
    </ScrollArea>
  );
}
