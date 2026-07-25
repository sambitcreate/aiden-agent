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
import { ThinkingControl } from "../components/thinking-control";
import {
  chatsApi,
  settingsApi,
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
import {
  EnvironmentPanelToggle,
  useEnvironmentPanel,
} from "../components/environment-panel";
import { EventPresence } from "../components/event-presence";
import {
  OPENAI_CODEX_PROVIDER_ID,
  type Attachment,
  type Chat,
  type WorkspacePermission,
} from "../lib/types";
import { computerUseReadinessReady } from "../lib/computer-use-control";
import { resolveAgentActivity, type ToolActivity } from "../lib/agent-activity";
import { STREAMING_REVEAL_FALLBACK_MS } from "../lib/streaming-reveal";
import {
  latestActiveAgentStep,
  type GenerationTimeline,
} from "../shared/generation-timeline";
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
  const chat = useChat(chatId);
  const settings = useSettings();
  const computerUseGloballyEnabled = settings.data?.computerUseEnabled === true;
  const computerUseStatus = useComputerUseStatus(computerUseGloballyEnabled);
  const {
    activeId,
    workspaces,
    select: selectWorkspace,
  } = useActiveWorkspace();
  const chatWorkspaceId = chat.data?.workspaceId;
  const effectiveWorkspace = workspaces.find(
    (workspace) => workspace.id === chatWorkspaceId,
  );
  const effectiveWorkspaceId = chatWorkspaceId;
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
  const selectedProvider = providers.data?.find(
    (provider) => provider.id === providerId,
  );
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
      : undefined;
  const ready =
    modelReady && !computerUseReadinessMessage && !chatReadinessMessage;
  const readinessMessage =
    chatReadinessMessage ??
    modelReadinessMessage ??
    computerUseReadinessMessage;

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
  const thinkingMetadata = model
    ? selectedProvider?.modelMetadata?.[model]
    : undefined;
  const googleThinkingLevels = React.useMemo<GoogleThinkingLevel[]>(() => {
    const declared = thinkingMetadata?.thinkingLevels;
    if (!declared?.length) return [...GOOGLE_THINKING_LEVELS];
    const supported = GOOGLE_THINKING_LEVELS.filter((level) =>
      declared.includes(level),
    );
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
  const storedCodexThinkingLevel = model
    ? settings.data?.codexThinkingByModel?.[model]
    : undefined;
  const codexThinkingLevel = normalizeCodexThinkingLevel(
    codexThinkingLevels,
    storedCodexThinkingLevel,
  );
  const anthropicThinkingLevels =
    React.useMemo<AnthropicThinkingLevel[]>(() => {
      const declared = thinkingMetadata?.thinkingLevels;
      if (!declared?.length) return [];
      return ANTHROPIC_THINKING_LEVELS.filter((level) =>
        declared.includes(level),
      );
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

  React.useEffect(() => {
    if (chat.data && chatWorkspaceId && chatWorkspaceId !== activeId) {
      selectWorkspace(chatWorkspaceId);
    }
  }, [activeId, chat.data, chatWorkspaceId, selectWorkspace]);

  React.useEffect(() => {
    if (!chat.data || effectiveWorkspace) return;
    if (terminal.open) terminal.toggle();
    environmentPanel.close();
  }, [
    chat.data,
    effectiveWorkspace,
    environmentPanel.close,
    terminal.open,
    terminal.toggle,
  ]);

  const [streamingText, setStreamingText] = React.useState<string | null>(null);
  const [streamingReasoning, setStreamingReasoning] = React.useState<
    string | null
  >(null);
  const [streamComplete, setStreamComplete] = React.useState(false);
  const [isStartingGeneration, setIsStartingGeneration] = React.useState(false);
  const [isStoppingGeneration, setIsStoppingGeneration] = React.useState(false);
  const [isModelLoading, setIsModelLoading] = React.useState(false);
  const [canStopGeneration, setCanStopGeneration] = React.useState(false);
  const [hasUnpersistedResponse, setHasUnpersistedResponse] =
    React.useState(false);
  const [generationTimeline, setGenerationTimeline] =
    React.useState<GenerationTimeline | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  const [computerUseSaving, setComputerUseSaving] = React.useState(false);
  const [thinkingSaving, setThinkingSaving] = React.useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<
    string | null
  >(null);
  const generationRef = React.useRef<GenerationHandle | null>(null);
  const generationIntentRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  const chatIdRef = React.useRef(chatId);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
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

  // Global shortcut / menu focuses the composer.
  React.useEffect(() => {
    return onNotification("app:focus-composer", () =>
      composerRef.current?.focus(),
    );
  }, []);

  // Cancel any in-flight generation when leaving the chat.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationIntentRef.current += 1;
      generationRef.current?.cancel("lifecycle");
      generationRef.current = null;
      if (deltaFrameRef.current !== null)
        window.cancelAnimationFrame(deltaFrameRef.current);
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
    setError(null);
    setApprovals([]);
    setDecidingApprovalId(null);
  }, [chatId]);

  const messages = chat.data?.messages ?? [];
  const hasMessages = messages.length > 0;
  const isGenerating = streamingText !== null && !hasUnpersistedResponse;
  const isNewChat = !chat.isLoading && !hasMessages && !isGenerating;

  React.useLayoutEffect(() => {
    environmentPanel.setAgentBusy(isGenerating || isStartingGeneration);
    return () => environmentPanel.setAgentBusy(false);
  }, [environmentPanel.setAgentBusy, isGenerating, isStartingGeneration]);

  const waitForStreamHandoff = React.useCallback(
    async (hasContent: boolean) => {
      const reduceMotion =
        document.documentElement.dataset.reduceMotion === "true";
      if (reduceMotion || !hasContent) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(fallback);
          if (streamHandoffRef.current === finish)
            streamHandoffRef.current = null;
          resolve();
        };
        const fallback = window.setTimeout(
          finish,
          STREAMING_REVEAL_FALLBACK_MS,
        );
        streamHandoffRef.current = finish;
      });
    },
    [],
  );

  const runGeneration = React.useCallback(
    (history: Chat["messages"]) => {
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
      setApprovals([]);
      const scheduleStreamFlush = () => {
        if (deltaFrameRef.current !== null) return;
        deltaFrameRef.current = window.requestAnimationFrame(() => {
          deltaFrameRef.current = null;
          const pendingDelta = pendingDeltaRef.current;
          const pendingReasoningDelta = pendingReasoningDeltaRef.current;
          pendingDeltaRef.current = "";
          pendingReasoningDeltaRef.current = "";
          if (
            !mountedRef.current ||
            generationIntentRef.current !== generationIntent
          )
            return;
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
          messages: history.map((m) => ({
            role: m.role,
            content: m.content,
            attachments: m.attachments,
          })),
        },
        {
          onDelta: (delta) => {
            if (
              mountedRef.current &&
              generationIntentRef.current === generationIntent
            ) {
              setIsModelLoading(false);
              pendingDeltaRef.current += delta;
              scheduleStreamFlush();
            }
          },
          onReasoningDelta: (delta) => {
            if (
              mountedRef.current &&
              generationIntentRef.current === generationIntent
            ) {
              setIsModelLoading(false);
              pendingReasoningDeltaRef.current += delta;
              scheduleStreamFlush();
            }
          },
          onStatus: (phase) => {
            if (
              !mountedRef.current ||
              generationIntentRef.current !== generationIntent
            )
              return;
            if (phase === "model_loading") setIsModelLoading(true);
            else if (phase === "model_ready") setIsModelLoading(false);
          },
          onTimeline: (timeline) => {
            if (
              mountedRef.current &&
              generationIntentRef.current === generationIntent
            ) {
              generationTimelineRef.current = timeline;
              setGenerationTimeline(timeline);
            }
          },
          onApproval: (prompt) => {
            if (
              mountedRef.current &&
              generationIntentRef.current === generationIntent
            ) {
              setApprovals((prev) => [...prev, prompt]);
            }
          },
          onDone: async (full, finalTimeline, updatedChat, finalReasoning) => {
            if (generationIntentRef.current !== generationIntent) return;
            generationRef.current = null;
            setCanStopGeneration(false);
            if (deltaFrameRef.current !== null)
              window.cancelAnimationFrame(deltaFrameRef.current);
            deltaFrameRef.current = null;
            pendingDeltaRef.current = "";
            pendingReasoningDeltaRef.current = "";
            streamedTextRef.current = full;
            streamedReasoningRef.current = finalReasoning ?? "";
            setStreamingText(full);
            setStreamingReasoning(
              finalReasoning?.trim() ? finalReasoning : null,
            );
            setStreamComplete(true);
            if (finalTimeline) {
              generationTimelineRef.current = finalTimeline;
              setGenerationTimeline(finalTimeline);
            }
            await waitForStreamHandoff(Boolean(full.trim()));
            if (generationIntentRef.current !== generationIntent) return;
            if (updatedChat) {
              qc.setQueryData(queryKeys.chat(chatId), updatedChat);
              void qc.invalidateQueries({ queryKey: queryKeys.chats });
            }
            if (mountedRef.current) {
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
          onError: (
            message,
            partialContent,
            finalTimeline,
            updatedChat,
            finalReasoning,
          ) => {
            void (async () => {
              if (generationIntentRef.current !== generationIntent) return;
              generationRef.current = null;
              setCanStopGeneration(false);
              if (deltaFrameRef.current !== null) {
                window.cancelAnimationFrame(deltaFrameRef.current);
              }
              deltaFrameRef.current = null;
              const bufferedPartial =
                streamedTextRef.current + pendingDeltaRef.current;
              const bufferedReasoning =
                streamedReasoningRef.current + pendingReasoningDeltaRef.current;
              pendingDeltaRef.current = "";
              pendingReasoningDeltaRef.current = "";
              const resolvedPartialContent = partialContent ?? bufferedPartial;
              const resolvedReasoning = finalReasoning ?? bufferedReasoning;
              streamedTextRef.current = resolvedPartialContent;
              streamedReasoningRef.current = resolvedReasoning;
              setStreamingReasoning(
                resolvedReasoning.trim() ? resolvedReasoning : null,
              );
              setStreamComplete(true);
              if (finalTimeline) {
                generationTimelineRef.current = finalTimeline;
                setGenerationTimeline(finalTimeline);
              }
              if (providerId === OPENAI_CODEX_PROVIDER_ID) {
                void refreshCodexProviderState(qc);
              }
              const partial = resolvedPartialContent.trim();
              if (partial) {
                setStreamingText(resolvedPartialContent);
                setStreamComplete(true);
                await waitForStreamHandoff(true);
                if (generationIntentRef.current !== generationIntent) return;
              }
              if (updatedChat) {
                qc.setQueryData(queryKeys.chat(chatId), updatedChat);
                void qc.invalidateQueries({ queryKey: queryKeys.chats });
              }
              if (mountedRef.current) {
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
                setError(
                  partial
                    ? `Generation stopped after a partial response: ${message}`
                    : message,
                );
              }
            })();
          },
        },
      );
      generationRef.current = handle;
    },
    [
      chatId,
      codexThinkingLevel,
      codexThinkingSupported,
      effectiveWorkspaceId,
      googleThinkingLevel,
      googleThinkingSupported,
      providerId,
      model,
      qc,
      waitForStreamHandoff,
    ],
  );

  const handleSend = React.useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (computerUseSaving) {
        throw new Error(
          "Wait for the Computer Use setting to finish saving before sending.",
        );
      }
      const generationIntent = ++generationIntentRef.current;
      setIsStoppingGeneration(false);
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
    if (!generationRef.current || !canStopGeneration) return;
    setIsStoppingGeneration(true);
    setCanStopGeneration(false);
    generationRef.current.cancel("user_stop");
  }, [canStopGeneration]);

  const cancelAgentForContextChange = React.useCallback(() => {
    generationIntentRef.current += 1;
    generationRef.current?.cancel("lifecycle");
    generationRef.current = null;
    if (deltaFrameRef.current !== null)
      window.cancelAnimationFrame(deltaFrameRef.current);
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
    if (effectiveWorkspace?.folderPath)
      void workspacesApi.openFolder(effectiveWorkspace.id);
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
        throw new Error(
          "Save or discard the open file's edits before changing workspace access.",
        );
      if (environmentPanel.agentBusy) environmentPanel.cancelAgent?.();
      await workspacesApi.update(effectiveWorkspace.id, { permission });
      await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
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
    [
      googleThinkingSupported,
      isGenerating,
      isStartingGeneration,
      model,
      qc,
      thinkingSaving,
    ],
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
    [
      codexThinkingSupported,
      isGenerating,
      isStartingGeneration,
      model,
      qc,
      thinkingSaving,
    ],
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
    [
      anthropicThinkingSupported,
      isGenerating,
      isStartingGeneration,
      model,
      qc,
      thinkingSaving,
    ],
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
        throw new Error(
          "Wait for the open file to finish saving before switching workspaces.",
        );
      }
      if (environmentPanel.editorState.dirty) {
        throw new Error(
          "Save or discard the open file's edits before switching workspaces.",
        );
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
      environmentPanel.editorState.dirty,
      environmentPanel.editorState.saving,
      environmentPanel.gitOperationBusy,
      isNewChat,
      qc,
      selectWorkspace,
    ],
  );

  const createScratchWorkspace = React.useCallback(async () => {
    if (!isNewChat)
      throw new Error("Start a new chat before choosing a scratch folder.");
    if (environmentPanel.editorState.dirty)
      throw new Error(
        "Save or discard the open file's edits before creating a scratch workspace.",
      );
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
      if (!effectiveWorkspace) throw new Error("Choose a Git workspace first.");
      if (isGenerating || isStartingGeneration)
        throw new Error(
          "Stop the current response before changing Git workspaces.",
        );
      if (environmentPanel.gitOperationBusy)
        throw new Error(
          "Wait for the current Git operation to finish before changing Git workspaces.",
        );
      if (environmentPanel.editorState.saving)
        throw new Error(
          "Wait for the open file to finish saving before changing Git workspaces.",
        );
      if (environmentPanel.editorState.dirty)
        throw new Error(
          "Save or discard the open file's edits before changing Git workspaces.",
        );
      const workspace = await gitApi.createWorktree(
        effectiveWorkspace.id,
        branchName,
      );
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
      effectiveWorkspace,
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
    streamingText:
      canStopGeneration || isStoppingGeneration ? streamingText : null,
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
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => approvalDenyRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocus?.isConnected)
        requestAnimationFrame(() => previousFocus.focus());
    };
  }, [pending?.approvalId]);

  React.useLayoutEffect(() => {
    if (pending) return;
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      approvalCardRef.current?.contains(focused)
    ) {
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
            aria-pressed={terminal.open}
            title="Toggle terminal (⌘J)"
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
            className="mx-auto w-full max-w-3xl px-3 pb-2 sm:px-5"
          >
            {pending ? (
              <div>
                <p className="sr-only" role="status">
                  Approval needed for {toolLabel(pending.toolName)}
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
                        {toolLabel(pending.toolName)} needs approval
                      </Text>
                      <Text
                        variant="small"
                        color="secondary"
                        as="p"
                        className="mt-0.5"
                      >
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
                      {decidingApprovalId === pending.approvalId
                        ? "Sending…"
                        : "Allow once"}
                    </Button>
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
            workspaceChangeBlockedReason={settingsBlockedReason}
            gitMutationBlockedReason={
              environmentPanel.gitMutationBlockedReason ?? undefined
            }
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
                    checking:
                      computerUseStatus.isLoading ||
                      computerUseStatus.isFetching,
                    saving: computerUseSaving,
                    detail: computerUseStatusDetail,
                  }
                : undefined
            }
            onChangeComputerUse={changeComputerUse}
            thinkingControl={
              googleThinkingSupported ? (
                <ThinkingControl
                  level={googleThinkingLevel}
                  levels={googleThinkingLevels}
                  canDisable={thinkingMetadata?.thinkingCanDisable !== false}
                  disabled={
                    thinkingSaving || isStartingGeneration || isGenerating
                  }
                  onChange={(level) => void changeGoogleThinking(level)}
                />
              ) : codexThinkingSupported ? (
                <ThinkingControl
                  providerLabel="Codex"
                  level={codexThinkingLevel}
                  levels={codexThinkingLevels}
                  disabled={
                    thinkingSaving || isStartingGeneration || isGenerating
                  }
                  onChange={(level) => void changeCodexThinking(level)}
                />
              ) : anthropicThinkingSupported ? (
                <ThinkingControl
                  providerLabel="Claude"
                  level={anthropicThinkingLevel}
                  levels={anthropicThinkingLevels}
                  canDisable={thinkingMetadata?.thinkingCanDisable !== false}
                  disabled={
                    thinkingSaving || isStartingGeneration || isGenerating
                  }
                  onChange={(level) => void changeAnthropicThinking(level)}
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
              (providers.data ?? []).some(
                (p) => p.models.length > 0 && (p.hasKey || !p.needsKey),
              )
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
          agentActivity={visibleAgentActivity}
          error={error}
        />
      )}
    </ScrollArea>
  );
}
