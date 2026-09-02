// The active chat: transcript (ScrollArea) + composer. Generation runs inline
// against a concrete chatId in the active workspace, streams tokens via
// startGeneration, and surfaces tool-approval prompts when the workspace is in
// "ask" mode.

import * as React from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, ScrollArea, Text, toast } from "../components/ui";
import { BotAvatar } from "../components/bot-avatar";
import { MessageCircle, ShieldQuestion, TerminalSquare } from "lucide-react";
import { MessageList } from "../components/message-list";
import { Composer } from "../components/composer";
import { AskUserQuestionComposer } from "../components/ask-user-question-composer";
import { TodoPanel } from "../components/todo-panel";
import { BtwCard, reduceBtwView, type BtwLiveView } from "../components/btw-card";
import { ModelPicker } from "../components/model-picker";
import { OpenInEditorPicker } from "../components/open-in-editor-picker";
import { useCommandHandler, useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";
import { isModelHidden } from "../shared/model-visibility";
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
  designerApi,
  aidenRemoteApi,
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
  useBot,
  useComputerUseStatus,
  useGitInfo,
  useModelInfo,
  useProviders,
  useSettings,
} from "../lib/queries";
import {
  isModelSelectionReadyForNewWork,
  resolveVisibleModelSelection,
  useModelSelection,
} from "../lib/use-model-selection";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useWorkspaceTerminal } from "../components/terminal-drawer";
import { EnvironmentPanelToggle, useEnvironmentPanel } from "../components/environment-panel";
import { DesignWorkspaceCanvas } from "../components/design-workspace";
import type { DesignProjectSnapshotV1 } from "../shared/design-projects";
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
import {
  resolveAgentActivity,
  resolveVisibleAgentActivity,
  type ToolActivity,
} from "../lib/agent-activity";
import { STREAMING_REVEAL_FALLBACK_MS } from "../lib/streaming-reveal";
import { isLatestRemoteApprovalRefresh, mergeRemoteApproval } from "../lib/remote-approval";
import {
  hasActiveToolStep,
  latestActiveAgentStep,
  type GenerationTimeline,
} from "../shared/generation-timeline";
import { RENDER_ARTIFACT_TOOL_NAME } from "../shared/generative-ui";
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
import { normalizeProviderThinkingLevel } from "../shared/provider-thinking";
import {
  isGenerationThinkingLevel,
  type GenerationThinkingLevel,
} from "../shared/generation-thinking";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import type { SkillInvocationV1 } from "../shared/slash-commands";
import { mergeSubagentSnapshots } from "../lib/subagent-view-state";
import { visibleSubagentReferences } from "../lib/subagent-feature-gate";
import { persistedChatWorkspaceId } from "../shared/chat-workspace";
import {
  detachedTextStreamingRemaining,
  detachedLifecycleChatProjection,
  isDetachedLifecycleChatDraining,
  subscribeDetachedLifecycleStreams,
} from "../lib/chat-terminal-sync";
import {
  ASSISTANT_WORKSPACE_ID,
  isSubagentMcpMutationApprovalDetails,
  isSubagentShellApprovalDetails,
  isSubagentWorkspaceWriteApprovalDetails,
} from "../shared/assistant";
import { isAppendReconciliationRequired } from "../shared/chat-message-contract";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";
import { isLocalProviderDeployment } from "../shared/provider-deployment";
import { isChatHtmlArtifact, type ChatArtifactV1 } from "../shared/chat-artifacts";
import {
  DESIGN_TURN_CONTEXT_VERSION,
  designSelectionDisplayLabel,
  designWorkspaceArtifactPlan,
  type DesignTurnContextV1,
  type DesignTurnTargetV1,
} from "../shared/design-workspace";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../shared/attachment-contract";
import {
  SOURCE_DESIGNER_VERSION,
  type SourceDesignTurnContextV1,
  type SourceSelectionBindingV1,
} from "../shared/source-designer";
import type {
  AskUserQuestionPromptV1,
  AskUserQuestionResponseV1,
} from "../shared/ask-user-question";
import { TodoSnapshotReadFence, type TodoSnapshotViewV1 } from "../shared/todo";
import type { BtwEventV1 } from "../shared/btw";

const ANTHROPIC_PROVIDER_ID = "anthropic";

/**
 * How long after the last text delta the activity row may keep saying
 * "Responding…". Beyond this the model is reasoning or writing tool-call
 * arguments, and the row should shimmer instead of going static; wide enough
 * that bursty providers do not flap the label mid-prose.
 */
const TEXT_STREAMING_IDLE_MS = 2_000;

const TOOL_LABELS: Record<string, string> = {
  edit_file: "Edit file",
  run_command: "Run command",
  write_file: "Write file",
  computer_use: "Computer Use",
};

function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName.replace(/_/g, " ");
}

function ComposerPlacement({
  design,
  host,
  children,
}: React.PropsWithChildren<{ design: boolean; host: HTMLDivElement | null }>) {
  if (!design) return children;
  return host ? createPortal(children, host) : null;
}

export function ChatPane({
  chatId,
  presentation = "chat",
  initialDesignMediaId,
  designProject,
  onDesignProjectChange,
}: {
  chatId: string;
  presentation?: "chat" | "design";
  initialDesignMediaId?: string;
  designProject?: DesignProjectSnapshotV1;
  onDesignProjectChange?: (project: DesignProjectSnapshotV1) => void;
}) {
  const qc = useQueryClient();
  const [currentDesignProject, setCurrentDesignProject] = React.useState<
    DesignProjectSnapshotV1 | undefined
  >(designProject);
  const navigate = useNavigate();
  const providers = useProviders();
  const documentAppendReconciliationRequired = useAppendReconciliationRequired();
  const chat = useChat(chatId);
  const bot = useBot(chat.data?.botId);
  const settings = useSettings();
  const computerUseGloballyEnabled = settings.data?.computerUseEnabled === true;
  const computerUseStatus = useComputerUseStatus(computerUseGloballyEnabled);
  const { activeId, workspaces, select: selectWorkspace } = useActiveWorkspace();
  const [appendReconciliationRequiredChats, setAppendReconciliationRequiredChats] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  const [designConversationOpen, setDesignConversationOpen] = React.useState(true);
  const [designComposerHost, setDesignComposerHost] = React.useState<HTMLDivElement | null>(null);
  const [designComposerRequiresVisibility, setDesignComposerRequiresVisibility] =
    React.useState(false);
  const chatWorkspaceId = chat.data?.workspaceId;
  const effectiveWorkspaceId = chat.data ? persistedChatWorkspaceId(chatWorkspaceId) : undefined;
  const effectiveWorkspace = workspaces.find((workspace) => workspace.id === effectiveWorkspaceId);
  const connectedDesignWorkspace =
    currentDesignProject?.connectionState === "connected"
      ? workspaces.find((workspace) => workspace.id === currentDesignProject.workspaceId)
      : undefined;
  const generationWorkspaceId =
    presentation === "design"
      ? currentDesignProject?.connectionState === "connected"
        ? currentDesignProject.workspaceId
        : undefined
      : effectiveWorkspaceId;
  const sideQuestionBlockedReason =
    presentation === "design"
      ? "Side questions are not available in Design Projects."
      : chat.data?.botId || bot.data
        ? "Side questions are not available in Bot chats."
        : effectiveWorkspaceId === ASSISTANT_WORKSPACE_ID
          ? "Side questions are not available in Assistant chats."
          : undefined;
  const detachedGenerationDraining = React.useSyncExternalStore(
    subscribeDetachedLifecycleStreams,
    () => isDetachedLifecycleChatDraining(chatId, effectiveWorkspaceId),
    () => false,
  );
  const detachedProjection = React.useSyncExternalStore(
    subscribeDetachedLifecycleStreams,
    () => detachedLifecycleChatProjection(chatId, effectiveWorkspaceId),
    () => null,
  );
  const terminal = useWorkspaceTerminal();
  const git = useGitInfo(effectiveWorkspace?.id);
  const environmentPanel = useEnvironmentPanel();
  const designWorkspaceBlocked = Boolean(chat.data?.botId);
  const designWorkspaceDisabled =
    presentation === "design" &&
    (!currentDesignProject ||
      designWorkspaceBlocked ||
      (currentDesignProject.connectionState === "connected" &&
        (!connectedDesignWorkspace?.folderPath || connectedDesignWorkspace.permission === "none")));
  const designWorkspaceTitle = chat.data?.botId
    ? "Design workspace is unavailable in Bot chats"
    : currentDesignProject?.connectionState === "connected" &&
        connectedDesignWorkspace?.permission === "none"
      ? "Give the connected app workspace file access before continuing"
      : currentDesignProject?.connectionState === "connected" &&
          !connectedDesignWorkspace?.folderPath
        ? "Reconnect this project to an available folder workspace"
        : !currentDesignProject
          ? "This Design Project is unavailable"
          : "Design workspace";

  React.useEffect(() => {
    setCurrentDesignProject(designProject);
  }, [designProject]);
  const updateDesignProject = React.useCallback(
    (project: DesignProjectSnapshotV1) => {
      setCurrentDesignProject(project);
      onDesignProjectChange?.(project);
    },
    [onDesignProjectChange],
  );
  const settingsBlockedReason = environmentPanel.gitOperationBusy
    ? "Wait for the current Git operation to finish"
    : environmentPanel.editorState.saving
      ? "Wait for the open file to finish saving"
      : environmentPanel.editorState.dirty
        ? "Save or discard the open file's edits first"
        : undefined;
  const { providerId, model, select } = useModelSelection(
    providers.data,
    settings.data?.hiddenModelsByProvider,
    settings.data !== undefined,
  );
  const hasMessages = (chat.data?.messages.length ?? 0) > 0;
  const selectedProvider = providers.data?.find((provider) => provider.id === providerId);
  const modelReady = Boolean(
    selectedProvider &&
    isModelSelectionReadyForNewWork(
      { providerId, model },
      providers.data,
      settings.data?.hiddenModelsByProvider,
      hasMessages,
    ) &&
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
    if (
      !hasMessages &&
      settings.data !== undefined &&
      isModelHidden(settings.data.hiddenModelsByProvider, providerId, model)
    ) {
      return "This model is hidden from new chats. Show a model in Settings → Providers before sending.";
    }
    return undefined;
  }, [hasMessages, model, providerId, providers.isLoading, selectedProvider, settings.data]);
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
          ? "Response continues in the background…"
          : undefined;
  const botReadinessMessage = chat.data?.botId
    ? bot.isLoading
      ? "Loading bot…"
      : !bot.data
        ? "This bot is no longer available."
        : bot.data.archivedAt
          ? "Restore this bot before continuing the conversation."
          : undefined
    : undefined;
  const ready =
    modelReady && !computerUseReadinessMessage && !chatReadinessMessage && !botReadinessMessage;
  const readinessMessage =
    chatReadinessMessage ??
    botReadinessMessage ??
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
  const providerThinkingLevels = React.useMemo<GenerationThinkingLevel[]>(() => {
    const declared = thinkingMetadata?.thinkingLevels;
    return declared?.filter(isGenerationThinkingLevel) ?? [];
  }, [thinkingMetadata?.thinkingLevels]);
  const providerThinkingSupported =
    selectedProvider?.isBuiltin === true &&
    providerId !== GOOGLE_PROVIDER_ID &&
    providerId !== OPENAI_CODEX_PROVIDER_ID &&
    providerId !== ANTHROPIC_PROVIDER_ID &&
    Boolean(model) &&
    modelInfo.data?.[model]?.reasoning === true &&
    providerThinkingLevels.length > 0;
  const storedProviderThinkingLevel = model
    ? settings.data?.providerThinkingByModel?.[providerId]?.[model]
    : undefined;
  const providerThinkingLevel = normalizeProviderThinkingLevel(
    providerThinkingLevels,
    storedProviderThinkingLevel,
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
  const [streamingArtifacts, setStreamingArtifacts] = React.useState<ChatArtifactV1[]>([]);
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
  const [questionnaire, setQuestionnaire] = React.useState<AskUserQuestionPromptV1 | null>(null);
  const [questionnaireSubmitting, setQuestionnaireSubmitting] = React.useState(false);
  const [btwView, setBtwView] = React.useState<BtwLiveView | null>(null);
  const [todoSnapshot, setTodoSnapshot] = React.useState<TodoSnapshotViewV1 | null>(null);
  const [computerUseSaving, setComputerUseSaving] = React.useState(false);
  const [thinkingSaving, setThinkingSaving] = React.useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<string | null>(null);
  const decidingApprovalRef = React.useRef<string | null>(null);
  const generationRef = React.useRef<GenerationHandle | null>(null);
  const generationChatIdRef = React.useRef<string | null>(null);
  const generationIntentRef = React.useRef(0);
  const visualizeTurnRef = React.useRef(false);
  const designTurnRef = React.useRef(false);
  const designContextTurnRef = React.useRef<DesignTurnContextV1 | undefined>(undefined);
  const sourceDesignContextTurnRef = React.useRef<SourceDesignTurnContextV1 | undefined>(undefined);
  const [designTargets, setDesignTargets] = React.useState<DesignTurnTargetV1[]>([]);
  const [sourceDesignSelection, setSourceDesignSelection] =
    React.useState<SourceSelectionBindingV1>();
  const [designCanvasImages, setDesignCanvasImages] = React.useState<Attachment[]>([]);
  const mountedRef = React.useRef(true);
  const chatIdRef = React.useRef(chatId);
  const todoSnapshotReadFenceRef = React.useRef<TodoSnapshotReadFence | null>(null);
  const todoSnapshotReadFence = (todoSnapshotReadFenceRef.current ??= new TodoSnapshotReadFence());
  const btwViewRef = React.useRef<BtwLiveView | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const designConversationToggleRef = React.useRef<HTMLButtonElement | null>(null);
  const focusComposer = React.useCallback(() => {
    if (presentation === "design") setDesignConversationOpen(true);
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  }, [presentation]);
  useCommandHandler("composer.focus", focusComposer);
  const terminalShortcut = useShortcutLabel("terminal.toggle");
  const terminalShortcutBinding = useShortcutBinding("terminal.toggle");
  const approvalDenyRef = React.useRef<HTMLButtonElement | null>(null);
  const approvalCardRef = React.useRef<HTMLElement | null>(null);
  const remoteApprovalRefreshRef = React.useRef(0);
  const pendingDeltaRef = React.useRef("");
  const pendingReasoningDeltaRef = React.useRef("");
  const streamedTextRef = React.useRef("");
  const streamedReasoningRef = React.useRef("");
  const streamingArtifactsRef = React.useRef<ChatArtifactV1[]>([]);
  const deltaFrameRef = React.useRef<number | null>(null);
  const streamHandoffRef = React.useRef<(() => void) | null>(null);
  const generationTimelineRef = React.useRef<GenerationTimeline | null>(null);
  // Prose from an earlier turn must not pin the activity row to a static
  // "Responding…" while the model reasons or writes tool arguments, so the
  // row keys "responding" off deltas that are still arriving.
  const [textStreaming, setTextStreaming] = React.useState(false);
  const textStreamingTimerRef = React.useRef<number | null>(null);
  const markTextStreaming = React.useCallback(() => {
    setTextStreaming(true);
    if (textStreamingTimerRef.current !== null) {
      window.clearTimeout(textStreamingTimerRef.current);
    }
    textStreamingTimerRef.current = window.setTimeout(() => {
      textStreamingTimerRef.current = null;
      setTextStreaming(false);
    }, TEXT_STREAMING_IDLE_MS);
  }, []);
  const clearTextStreaming = React.useCallback(() => {
    if (textStreamingTimerRef.current !== null) {
      window.clearTimeout(textStreamingTimerRef.current);
      textStreamingTimerRef.current = null;
    }
    setTextStreaming(false);
  }, []);
  React.useEffect(
    () => () => {
      if (textStreamingTimerRef.current !== null) {
        window.clearTimeout(textStreamingTimerRef.current);
      }
    },
    [],
  );

  chatIdRef.current = chatId;
  React.useEffect(() => {
    btwViewRef.current = btwView;
  }, [btwView]);

  React.useEffect(
    () =>
      chatsApi.onBtwEvent((event: BtwEventV1) => {
        if (event.chatId !== chatIdRef.current) return;
        setBtwView((current) => reduceBtwView(current, event));
      }),
    [],
  );

  React.useEffect(() => {
    let active = true;
    const refresh = async () => {
      const requestId = ++remoteApprovalRefreshRef.current;
      try {
        const remote = await aidenRemoteApi.pendingApproval(chatId);
        if (
          !active ||
          chatIdRef.current !== chatId ||
          !isLatestRemoteApprovalRefresh(requestId, remoteApprovalRefreshRef.current)
        )
          return;
        setApprovals((current) => mergeRemoteApproval(current, remote));
      } catch {
        // Remote chat infrastructure is lazy; absence before first pairing is expected.
      }
    };
    void refresh();
    const unsubscribe = aidenRemoteApi.onApprovalChanged(({ chatId: changedChatId }) => {
      if (changedChatId === chatId) void refresh();
    });
    return () => {
      active = false;
      remoteApprovalRefreshRef.current += 1;
      unsubscribe();
    };
  }, [chatId]);

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
      const sideQuestion = btwViewRef.current;
      if (
        sideQuestion &&
        sideQuestion.requestId !== "pending" &&
        (sideQuestion.status === "starting" || sideQuestion.status === "running")
      ) {
        void chatsApi.btwCancel(departingChatId, sideQuestion.requestId);
      }
      if (deltaFrameRef.current !== null) window.cancelAnimationFrame(deltaFrameRef.current);
      deltaFrameRef.current = null;
      pendingDeltaRef.current = "";
      pendingReasoningDeltaRef.current = "";
      streamedTextRef.current = "";
      streamedReasoningRef.current = "";
      streamingArtifactsRef.current = [];
      streamHandoffRef.current?.();
      streamHandoffRef.current = null;
    };
  }, [chatId]);

  // Reset transient state when switching chats. This runs as a layout effect so
  // the incoming chatId never paints a frame carrying the outgoing chat's
  // stream, timeline, or approvals.
  React.useLayoutEffect(() => {
    todoSnapshotReadFence.reset(chatId);
    setStreamingText(null);
    setStreamingReasoning(null);
    clearTextStreaming();
    setStreamingArtifacts([]);
    streamingArtifactsRef.current = [];
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
    setQuestionnaire(null);
    setQuestionnaireSubmitting(false);
    setBtwView(null);
    setTodoSnapshot(null);
    decidingApprovalRef.current = null;
    setDecidingApprovalId(null);
  }, [chatId]);

  React.useEffect(() => {
    let current = true;
    const ticket = todoSnapshotReadFence.beginInitialRead(chatId);
    void chatsApi.todoSnapshot(chatId).then(
      (snapshot) => {
        if (
          current &&
          chatIdRef.current === chatId &&
          todoSnapshotReadFence.canApplyInitial(ticket)
        ) {
          setTodoSnapshot(snapshot);
        }
      },
      () => {
        // The chat remains usable. A verified corrupt journal is represented by
        // an explicit unavailable snapshot; transport/lifecycle failures stay quiet.
      },
    );
    return () => {
      current = false;
    };
  }, [chatId]);

  const messages = React.useMemo(() => chat.data?.messages ?? [], [chat.data?.messages]);
  const visibleDetachedProjection =
    messages[messages.length - 1]?.role === "assistant" ? null : detachedProjection;
  const visibleDetachedStreamId = visibleDetachedProjection?.streamId;
  const detachedLastTextDeltaAt = visibleDetachedProjection?.lastTextDeltaAt ?? null;
  React.useEffect(() => {
    if (!visibleDetachedStreamId) return;
    const remaining = detachedTextStreamingRemaining(
      detachedLastTextDeltaAt,
      Date.now(),
      TEXT_STREAMING_IDLE_MS,
    );
    if (textStreamingTimerRef.current !== null) {
      window.clearTimeout(textStreamingTimerRef.current);
      textStreamingTimerRef.current = null;
    }
    if (remaining === 0) {
      setTextStreaming(false);
      return;
    }
    setTextStreaming(true);
    const timer = window.setTimeout(() => {
      if (textStreamingTimerRef.current === timer) {
        textStreamingTimerRef.current = null;
        setTextStreaming(false);
      }
    }, remaining);
    textStreamingTimerRef.current = timer;
    return () => {
      if (textStreamingTimerRef.current === timer) {
        window.clearTimeout(timer);
        textStreamingTimerRef.current = null;
      }
    };
  }, [detachedLastTextDeltaAt, visibleDetachedStreamId]);
  const displayedStreamingText = streamingText ?? visibleDetachedProjection?.content ?? null;
  const displayedStreamingReasoning =
    streamingReasoning ??
    (visibleDetachedProjection?.reasoning.trim() ? visibleDetachedProjection.reasoning : null);
  const displayedStreamingArtifacts = React.useMemo(
    () =>
      streamingArtifacts.length > 0
        ? streamingArtifacts
        : (visibleDetachedProjection?.artifacts ?? []),
    [streamingArtifacts, visibleDetachedProjection?.artifacts],
  );
  const liveDesignArtifacts = React.useMemo(
    () => displayedStreamingArtifacts.filter(isChatHtmlArtifact),
    [displayedStreamingArtifacts],
  );
  const designArtifacts = React.useMemo(
    () => designWorkspaceArtifactPlan(messages, liveDesignArtifacts),
    [liveDesignArtifacts, messages],
  );
  const designContextItems = React.useMemo(
    () => [
      ...(sourceDesignSelection
        ? [
            {
              id: `source:${sourceDesignSelection.id}`,
              kind: "element" as const,
              label: `${sourceDesignSelection.selection.label} · ${sourceDesignSelection.path}`,
            },
          ]
        : []),
      ...designTargets.map((target) => {
        const artifact = designArtifacts.find(
          (entry) =>
            entry.artifact.mediaId === target.mediaId && entry.artifact.id === target.artifactId,
        )?.artifact;
        return {
          id: `target:${target.mediaId}`,
          kind: target.selection ? ("element" as const) : ("design" as const),
          label: target.selection
            ? designSelectionDisplayLabel(target.selection)
            : (artifact?.title ?? "Selected design"),
        };
      }),
      ...designCanvasImages.map((attachment) => ({
        id: `image:${attachment.id}`,
        kind: "image" as const,
        label: attachment.name,
      })),
    ],
    [designArtifacts, designCanvasImages, designTargets, sourceDesignSelection],
  );
  const removeDesignContextItem = React.useCallback((id: string) => {
    if (id.startsWith("target:")) {
      const mediaId = id.slice("target:".length);
      setDesignTargets((current) => current.filter((target) => target.mediaId !== mediaId));
      return;
    }
    if (id.startsWith("image:")) {
      const attachmentId = id.slice("image:".length);
      setDesignCanvasImages((current) =>
        current.filter((attachment) => attachment.id !== attachmentId),
      );
      return;
    }
    if (id.startsWith("source:")) {
      setSourceDesignSelection(undefined);
    }
  }, []);
  const displayedGenerationTimeline =
    generationTimeline ?? visibleDetachedProjection?.timeline ?? null;
  const displayedLiveSubagents = React.useMemo(
    () =>
      mergeSubagentSnapshots(liveSubagents, visibleDetachedProjection?.subagents ?? [], {
        chatId,
        workspaceId: effectiveWorkspaceId,
      }),
    [chatId, effectiveWorkspaceId, liveSubagents, visibleDetachedProjection?.subagents],
  );
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
  const imageArtifactRecoveryPending =
    hasUnpersistedResponse || chat.data?.imageArtifactRecoveryPending === true;
  const imageArtifactRecoveryUnavailable = chat.data?.imageArtifactRecoveryUnavailable === true;
  const isGenerating = streamingText !== null && !hasUnpersistedResponse;
  const isNewChat = !chat.isLoading && !hasMessages && displayedStreamingText === null;

  React.useEffect(() => {
    if (!isNewChat || settings.data === undefined) return;
    const next = resolveVisibleModelSelection(
      { providerId, model },
      providers.data,
      settings.data?.hiddenModelsByProvider,
    );
    if (next && (next.providerId !== providerId || next.model !== model)) {
      select(next.providerId, next.model);
    }
  }, [isNewChat, model, providerId, providers.data, select, settings.data]);

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
      if (imageArtifactRecoveryUnavailable) {
        throw new Error(
          "Visual artifact staging is unavailable. Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair.",
        );
      }
      if (imageArtifactRecoveryPending) {
        throw new Error(
          "A previous visual artifact could not be recovered. Delete this chat to discard it before copying.",
        );
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
      imageArtifactRecoveryPending,
      imageArtifactRecoveryUnavailable,
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
    environmentPanel.syncSubagents(
      chatId,
      effectiveWorkspaceId,
      subagentReferences,
      displayedLiveSubagents,
    );
  }, [
    chatId,
    effectiveWorkspaceId,
    environmentPanel.subagentsEnabled,
    environmentPanel.syncSubagents,
    displayedLiveSubagents,
    subagentReferences,
  ]);

  React.useLayoutEffect(() => {
    environmentPanel.setAgentBusy(
      isGenerating || isStartingGeneration || detachedGenerationDraining,
    );
    return () => environmentPanel.setAgentBusy(false);
  }, [
    detachedGenerationDraining,
    environmentPanel.setAgentBusy,
    isGenerating,
    isStartingGeneration,
  ]);

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
    (messageTurnId: string, preparedWorkspaceId = generationWorkspaceId) => {
      const generationIntent = generationIntentRef.current;
      setError(null);
      setIsStoppingGeneration(false);
      setCanStopGeneration(true);
      setIsModelLoading(false);
      setHasUnpersistedResponse(false);
      setStreamingText("");
      setStreamingReasoning(null);
      clearTextStreaming();
      setStreamingArtifacts([]);
      streamingArtifactsRef.current = [];
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
      setQuestionnaire(null);
      setQuestionnaireSubmitting(false);
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
            markTextStreaming();
          }
          if (pendingReasoningDelta) {
            streamedReasoningRef.current += pendingReasoningDelta;
            setStreamingReasoning(streamedReasoningRef.current);
          }
        });
      };
      const visualize = visualizeTurnRef.current === true;
      visualizeTurnRef.current = false;
      const design = designTurnRef.current === true;
      designTurnRef.current = false;
      const designContext = designContextTurnRef.current;
      designContextTurnRef.current = undefined;
      const sourceDesignContext = sourceDesignContextTurnRef.current;
      sourceDesignContextTurnRef.current = undefined;
      const handle = startGeneration(
        {
          chatId,
          workspaceId: preparedWorkspaceId,
          providerId,
          model,
          ...(visualize ? { visualize: true as const } : {}),
          ...(design ? { design: true as const } : {}),
          ...(design && designContext ? { designContext } : {}),
          ...(design && sourceDesignContext ? { sourceDesignContext } : {}),
          thinkingLevel: googleThinkingSupported
            ? googleThinkingLevel
            : codexThinkingSupported
              ? codexThinkingLevel
              : anthropicThinkingSupported
                ? anthropicThinkingLevel
                : providerThinkingSupported
                  ? providerThinkingLevel
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
            clearTextStreaming();
            setStreamComplete(false);
          },
          onArtifactEvent: (event) => {
            if (!mountedRef.current || generationIntentRef.current !== generationIntent) return;
            if (event.operation === "reset") {
              setStreamingArtifacts([]);
              streamingArtifactsRef.current = [];
              return;
            }
            const { artifact } = event;
            setIsModelLoading(false);
            if (artifact.kind === "html") {
              const index = streamingArtifactsRef.current.findIndex(
                (candidate) => candidate.kind === "html" && candidate.mediaId === artifact.mediaId,
              );
              if (index >= 0) {
                streamingArtifactsRef.current = streamingArtifactsRef.current.map((candidate, i) =>
                  i === index ? artifact : candidate,
                );
              } else {
                streamingArtifactsRef.current = [...streamingArtifactsRef.current, artifact];
              }
              setStreamingArtifacts(streamingArtifactsRef.current);
              return;
            }
            if (
              streamingArtifactsRef.current.some(
                (candidate) =>
                  candidate.kind === "image" && candidate.attachment.id === artifact.attachment.id,
              )
            ) {
              return;
            }
            streamingArtifactsRef.current = [...streamingArtifactsRef.current, artifact];
            setStreamingArtifacts(streamingArtifactsRef.current);
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
          onQuestionnaire: (prompt) => {
            if (mountedRef.current && generationIntentRef.current === generationIntent) {
              // Open in the same render that mounts the questionnaire so its
              // initial focus never targets controls inside a hidden rail.
              setDesignConversationOpen(true);
              setQuestionnaireSubmitting(false);
              setQuestionnaire(prompt);
            }
          },
          onTodo: (snapshot) => {
            if (
              mountedRef.current &&
              generationIntentRef.current === generationIntent &&
              snapshot.chatId === chatId
            ) {
              todoSnapshotReadFence.markLive(snapshot.chatId);
              setTodoSnapshot(snapshot);
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
            clearTextStreaming();
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
              setStreamingArtifacts([]);
              streamingArtifactsRef.current = [];
              streamedTextRef.current = "";
              streamedReasoningRef.current = "";
              setStreamComplete(false);
              setIsStoppingGeneration(false);
              setIsModelLoading(false);
              setGenerationTimeline(null);
              generationTimelineRef.current = null;
              setApprovals([]);
              setQuestionnaire(null);
              setQuestionnaireSubmitting(false);
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
              clearTextStreaming();
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
                const hasUnpersistedArtifact = streamingArtifactsRef.current.length > 0;
                setHasUnpersistedResponse(
                  Boolean((partial || hasUnpersistedArtifact) && !updatedChat),
                );
                if (updatedChat) {
                  setStreamingArtifacts([]);
                  streamingArtifactsRef.current = [];
                }
                setIsStoppingGeneration(false);
                setIsModelLoading(false);
                if (!partial || updatedChat) {
                  setGenerationTimeline(null);
                  generationTimelineRef.current = null;
                }
                setApprovals([]);
                setQuestionnaire(null);
                setQuestionnaireSubmitting(false);
                const persistedFailure =
                  updatedChat?.messages[updatedChat.messages.length - 1]?.role === "assistant" &&
                  updatedChat.messages[updatedChat.messages.length - 1]?.providerFailure;
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
      anthropicThinkingLevel,
      anthropicThinkingSupported,
      clearTextStreaming,
      codexThinkingLevel,
      codexThinkingSupported,
      generationWorkspaceId,
      environmentPanel.subagentsEnabled,
      googleThinkingLevel,
      googleThinkingSupported,
      markTextStreaming,
      providerId,
      providerThinkingLevel,
      providerThinkingSupported,
      model,
      qc,
      waitForStreamHandoff,
    ],
  );

  const handleSend = React.useCallback(
    async (
      text: string,
      attachments: Attachment[],
      skillInvocation?: SkillInvocationV1,
      options?: { visualize?: boolean; btw?: boolean },
    ) => {
      if (options?.btw) {
        if (attachments.length > 0 || skillInvocation) {
          throw new Error("Side questions do not accept attachments or skills.");
        }
        const question = text.trim();
        setBtwView({
          requestId: "pending",
          question,
          answer: "",
          status: "starting",
          hasHistory: btwViewRef.current?.hasHistory ?? false,
          contextTrimmed: false,
          sequence: -1,
        });
        try {
          const receipt = await chatsApi.btwStart(chatId, question);
          setBtwView((current) =>
            current?.requestId === "pending"
              ? { ...current, requestId: receipt.requestId }
              : current,
          );
        } catch (error) {
          setBtwView((current) => (current?.requestId === "pending" ? null : current));
          throw error;
        }
        return;
      }
      const design = presentation === "design";
      designTurnRef.current = false;
      designContextTurnRef.current = undefined;
      sourceDesignContextTurnRef.current = undefined;
      visualizeTurnRef.current = false;
      const selectedTargets = design ? [...designTargets] : [];
      const selectedSource = design ? sourceDesignSelection : undefined;
      const selectedReferenceImages = design ? [...designCanvasImages] : [];
      const submittedAttachments = [...attachments];
      const submittedAttachmentIds = new Set(
        submittedAttachments.map((attachment) => attachment.id),
      );
      for (const attachment of selectedReferenceImages) {
        if (!submittedAttachmentIds.has(attachment.id)) {
          submittedAttachments.push(attachment);
          submittedAttachmentIds.add(attachment.id);
        }
      }
      if (submittedAttachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new Error(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments can be sent at once.`);
      }
      if (selectedReferenceImages.length > 0 && visionSupported === false) {
        throw new Error("Switch to a vision-capable model before using canvas images as context.");
      }
      if (imageArtifactRecoveryUnavailable) {
        throw new Error(
          "Visual artifact staging is unavailable. Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair.",
        );
      }
      if (imageArtifactRecoveryPending) {
        throw new Error(
          "A previous visual artifact could not be recovered. Delete this chat to discard it before sending another message.",
        );
      }
      if (computerUseSaving) {
        throw new Error("Wait for the Computer Use setting to finish saving before sending.");
      }
      if (detachedGenerationDraining) {
        throw new Error("Wait for the previous response to finish saving before sending again.");
      }
      let preparedWorkspaceId = generationWorkspaceId;
      let designPreflight: Awaited<ReturnType<typeof designerApi.preflightGeneration>> | undefined;
      if (design) {
        if (!currentDesignProject) throw new Error("This Design Project is unavailable.");
        const preflight = await designerApi.preflightGeneration({
          projectId: currentDesignProject.id,
        });
        if (
          preflight.projectId !== currentDesignProject.id ||
          preflight.chatId !== chatId ||
          preflight.projectRevision !== currentDesignProject.revision ||
          preflight.connectionState !== currentDesignProject.connectionState ||
          preflight.workspaceId !== currentDesignProject.workspaceId
        ) {
          throw new Error(
            "This Design Project changed in another window. Reopen it before sending this prompt.",
          );
        }
        preparedWorkspaceId = preflight.workspaceId;
        designPreflight = preflight;
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
              attachments: submittedAttachments.length ? submittedAttachments : undefined,
            },
            {
              providerId,
              model,
              autoTitle: true,
              turnId: messageTurnId,
              skillInvocation,
              designPreflight,
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
        designTurnRef.current = design;
        visualizeTurnRef.current = options?.visualize === true && !design;
        designContextTurnRef.current =
          design && !selectedSource && selectedTargets.length > 0
            ? { version: DESIGN_TURN_CONTEXT_VERSION, targets: selectedTargets }
            : undefined;
        sourceDesignContextTurnRef.current =
          design && selectedSource
            ? {
                version: SOURCE_DESIGNER_VERSION,
                selectionId: selectedSource.id,
              }
            : undefined;
        if (design) {
          setDesignTargets([]);
          setSourceDesignSelection(undefined);
          setDesignCanvasImages([]);
        }
        const started = await runGeneration(messageTurnId, preparedWorkspaceId);
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
    [
      chatId,
      computerUseSaving,
      currentDesignProject,
      designCanvasImages,
      designTargets,
      detachedGenerationDraining,
      presentation,
      sourceDesignSelection,
      imageArtifactRecoveryPending,
      imageArtifactRecoveryUnavailable,
      generationWorkspaceId,
      providerId,
      model,
      qc,
      runGeneration,
      visionSupported,
    ],
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
    streamingArtifactsRef.current = [];
    streamHandoffRef.current?.();
    streamHandoffRef.current = null;
    setStreamingText(null);
    setStreamingReasoning(null);
    setStreamingArtifacts([]);
    setStreamComplete(false);
    setIsStartingGeneration(false);
    setIsStoppingGeneration(false);
    setIsModelLoading(false);
    setCanStopGeneration(false);
    setGenerationTimeline(null);
    generationTimelineRef.current = null;
    setLiveSubagents([]);
    setApprovals([]);
    setQuestionnaire(null);
    setQuestionnaireSubmitting(false);
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
        if (prompt.source === "remote") {
          await aidenRemoteApi.respondApproval(chatId, prompt.approvalId, decision);
        } else {
          await chatsApi.approve(prompt.approvalId, decision);
        }
        if (chatIdRef.current !== decisionChatId) return;
        setApprovals((prev) =>
          prev.filter((approval) => approval.approvalId !== prompt.approvalId),
        );
      } catch (approvalError) {
        if (chatIdRef.current !== decisionChatId) return;
        if (prompt.source === "remote") {
          setApprovals((prev) =>
            prev.filter((approval) => approval.approvalId !== prompt.approvalId),
          );
        }
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

  const answerQuestionnaire = React.useCallback(
    async (response: AskUserQuestionResponseV1) => {
      if (!questionnaire || questionnaireSubmitting) return;
      setQuestionnaireSubmitting(true);
      try {
        await chatsApi.answerQuestionnaire(questionnaire.promptId, response);
        if (chatIdRef.current === chatId) setQuestionnaire(null);
      } catch (questionError) {
        if (chatIdRef.current !== chatId) return;
        toast.error(
          questionError instanceof Error ? questionError.message : "Couldn't send that answer.",
        );
      } finally {
        if (chatIdRef.current === chatId) setQuestionnaireSubmitting(false);
      }
    },
    [chatId, questionnaire, questionnaireSubmitting],
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

  const changeProviderThinking = React.useCallback(
    async (level: GenerationThinkingLevel) => {
      if (
        !model ||
        !providerThinkingSupported ||
        thinkingSaving ||
        isStartingGeneration ||
        isGenerating
      )
        return;
      setThinkingSaving(true);
      try {
        const updated = await settingsApi.setProviderThinking(providerId, model, level);
        qc.setQueryData(queryKeys.settings, updated);
      } catch (changeError) {
        toast.error(
          changeError instanceof Error
            ? changeError.message
            : "Couldn't save this model's thinking level.",
        );
      } finally {
        setThinkingSaving(false);
      }
    },
    [
      isGenerating,
      isStartingGeneration,
      model,
      providerId,
      providerThinkingSupported,
      qc,
      thinkingSaving,
    ],
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
        const updated = await settingsApi.set({
          showLocalModelReasoning: visible,
        });
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
    [isGenerating, isStartingGeneration, localReasoningVisibilitySupported, qc, thinkingSaving],
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
  const pendingCanAllow = pending?.canAllow !== false && !invalidPendingPrivilegedApproval;
  const designComposerMustStayOpen =
    presentation === "design" &&
    Boolean(
      questionnaire ||
      pending ||
      isGenerating ||
      isStartingGeneration ||
      detachedGenerationDraining ||
      designComposerRequiresVisibility,
    );

  React.useEffect(() => {
    if (designComposerMustStayOpen) setDesignConversationOpen(true);
  }, [designComposerMustStayOpen]);

  const closeDesignConversation = React.useCallback(() => {
    if (designComposerMustStayOpen) return;
    setDesignConversationOpen(false);
    requestAnimationFrame(() => designConversationToggleRef.current?.focus());
  }, [designComposerMustStayOpen]);

  const toggleDesignConversation = React.useCallback(() => {
    if (designConversationOpen) {
      closeDesignConversation();
    } else {
      setDesignConversationOpen(true);
    }
  }, [closeDesignConversation, designConversationOpen]);
  const activeStep = latestActiveAgentStep(displayedGenerationTimeline);
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
      canStopGeneration || isStoppingGeneration || detachedGenerationDraining
        ? displayedStreamingText
        : null,
    textStreaming,
    pendingApproval: Boolean(pending),
    toolActivity,
  });
  // The reasoning disclosure owns exposed reasoning for the whole turn, even
  // after its timeline step settles. Visualizing owns only the live artifact
  // render window; detached projections hide that block and keep narration.
  const visualizingBlockVisible =
    hasActiveToolStep(displayedGenerationTimeline, RENDER_ARTIFACT_TOOL_NAME) &&
    !streamComplete &&
    !visibleDetachedProjection;
  const visibleAgentActivity = resolveVisibleAgentActivity(agentActivity, {
    reasoningVisible: Boolean(displayedStreamingReasoning),
    visualizingVisible: visualizingBlockVisible,
  });

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
      focusComposer();
    }
  }, [focusComposer, pending]);

  return (
    <>
      <ScrollArea
        className="h-full min-h-0"
        title={
          presentation === "design" ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{currentDesignProject?.title ?? "Design Project"}</span>
              <span className="rounded-pill bg-control px-2 py-0.5 text-mini font-medium text-secondary">
                {currentDesignProject?.connectionState === "connected"
                  ? "Connected App"
                  : "Prototype"}
              </span>
              <span className="hidden text-small font-normal text-tertiary sm:inline">
                Saved locally
              </span>
            </span>
          ) : bot.data ? (
            <span className="flex min-w-0 items-center gap-2">
              <BotAvatar
                botId={bot.data.id}
                avatar={bot.data.avatar}
                name={bot.data.name}
                photoLoading="immediate"
                size="small"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate">{bot.data.name}</span>
                  <span className="rounded-pill bg-control px-2 py-0.5 text-mini font-medium text-secondary">
                    Bot
                  </span>
                </span>
                <span className="block truncate text-small font-normal text-secondary">
                  {chat.data?.title ?? "New conversation"}
                </span>
              </span>
            </span>
          ) : (
            (chat.data?.title ?? "New agent")
          )
        }
        actions={
          presentation === "design" ? (
            <Button
              ref={designConversationToggleRef}
              variant="toolbar"
              size="small"
              onClick={toggleDesignConversation}
              disabled={designConversationOpen && designComposerMustStayOpen}
              aria-label="Toggle project conversation"
              aria-pressed={designConversationOpen}
              title={
                designComposerMustStayOpen
                  ? "Conversation stays open while an active task needs its controls"
                  : "Toggle project conversation"
              }
            >
              <MessageCircle />
              Conversation
            </Button>
          ) : (
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
          )
        }
        autoScrollToBottom={presentation === "chat"}
        autoScrollDeps={[
          messages.length,
          displayedStreamingText,
          displayedStreamingReasoning,
          displayedGenerationTimeline,
          agentActivity?.phase,
          approvals.length,
          questionnaire?.promptId,
          displayedStreamingArtifacts.length,
        ]}
        showScrollToBottomButton={presentation === "chat"}
        overlayFooter={presentation === "design"}
        scrollToBottomButtonOffset={
          presentation === "chat" &&
          (todoSnapshot?.availability === "unavailable" ||
            todoSnapshot?.tasks.some(
              (task) => task.status !== "deleted" && task.status !== "completed",
            ))
            ? 44
            : 0
        }
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
                    {!pendingCanAllow ? (
                      <Text
                        variant="small"
                        as="p"
                        id={`approval-summary-${pending.approvalId}`}
                        className="mt-2.5 rounded-control bg-well px-3 py-2"
                      >
                        Aiden cannot safely authorize this action from this view. Deny it here or
                        review the exact action on the Mac that owns this chat.
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
                      {pendingCanAllow ? (
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
                      ) : null}
                    </div>
                  </section>
                </div>
              ) : null}
            </EventPresence>
            <TodoPanel snapshot={todoSnapshot} />
            {btwView ? (
              <BtwCard
                view={btwView}
                onAsk={(question) => handleSend(question, [], undefined, { btw: true })}
                onCancel={async () => {
                  if (btwView.requestId !== "pending") {
                    await chatsApi.btwCancel(chatId, btwView.requestId);
                  }
                }}
                onClear={async () => {
                  await chatsApi.btwClear(chatId);
                  setBtwView(null);
                }}
                onClose={async () => {
                  if (
                    btwView.requestId !== "pending" &&
                    (btwView.status === "starting" || btwView.status === "running")
                  ) {
                    await chatsApi.btwCancel(chatId, btwView.requestId);
                  }
                  setBtwView(null);
                }}
              />
            ) : null}
            <ComposerPlacement design={presentation === "design"} host={designComposerHost}>
              {questionnaire ? (
                <AskUserQuestionComposer
                  key={questionnaire.promptId}
                  prompt={questionnaire}
                  submitting={questionnaireSubmitting}
                  placement={presentation === "design" ? "design-conversation" : "chat"}
                  onRespond={answerQuestionnaire}
                />
              ) : (
                <Composer
                  // Keyed so the draft and attachments stay scoped to one chat. The
                  // route no longer remounts the pane, and Composer owns that text
                  // without a chatId reset of its own.
                  key={chatId}
                  placeholder={
                    presentation === "design"
                      ? designArtifacts.length > 0
                        ? "Describe the next change…"
                        : "Describe the interface you want to create…"
                      : undefined
                  }
                  ready={
                    ready &&
                    !imageArtifactRecoveryPending &&
                    !imageArtifactRecoveryUnavailable &&
                    (presentation !== "design" || !designWorkspaceDisabled)
                  }
                  readinessMessage={
                    presentation === "design" && designWorkspaceDisabled
                      ? designWorkspaceTitle
                      : imageArtifactRecoveryUnavailable
                        ? "Visual artifact staging is unavailable. Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair."
                        : imageArtifactRecoveryPending
                          ? "A visual artifact could not be recovered. Delete this chat to discard it before sending another message."
                          : readinessMessage
                  }
                  hasMessages={hasMessages}
                  chatId={chatId}
                  onSend={handleSend}
                  onStop={handleStop}
                  isGenerating={isGenerating}
                  canStopGeneration={canStopGeneration}
                  configurationBusy={thinkingSaving}
                  inputRef={composerRef}
                  placement={presentation === "design" ? "design-conversation" : "chat"}
                  onVisibilityRequirementChange={
                    presentation === "design" ? setDesignComposerRequiresVisibility : undefined
                  }
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
                  designContextItems={presentation === "design" ? designContextItems : undefined}
                  onRemoveDesignContextItem={removeDesignContextItem}
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
                  sideQuestionBlockedReason={sideQuestionBlockedReason}
                  slashSessionBlockedReason={
                    documentAppendReconciliationRequired
                      ? "Reload Aiden before copying this chat."
                      : imageArtifactRecoveryUnavailable
                        ? "Open Settings → About → Diagnostics and choose Reveal to locate the image staging file that needs repair."
                        : imageArtifactRecoveryPending
                          ? "Delete this chat to discard the unrecovered visual artifact before copying."
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
                  onCompactChat={() => chatsApi.compact(chatId)}
                  onCancelCompact={() => chatsApi.cancelCompact(chatId)}
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
                    ) : providerThinkingSupported ? (
                      <ThinkingControl
                        providerLabel={selectedProvider?.label ?? "Model"}
                        level={providerThinkingLevel}
                        levels={providerThinkingLevels}
                        canDisable={thinkingMetadata?.thinkingCanDisable !== false}
                        disabled={thinkingSaving || isStartingGeneration || isGenerating}
                        onChange={(level) => void changeProviderThinking(level)}
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
                      providers={settings.data ? (providers.data ?? []) : []}
                      providerId={providerId}
                      model={model}
                      onChange={select}
                      disabled={isGenerating || thinkingSaving}
                      settingsBlockedReason={settingsBlockedReason}
                      hiddenModelsByProvider={settings.data?.hiddenModelsByProvider}
                    />
                  }
                />
              )}
            </ComposerPlacement>
          </>
        }
      >
        {presentation === "design" ? (
          <div className="relative flex h-full min-h-0 overflow-hidden">
              <aside
                aria-label="Design Project conversation"
                aria-hidden={!designConversationOpen || undefined}
                inert={!designConversationOpen ? true : undefined}
                className={
                  designConversationOpen
                    ? "absolute inset-y-0 left-0 z-40 flex w-full max-w-[22rem] flex-col border-r border-separator bg-sidebar shadow-popover lg:relative lg:z-auto lg:shadow-none"
                    : "hidden"
                }
              >
                <div className="flex items-center justify-between border-b border-separator px-3 py-2">
                  <div>
                    <Text variant="small-strong">Conversation</Text>
                    <Text as="p" variant="small" color="tertiary">
                      Prompts, decisions, and artifact turns
                    </Text>
                  </div>
                  <Button
                    size="small"
                    variant="transparent"
                    disabled={designComposerMustStayOpen}
                    onClick={closeDesignConversation}
                    title={
                      designComposerMustStayOpen
                        ? "Finish or stop the active task before hiding Conversation"
                        : "Hide project conversation"
                    }
                  >
                    Hide
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {messages.length === 0 && displayedStreamingText === null ? (
                    <div className="p-4">
                      <Text variant="small" color="secondary">
                        Start with a prompt from the composer.
                      </Text>
                    </div>
                  ) : (
                    <MessageList
                      key={`design:${chatId}`}
                      chatId={chatId}
                      messages={messages}
                      streamingText={displayedStreamingText}
                      streamingReasoning={displayedStreamingReasoning}
                      streamingArtifacts={displayedStreamingArtifacts}
                      streamComplete={streamComplete || visibleDetachedProjection !== null}
                      onStreamHandoffComplete={() => streamHandoffRef.current?.()}
                      timeline={displayedGenerationTimeline}
                      liveSubagents={displayedLiveSubagents}
                      subagentsEnabled={environmentPanel.subagentsEnabled}
                      onOpenSubagent={environmentPanel.openSubagent}
                      agentActivity={visibleAgentActivity}
                      error={error}
                    />
                  )}
                </div>
                <div
                  ref={setDesignComposerHost}
                  className="shrink-0 border-t border-separator bg-sidebar"
                  aria-label="Design prompt composer"
                />
              </aside>
              <div className="min-w-0 flex-1">
                {chat.isLoading || providers.isLoading ? (
                  <div
                    className="flex min-h-full items-center justify-center"
                    aria-label="Loading Design"
                  >
                    <Text variant="small" color="secondary">
                      Loading Design…
                    </Text>
                  </div>
                ) : (
                  <DesignWorkspaceCanvas
                    chatId={chatId}
                    project={designProject}
                    workspaceId={generationWorkspaceId}
                    artifacts={designArtifacts}
                    generating={
                      isGenerating || isStartingGeneration || detachedGenerationDraining
                    }
                    initialMediaId={initialDesignMediaId}
                    unavailableMessage={designWorkspaceDisabled ? designWorkspaceTitle : undefined}
                    targets={designTargets}
                    sourceSelection={sourceDesignSelection}
                    selectedImages={designCanvasImages}
                    onTargetsChange={setDesignTargets}
                    onSourceSelectionChange={setSourceDesignSelection}
                    onSelectedImagesChange={setDesignCanvasImages}
                    onProjectChange={updateDesignProject}
                    onRequestComposerFocus={focusComposer}
                  />
                )}
              </div>
            </div>
        ) : chat.isLoading || providers.isLoading ? (
          <div
            className="flex min-h-full items-center justify-center"
            aria-label="Loading conversation"
          >
            <Text variant="small" color="secondary">
              Loading…
            </Text>
          </div>
        ) : messages.length === 0 && displayedStreamingText === null ? (
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
            key={chatId}
            chatId={chatId}
            messages={messages}
            streamingText={displayedStreamingText}
            streamingReasoning={displayedStreamingReasoning}
            streamingArtifacts={displayedStreamingArtifacts}
            streamComplete={streamComplete || visibleDetachedProjection !== null}
            onStreamHandoffComplete={() => streamHandoffRef.current?.()}
            timeline={displayedGenerationTimeline}
            liveSubagents={displayedLiveSubagents}
            subagentsEnabled={environmentPanel.subagentsEnabled}
            onOpenSubagent={environmentPanel.openSubagent}
            agentActivity={visibleAgentActivity}
            error={
              error ??
              (imageArtifactRecoveryUnavailable
                ? "Visual artifact staging is unavailable. Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair."
                : imageArtifactRecoveryPending
                  ? "A visual artifact could not be recovered. Delete this chat to discard it before continuing."
                  : null)
            }
          />
        )}
      </ScrollArea>
    </>
  );
}
