import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { PeerProjectCloneDialog } from "./peer-project-clone-dialog";
import { remoteNewChatDraftKey } from "../lib/hosts/remote-new-chat";
import {
  beginChatDraftSend,
  createChatDraft,
  discardChatDraft,
  finishChatDraftSend,
  getChatDraft,
  requestChatDraftComposerFocus,
  retainChatDraft,
  chatDraftWorktreeRequest,
  setChatDraftGitMode,
  setChatDraftHasContent,
  subscribeChatDraftComposerFocus,
  subscribeChatDrafts,
  updateChatDraft,
  updateChatDraftWorktree,
} from "../lib/chat-draft";
import { registerChatPromptTarget } from "../lib/chat-prompt-bridge";
import { resolveModelDisplay } from "../lib/model-display";
import {
  readChatDraftGitMemory,
  resolveDraftWorktreeDefaults,
  seedDraftWorktreeFromGitInfo,
} from "../lib/chat-draft-git-memory";
import {
  draftWorkInOptions,
  draftWorktreeHint,
  draftWorktreeSendBlocker,
  worktreeBaseNote,
} from "../lib/draft-git-menu";
import {
  activeWorktreeSend,
  continueWorktreeSendInView,
  isWorktreeSendCancelled,
  WorktreeSendCancelledError,
  registerWorktreeSendContinuation,
  startWorktreeFirstSend,
  subscribeActiveWorktreeSends,
  type WorktreeFirstSend,
} from "../lib/draft-worktree-send";
import { isValidBranchName, type FirstMessageWorktreeRequest } from "../shared/worktree-on-send";
import { localComputerNoun } from "../shared/computer-noun";
import type { GitBranchPickerDraft } from "../components/git-branch-picker";
import { QueuedMessages } from "../components/queued-messages";
import { NewChatHeadline } from "../components/new-chat-headline";
import type { WorkspaceMenuRequest } from "../components/workspace-picker";
import { registerDraftWorkspaceMenu, type DraftWorkspaceMenuView } from "../lib/draft-workspace-menu";
import { adoptWorkspace } from "../lib/use-workspace-path-intake";
import { workspaceChangeBusyReason } from "../lib/workspace-menu";
import {
  discardComposerDraft,
  getActiveWorktreeGrabbedElements,
  loadComposerDraft,
  restoreUnsentMessage,
  saveComposerDraftText,
  seedComposerAttachments,
  seedComposerGrabbedElements,
  setActiveWorktreeGrabbedElements,
  stageComposerText,
} from "../lib/composer-draft-store";
import {
  withoutGrabbedElementThumbnails,
  type GrabbedElementContextV1,
} from "../shared/browser-element-grab";
import { attachmentsWithBytes } from "../lib/stored-attachments";
import { reduceVisualDrafts, type VisualDrafts } from "../lib/html-artifact-transcript";
import { reduceUiDrafts, reduceUiVisuals, type UiDrafts } from "../lib/ui-visual-transcript";
import type { ChatUiVisualV1 } from "../shared/aiden-ui/types";
import { primeInlineVisualPreview, type GuestPromptHandler } from "../components/html-artifact-frame";
import { forkSummaryHoldsSend, type ChatForkPosition } from "../shared/chat-copy-contract";
import { ForkSummaryCard, ForkSummaryDialog } from "../components/fork-summary-card";
import {
  admitRunInputOnceStarted,
  chatMessageQueue,
  committedRunInputNotice,
  steerQueuedMessage,
  steerDraftOrQueue,
  lateSteerQueuedNotice,
  steerRejectionMessage,
  withCommittedRunInput,
} from "../lib/chat-message-queue";
import { MAX_RUN_INPUT_TEXT } from "../shared/chat-run-input";
import { useChatMessageQueue } from "../lib/use-chat-message-queue";
// The active chat: transcript (ScrollArea) + composer. Generation runs inline
// against a concrete chatId in the active workspace, streams tokens via
// startGeneration, and surfaces tool-approval prompts when the workspace is in
// "ask" mode.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { retryUsageLimitNow, useUsageLimitNow, useUsageLimitWait } from "../lib/use-usage-limit-wait";
import { useSpendingStatus } from "../lib/use-spending-status";
import { SpendingLimitNotice } from "../components/spending/spending-limit-notice";
import { ChatGoalBar } from "../components/goal-bar";
import { spendingNotice } from "../shared/spending";
import { hookMessagesNotice } from "../shared/hooks-settings";
import { useMarkChatRead } from "../lib/use-mark-chat-read";
import { localHostAdapter } from "../lib/hosts/local-host-adapter";
import { useObservedLocalRun } from "../lib/hosts/use-observed-local-run";
import { useActiveChatIds } from "../lib/use-chat-activity";
import { useChatSession } from "../lib/hosts/use-chat-session";
import { LOCAL_HOST_ID } from "../shared/peer-host";
import { replaceEqualDeep, useQuery, useQueryClient } from "@tanstack/react-query";
import { WorkspaceFolderMissingNotice } from "../components/workspace-folder-missing-notice";
import {
  MANAGED_WORKTREE_MISSING_SEND_REFUSAL,
  WORKSPACE_FOLDER_MISSING_SEND_REFUSAL,
  workspaceFolderCheckApplies,
  type WorkspaceFolderPresenceResult,
} from "../shared/workspace-folder-presence";
import { useOptionalNewChatActions } from "../lib/new-chat-actions";
import {
  Badge,
  Button,
  DismissHoverSurfaces,
  EmptyState,
  ScrollArea,
  ScrollAreaFooterStack,
  Text,
  toast,
} from "../components/ui";
import {
  agentsInstructionNoticeMessage,
  createAgentsInstructionNoticeLog,
} from "../shared/agents-instructions-notice";
import { CONNECT_PROVIDER_ACTION, PROVIDER_SETTINGS_LABEL } from "../lib/provider-setup-copy";
import {
  chatReadinessMessage as chatReadinessMessageFor,
  DENIED_APPROVAL_COMPOSER_PLACEHOLDER,
} from "../lib/composer-placeholder";
import {
  AppWindow,
  GitFork,
  TerminalSquare,
  MessagesSquare,
} from "lucide-react";
import { MessageList } from "../components/message-list";
import { KeepVisualChatContext } from "../lib/visual-menu-actions";
import { useReadAloud } from "../lib/tts-client";
import type { ReadAloudActionProps } from "../components/read-aloud-button";
import { Composer, type ComposerApprovalsPatch } from "../components/composer";
import { AskUserQuestionComposer } from "../components/ask-user-question-composer";
import { DesignModeConsentCard, useDesignModeConsent } from "../design/design-mode-consent";
import { useCanvasFocusRequests } from "../design/canvas-focus-requests";
import { designCanvasViewFor } from "../lib/design-mode";
import {
  AskUserQuestionCountdown,
  AskUserQuestionExpiryNotice,
} from "../components/ask-user-question-expiry-notice";
import {
  ComposerFloatingRow,
  composerFloatingRowOffsets,
  useHeldFloatingRowHeight,
  TodoPanel,
  todoPanelHasVisibleChrome,
} from "../components/todo-panel";
import { revealSubagentRunInTranscript } from "../components/subagent-chips";
import {
  onScreenSubagentGroupElement,
  setSubagentGroupBottomInset,
  useSubagentGroupOnScreen,
} from "../lib/subagent-group-visibility";
import {
  SubagentComposerPill,
  useSubagentComposerPill,
} from "../components/subagent-composer-pill";
import { BtwCard, reduceBtwView, type BtwLiveView } from "../components/btw-card";
import { ModelPicker } from "../components/model-picker";
import { AgentModelPopover } from "../components/agent-model-popover";
import { agentSliderComposerState, agentSliderStepTarget, agentSliderStopSetsEffort } from "../lib/agent-slider-view";
import { RemoteMachinePicker } from "../components/remote-new-chat-pickers";
import { useNewChatMachines } from "../lib/hosts/use-new-chat-machines";
import {
  ChatTitleMenu,
  DesignModeToggle,
  DesignPaneSwitch,
  WorkspaceChip,
  WorkspaceToolButtons,
} from "../components/chat-top-bar";
import { AttachWorkspaceDialog } from "../components/attach-workspace-dialog";
import { OpenInEditorPicker } from "../components/open-in-editor-picker";
import { DesignModeBannerSlot, useDesignChatBodyHidden } from "../design/design-layout";
import { useCommandHandler, useCommandSystem, useShortcutBinding, useShortcutLabel } from "../lib/command-system";
import { useComposerTypeFocus } from "../lib/use-composer-type-focus";
import {
  approvalShouldTakeFocus,
  isEditableTypingTarget,
  isReservedTypingSurface,
  typingRedirectBlockedByOverlay,
} from "../lib/composer-type-focus";
import { returnFocus } from "../lib/focus-return";
import { ariaKeyShortcut } from "../shared/keybindings";
import type { ToolApprovalScope } from "../shared/tool-approval-scope";
import { isModelHidden } from "../shared/model-visibility";
import { ThinkingControl } from "../components/thinking-control";
import { APPEARANCE_CHANGE_EVENT, readCachedAppearance } from "../lib/appearance-runtime";
import { ContextMeter } from "../components/context-meter";
import { ContextPressureFeed } from "../lib/context-pressure-feed";
import type { ChatContextPressureV1 } from "../shared/context-pressure";
import { ReasoningVisibilityControl } from "../components/reasoning-visibility-control";
import { ApprovalStatusLine, ChatApprovalCard, revealApprovalCard } from "../components/chat-approval-card";
import { noteWorkspaceAllow, repeatableApproval, useWorkspaceRepeatNudge } from "../lib/switch-to-auto";
import { useApprovalStatusLine } from "../lib/use-approval-status-line";
import { isComputerUseAccessApprovalDetails } from "../shared/computer-use-access";
import { liveOpenChat } from "../lib/live-open-chat";
import {
  useLiveApprovalVoiceHint,
  usePublishLiveChatApprovals,
} from "../components/assistant/use-live-chat-voice-approvals";
import { liveChatReachable, stopForLive, useLiveChatController } from "./live-chat-controller";
import { useReportGoalView } from "../lib/use-report-goal-view";
import type { ChatInputSourceV1 } from "../shared/chat-input-source";
import { ComputerUseContinueCallout } from "../components/computer-use-access-approval";
import {
  attachGenerationStream,
  chatsApi,
  aidenRemoteApi,
  claimChatHandoff,
  createChatTurnId,
  goalRoundStart,
  createGenerationStreamBuffer,
  detachHandoffStream,
  settingsApi,
  startGeneration,
  gitApi,
  workspacesApi,
  type ApprovalPrompt,
  type GenerationHandle,
  type StreamCallbacks,
} from "../lib/ipc";
import {
  consumePendingChatHandoff,
  subscribePendingChatHandoff,
} from "../lib/chat-handoff-bridge";
import { isNoWorkspace, noWorkspaceHome } from "../lib/no-workspace";
import { continueInWorkspaceChoices } from "../lib/new-chat-workspaces";
import { noWorkspaceFolderForFirstSend } from "../lib/no-workspace-send";
import {
  queryKeys,
  installAppendedChatSnapshot,
  logoutBuiltinProvider,
  markChatRecentlyPromoted,
  refreshCodexProviderState,
  upsertCreatedWorkspaceInCache,
  useAllRegularChats,
  useChat,
  useGitInfo,
  useModelInfo,
  useProviders,
  useSettings,
} from "../lib/queries";
import { forkedFromLabel, withForkLineage } from "../lib/chat-copy-view";
import { fromLeadChatLabel, startedByChatLabel } from "../lib/chat-lineage";
import {
  chatModelSelection,
  isModelSelectionReadyForNewWork,
  resolveVisibleModelSelection,
  setActiveChatModelTarget,
  useModelSelection,
} from "../lib/use-model-selection";
import { turnThinkingLevel } from "../lib/turn-thinking-level";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useWorkspaceTerminal } from "../components/terminal-drawer";
import {
  EnvironmentPanelToggle,
  QuickViewIcon,
  QuickViewToggle,
  useEnvironmentPanelCore,
} from "../components/environment-panel";
import { EventPresence } from "../components/event-presence";
import {
  OPENAI_CODEX_PROVIDER_ID,
  type AppSettings,
  type Attachment,
  type Chat,
  type ChatMeta,
  type GitBranches,
  type GitInfo,
  type Workspace,
} from "../lib/types";
import { COMPUTER_USE_CONTINUE_PROMPT } from "../shared/computer-use-access";
import { userFacingErrorMessage } from "../lib/ipc-error";
import { PROVIDER_FAILURE_FOLLOW_UPS, type ProviderFailureAction } from "../shared/provider-failure";
import {
  formatRecoveredAskUserQuestionAnswers,
  INTERRUPTED_REPLY_FOLLOW_UP,
  type InterruptedWaitV1,
} from "../shared/interrupted-reply";
import type { CompactionEngine } from "../shared/compaction";
import {
  resolveAgentActivity,
  resolveVisibleAgentActivity,
  type ToolActivity,
} from "../lib/agent-activity";
import { STREAMING_REVEAL_FALLBACK_MS } from "../lib/streaming-reveal";
import { liveAssistantPresentationRows } from "../lib/assistant-message-presentation";
import { isLatestRemoteApprovalRefresh, mergeRemoteApproval } from "../lib/remote-approval";
import {
  hasActiveThinkingStep,
  hasActiveToolStep,
  isToolStep,
  latestActiveAgentStep,
  type GenerationTimeline,
} from "../shared/generation-timeline";
import { GOOGLE_PROVIDER_ID } from "../shared/google-provider";
import { RENDER_ARTIFACT_TOOL_NAME, RENDER_UI_TOOL_NAME } from "../shared/generative-ui";
import {
  CODEX_THINKING_LEVELS,
  normalizeCodexThinkingLevel,
  type CodexThinkingLevel,
} from "../shared/codex-thinking";
import {
  GOOGLE_THINKING_LEVELS,
  googleThinkingLevelsForModel,
  normalizeGoogleThinkingLevel,
  type GoogleThinkingLevel,
} from "../shared/google-thinking";
import {
  ANTHROPIC_THINKING_LEVELS,
  normalizeAnthropicThinkingLevel,
  type AnthropicThinkingLevel,
} from "../shared/anthropic-thinking";
import { normalizeProviderThinkingLevel } from "../shared/provider-thinking";
import { customModelThinkingLevels } from "../shared/custom-model-options";
import {
  isGenerationThinkingLevel,
  type GenerationThinkingLevel,
} from "../shared/generation-thinking";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import type { SkillInvocationV1 } from "../shared/slash-commands";
import { mergeSubagentSnapshots } from "../lib/subagent-view-state";
import {
  foldLiveSubagentTranscript,
  type LiveSubagentTranscripts,
  type SubagentTranscriptUpdateV1,
} from "../shared/subagent-transcript";
import {
  combineLiveSubagentTranscripts,
  type MainChatWaitingKind,
  useSubagentHelperChatSelector,
  useSubagentHelperChatStore,
} from "../lib/subagent-helper-chat-store";
import { ExpandedSubagentHelperChat } from "../components/subagent-helper-chat-expanded";
import {
  withSubagentApprovalWaitSnapshots,
  withSubagentApprovalWaitViews,
} from "../lib/subagent-helper-chat-state";
import { focusRegion } from "../lib/focus-regions";
import { visibleSubagentReferences } from "../lib/subagent-feature-gate";
import { persistedChatWorkspaceId } from "../shared/chat-workspace";
import {
  detachedTextStreamingRemaining,
  detachedLifecycleChatProjection,
  detachedProjectionStreamComplete,
  isDetachedLifecycleChatDraining,
  subscribeDetachedLifecycleStreams,
  visibleDetachedLifecycleProjection,
} from "../lib/chat-terminal-sync";
import {
  ASSISTANT_WORKSPACE_ID,
} from "../shared/assistant";
import { isAppendReconciliationRequired } from "../shared/chat-message-contract";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";
import { isLocalProviderDeployment } from "../shared/provider-deployment";
import type { ChatArtifactV1 } from "../shared/chat-artifacts";
import { useAppCapabilities } from "../lib/app-capabilities";
import { useAidenMcpChatProvenance } from "../lib/aiden-mcp";
import {
  ASK_USER_QUESTION_VERSION,
  askUserQuestionMsUntilExpiry,
  formatLateAskUserQuestionFollowUp,
  retainExpiredAskUserQuestionForLateAnswer,
  type AskUserQuestionPromptV1,
  type AskUserQuestionResponseV1,
} from "../shared/ask-user-question";
import { TodoSnapshotReadFence, type TodoSnapshotViewV1 } from "../shared/todo";
import type { BtwEventV1 } from "../shared/btw";
import type { ModelCallRetryView } from "../shared/model-call-retry";
import {
  acpHarnessChatReason,
  acpHarnessReadinessMessage,
  isAcpHarnessProvider,
  type AcpHarnessBlockedSurface,
} from "../shared/acp-harness";
import { useChatFind } from "../components/chat-find-bar";

const ANTHROPIC_PROVIDER_ID = "anthropic";

/**
 * How long after the last text delta the activity row may keep saying
 * "Responding…". Beyond this the model is reasoning or writing tool-call
 * arguments, and the row should shimmer instead of going static; wide enough
 * that bursty providers do not flap the label mid-prose.
 */
const TEXT_STREAMING_IDLE_MS = 2_000;
/** Stable so idle frames don't rebuild the transcript artifact plan. */
const NO_STREAMING_ARTIFACTS: ChatArtifactV1[] = [];
const NO_UI_VISUALS: readonly ChatUiVisualV1[] = [];
const NO_LIVE_SUBAGENT_TRANSCRIPTS: LiveSubagentTranscripts = new Map();
const NO_UI_DRAFTS: UiDrafts = new Map();
const NO_VISUAL_DRAFTS: VisualDrafts = new Map();
// AGENTS.md size notices are shown once per chat until the file changes.
const agentsInstructionNotices = createAgentsInstructionNoticeLog();

const defaultGoogleThinkingLevels = () => googleThinkingLevelsForModel({ reasoning: true });

function useDeclaredThinkingLevels<T extends string>(
  allLevels: readonly T[],
  declared: readonly string[] | undefined,
  fallback?: () => T[],
  ensureLevel?: T,
): T[] {
  return React.useMemo(() => {
    if (!declared?.length) return fallback ? fallback() : [];
    const supported = allLevels.filter((level) => declared.includes(level));
    return ensureLevel !== undefined && !supported.includes(ensureLevel)
      ? [ensureLevel, ...supported]
      : supported;
  }, [allLevels, declared, fallback, ensureLevel]);
}

export function ChatPane({ chatId }: { chatId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const commandSystem = useCommandSystem();
  const capabilities = useAppCapabilities();
  const newChatMachines = useNewChatMachines();
  const providers = useProviders();
  const documentAppendReconciliationRequired = useAppendReconciliationRequired();
  const draft = React.useSyncExternalStore(subscribeChatDrafts, () => getChatDraft(chatId));
  const persistedChat = useChat(draft ? undefined : chatId);
  // Control (rename, stop, approvals, questions, steer) goes through the same
  // session the remote pane uses; local turns still stream through startGeneration.
  const { control: chatControl } = useChatSession(localHostAdapter, { hostId: LOCAL_HOST_ID, chatId });
  // Draft projection stays out of the query cache and every persisted chat list.
  const chat = draft
    ? { ...persistedChat, data: draft.chat, isLoading: false, isError: false }
    : persistedChat;
  React.useEffect(() => retainChatDraft(chatId), [chatId]);
  useMarkChatRead(draft ? undefined : chatId, draft ? undefined : persistedChat.data?.messages);
  // Opening a chat clears its Unavailable prompts (the run that raised them is
  // gone). A dismissal that drops any broadcasts a new activity revision, which
  // the Inbox's waits query keys on.
  const openedDraft = Boolean(draft);
  React.useEffect(() => {
    if (openedDraft) return;
    void Promise.resolve()
      .then(() => chatsApi.dismissDetachedAttention(chatId))
      .catch(() => {
        // The row keeps reading Unavailable until the next change event.
      });
  }, [chatId, openedDraft]);
  // A Bot's conversation lives at its own route, rendered from the live projection.
  const botChatId = chat.data?.botId;
  React.useEffect(() => {
    if (!botChatId) return;
    void navigate({ to: "/bots/$botId/chat", params: { botId: botChatId }, replace: true });
  }, [botChatId, navigate]);
  const settings = useSettings();
  const computerUseGloballyEnabled =
    capabilities.computerUse && settings.data?.computerUseEnabled === true;
  const { activeId, workspaces, select: selectWorkspace } = useActiveWorkspace();
  const [appendReconciliationRequiredChats, setAppendReconciliationRequiredChats] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  const chatWorkspaceId = chat.data?.workspaceId;
  const effectiveWorkspaceId = chat.data ? persistedChatWorkspaceId(chatWorkspaceId) : undefined;
  const effectiveWorkspace = workspaces.find((workspace) => workspace.id === effectiveWorkspaceId);
  // Settled native visuals here can be kept in this workspace's Artifacts.
  const keepVisualChatId =
    chat.data && !chat.data.botId && !chat.data.owner && effectiveWorkspace && effectiveWorkspaceId !== ASSISTANT_WORKSPACE_ID
      ? chatId
      : null;
  const effectiveWorkspaceIdRef = React.useRef(effectiveWorkspaceId);
  effectiveWorkspaceIdRef.current = effectiveWorkspaceId;
  // A moved or deleted folder is named above the composer, and a send is
  // refused before it reaches the agent (main refuses it again at start).
  const folderWorkspaceId =
    effectiveWorkspace && workspaceFolderCheckApplies(effectiveWorkspace) ? effectiveWorkspace.id : undefined;
  const folderPresenceQuery = useQuery({
    queryKey: queryKeys.workspaceFolderPresence(folderWorkspaceId ?? ""),
    queryFn: () => workspacesApi.folderPresence(folderWorkspaceId!),
    enabled: folderWorkspaceId !== undefined,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
  const missingWorkspaceFolder =
    folderWorkspaceId !== undefined && folderPresenceQuery.data?.presence === "missing"
      ? {
          id: folderWorkspaceId,
          name: effectiveWorkspace!.name,
          folder: folderPresenceQuery.data.folder,
          worktree: folderPresenceQuery.data.worktree,
        }
      : undefined;
  // A deleted Aiden-managed worktree: put it back on its branch, or carry the
  // unsent message to a new chat in the main checkout.
  const newChatActions = useOptionalNewChatActions();
  const [restoringWorktree, setRestoringWorktree] = React.useState(false);
  const restoreDeletedWorktree = React.useCallback(
    async (workspaceId: string) => {
      setRestoringWorktree(true);
      try {
        await workspacesApi.restoreDeletedWorktree(workspaceId);
        await Promise.all([
          qc.invalidateQueries({ queryKey: queryKeys.workspaces }),
          qc.invalidateQueries({ queryKey: queryKeys.workspaceFolderPresence(workspaceId) }),
        ]);
        toast.success("Worktree restored. You can send again.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "The worktree could not be restored.");
        // A refused or rolled-back restore can still leave a folder in place,
        // so the notice must follow what is on disk now.
        void qc.invalidateQueries({ queryKey: queryKeys.workspaceFolderPresence(workspaceId) });
      } finally {
        setRestoringWorktree(false);
      }
    },
    [qc],
  );
  const newChatInMainCheckout = React.useCallback(
    (mainWorkspaceId: string) => {
      if (!newChatActions) return;
      // A send refused by the folder check may be waiting in the paused queue
      // with the composer already cleared.
      const initialText = (
        loadComposerDraft(chatId).text.trim() || chatMessageQueue(chatId).getSnapshot().messages[0]?.text || ""
      ).trim();
      void newChatActions
        .openNewChatIn(mainWorkspaceId, { gitMode: "checkout", ...(initialText ? { initialText } : {}) })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Couldn't start a new chat.");
        });
    },
    [chatId, newChatActions],
  );
  const folderWorkspaceRef = React.useRef<{ id: string; name: string } | undefined>(undefined);
  folderWorkspaceRef.current = folderWorkspaceId ? { id: folderWorkspaceId, name: effectiveWorkspace!.name } : undefined;
  // Agent-backed models need someone answering approvals in an ordinary chat.
  const agentBlockedSurface: AcpHarnessBlockedSurface | undefined =
    chat.data?.botId ? "bot" : effectiveWorkspaceId === ASSISTANT_WORKSPACE_ID ? "assistant" : undefined;
  const sideQuestionBlockedReason = draft
    ? "Send the first message before asking a side question."
    : effectiveWorkspaceId === ASSISTANT_WORKSPACE_ID
        ? "Side questions are not available in Assistant chats."
        : isAcpHarnessProvider(chat.data?.providerId ?? "")
          ? "Side questions are not available with agent-backed models."
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
  const visibleDetachedProjection = visibleDetachedLifecycleProjection(detachedProjection, chat.data?.messages);
  // Run input is admitted only for the document that owns the run, so a
  // mirrored run (a phone's turn) offers Stop and queueing but not Steer.
  const observedRunVisible = visibleDetachedProjection?.observed === true;
  const steerableDetachedProjection = observedRunVisible ? null : visibleDetachedProjection;
  const terminal = useWorkspaceTerminal();
  const git = useGitInfo(effectiveWorkspace?.id);
  const environmentPanel = useEnvironmentPanelCore();
  const designChatBodyHidden = useDesignChatBodyHidden();
  const transcriptUnderFloatingPanel =
    environmentPanel.surfaceMode === "tools-floating" && environmentPanel.toolsPresented;
  const settingsBlockedReason = environmentPanel.gitOperationBusy
    ? "Wait for the current Git operation to finish"
    : environmentPanel.editorState.saving
      ? "Wait for the open file to finish saving"
      : environmentPanel.editorState.dirty
        ? "Save or discard the open file's edits first"
        : undefined;
  const appModel = useModelSelection(
    providers.data,
    settings.data?.hiddenModelsByProvider,
    settings.data !== undefined,
  );
  const hasMessages = (chat.data?.messages.length ?? 0) > 0;
  // A chat with messages owns its model: picking one here changes this chat
  // only. An empty chat follows, and sets, the app's model for new chats.
  const chatOwnsModel = !draft && hasMessages && !chat.data?.botId;
  const { providerId, model, thinkingLevel: selectionThinkingLevel } = chatModelSelection(
    chat.data,
    chatOwnsModel,
    appModel,
  );
  const selectAppModel = appModel.select;
  // The latest pick per chat, so an older pick's answer never replaces a newer one.
  const chatModelPicksRef = React.useRef(new Map<string, number>());
  // `level`: an Agent Slider stop's effort (null or a stop without one clears
  // the chat's own level); left out, a list pick keeps the level only while
  // the model stays the same.
  const select = React.useCallback(
    (nextProviderId: string, nextModel: string, level?: GenerationThinkingLevel | null) => {
      if (!chatOwnsModel) {
        selectAppModel(nextProviderId, nextModel, level ?? undefined);
        return;
      }
      const key = queryKeys.chat(chatId);
      const pick = (chatModelPicksRef.current.get(chatId) ?? 0) + 1;
      chatModelPicksRef.current.set(chatId, pick);
      const isLatestPick = () => chatModelPicksRef.current.get(chatId) === pick;
      // A chat's own level belongs to its model, so it travels with the pair.
      const withModel =
        (pair: Pick<Chat, "providerId" | "model" | "thinkingLevel">) => (current: Chat | null | undefined) => {
          if (!current) return current;
          const { thinkingLevel: _replaced, ...rest } = current;
          return {
            ...rest,
            providerId: pair.providerId,
            model: pair.model,
            ...(pair.thinkingLevel ? { thinkingLevel: pair.thinkingLevel } : {}),
          };
        };
      const previous = qc.getQueryData<Chat | null>(key);
      void (async () => {
        // A read started before this pick must not land on top of it.
        await qc.cancelQueries({ queryKey: key, exact: true });
        if (!isLatestPick()) return;
        const current = qc.getQueryData<Chat | null>(key);
        const sameModel = current?.providerId === nextProviderId && current?.model === nextModel;
        qc.setQueryData<Chat | null>(
          key,
          withModel({
            providerId: nextProviderId,
            model: nextModel,
            thinkingLevel:
              level === undefined ? (sameModel ? current?.thinkingLevel : undefined) : (level ?? undefined),
          }),
        );
        try {
          const saved = await chatsApi.setModel(chatId, nextProviderId, nextModel, level);
          // A read that overlapped the save may still carry the old model.
          if (saved && isLatestPick()) qc.setQueryData<Chat | null>(key, withModel(saved));
          void qc.invalidateQueries({ queryKey: queryKeys.chats });
        } catch (error) {
          if (isLatestPick() && previous) qc.setQueryData<Chat | null>(key, withModel(previous));
          toast.error(error instanceof Error ? error.message : "This chat's model could not be changed.");
        }
      })();
    },
    [chatId, chatOwnsModel, qc, selectAppModel],
  );
  React.useEffect(() => {
    if (!chatOwnsModel) return;
    return setActiveChatModelTarget({ chatId, selection: { providerId, model }, select });
  }, [chatId, chatOwnsModel, model, providerId, select]);
  const selectedProvider = providers.data?.find((provider) => provider.id === providerId);
  const modelReady = Boolean(
    selectedProvider &&
    isModelSelectionReadyForNewWork(
      { providerId, model },
      providers.data,
      settings.data?.hiddenModelsByProvider,
      hasMessages,
    ) &&
    (selectedProvider.hasKey || !selectedProvider.needsKey) &&
    !acpHarnessChatReason(selectedProvider.id, selectedProvider.label, agentBlockedSurface),
  );
  // Assistant and Bot chats do not offer agent-backed models at all.
  const pickerProviders = React.useMemo(
    () =>
      !settings.data
        ? []
        : agentBlockedSurface
          ? (providers.data ?? []).filter((provider) => !isAcpHarnessProvider(provider.id))
          : (providers.data ?? []),
    [agentBlockedSurface, providers.data, settings.data],
  );
  // On an Agent Slider stop with its own effort the stop sets it, so the
  // effort control hides; a stop without one, and Custom, show it as before.
  const agentSlider = settings.data?.agentSlider;
  const agentSliderState = React.useMemo(
    () =>
      agentSliderComposerState(
        agentSlider,
        { providers: pickerProviders, hiddenModelsByProvider: settings.data?.hiddenModelsByProvider },
        { providerId, model, thinkingLevel: selectionThinkingLevel },
      ),
    [agentSlider, pickerProviders, settings.data?.hiddenModelsByProvider, providerId, model, selectionThinkingLevel],
  );
  const stopSetsEffort = agentSliderStopSetsEffort(agentSliderState);
  const modelReadinessMessage = React.useMemo(() => {
    if (providers.isLoading) return "Loading chat models…";
    if (!selectedProvider) {
      return providerId === OPENAI_CODEX_PROVIDER_ID
        ? "Sign in with ChatGPT in Settings → Providers to use Codex."
        : "Choose a chat model, or add one in Settings → Providers.";
    }
    const agentReason = acpHarnessReadinessMessage(selectedProvider, agentBlockedSurface);
    if (agentReason) return agentReason;
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
  }, [agentBlockedSurface, hasMessages, model, providerId, providers.isLoading, selectedProvider, settings.data]);
  const chatReadinessMessage = chatReadinessMessageFor({
    loading: chat.isLoading,
    failed: chat.isError,
    missing: !chat.data,
    appendReconciliationRequired:
      documentAppendReconciliationRequired || appendReconciliationRequiredChats.has(chatId),
    drainingWithoutProjection: detachedGenerationDraining && !visibleDetachedProjection,
  });
  // Until Git status is known a New worktree draft can't tell whether it can
  // make one; it waits rather than quietly sending in this checkout. (A draft
  // in an existing worktree always runs there as it is.)
  const draftGitPending = draft
    ? draftWorktreeSendBlocker({
        gitMode: draft.gitMode,
        sending: draft.sending,
        baseRef: draft.worktree?.baseRef,
        inManagedWorktree: Boolean(effectiveWorkspace?.managedWorktree),
        gitLoading: git.isLoading,
        isRepo: git.data?.isRepo === true,
        unborn: git.data?.unborn === true,
        accessOff: effectiveWorkspace?.permission === "none",
      })
    : undefined;
  // A chat over its spending limit sends nothing until the person allows more.
  const spending = useSpendingStatus("chat", draft ? undefined : chatId);
  const spendingReached = spending.status?.state === "reached" ? spendingNotice(spending.status)?.title : undefined;
  const ready = modelReady && !chatReadinessMessage && !draftGitPending && !spendingReached;
  const readinessMessage = chatReadinessMessage ?? draftGitPending ?? spendingReached ?? modelReadinessMessage;

  const providerModels = React.useMemo(
    () => providers.data?.find((p) => p.id === providerId)?.models ?? [],
    [providers.data, providerId],
  );
  const modelInfo = useModelInfo(providerId, providerModels, selectedProvider);
  const visionSupported = model ? modelInfo.data?.[model]?.vision : undefined;

  // Composer context meter: the runtime's next-request projection, refreshed
  // on the ambient triggers (open, model change, settle, draft typing) and
  // pushed live during a generation via chat:context-pressure.
  const showComposerContextUsage = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => { window.addEventListener(APPEARANCE_CHANGE_EVENT, listener); return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, listener); }, []),
    () => readCachedAppearance()?.showComposerContextUsage ?? true,
    () => true,
  );
  const [contextPressure, setContextPressure] = React.useState<ChatContextPressureV1 | null>(null);
  // The latest reading without the draft, and its chat, for compacting on
  // return to an expired cache: a pasted draft is not history compaction can
  // shrink, and a chat switch must never judge the new chat by the old one.
  const [contextHistory, setContextHistory] = React.useState<{
    chatId: string | null;
    pressure: ChatContextPressureV1 | null;
  }>({ chatId: null, pressure: null });
  const [contextCompactPending, setContextCompactPending] = React.useState(false);
  const [contextCompactedFlash, setContextCompactedFlash] = React.useState(false);
  const contextCompactedTimerRef = React.useRef<number | null>(null);
  type ContextDraft = { draftText?: string; attachments?: Attachment[] };
  const contextFetchRef = React.useRef<
    (chatId: string, visibleDraft?: ContextDraft) => Promise<ChatContextPressureV1 | null>
  >(async () => null);
  contextFetchRef.current = (targetChatId, visibleDraft) =>
    chatsApi.contextPressure(targetChatId, { ...visibleDraft, providerId, modelId: model });
  const [contextFeed] = React.useState(
    () =>
      new ContextPressureFeed<ContextDraft>({
        fetch: (targetChatId, visibleDraft) => contextFetchRef.current(targetChatId, visibleDraft),
        publish: setContextPressure,
        publishHistory: (pressure, owner) => setContextHistory({ chatId: owner, pressure }),
      }),
  );
  // ChatPane stays mounted across chat navigation (see chat-transition tests),
  // so drop the previous chat's reading, compaction chrome and pending timers
  // before the new chat paints; the feed voids in-flight ambient responses.
  React.useLayoutEffect(() => {
    contextFeed.showChat(draft ? null : chatId);
    setContextCompactPending(false);
    setContextCompactedFlash(false);
    if (contextCompactedTimerRef.current !== null) {
      window.clearTimeout(contextCompactedTimerRef.current);
      contextCompactedTimerRef.current = null;
    }
  }, [contextFeed, chatId, draft]);
  React.useEffect(
    () => chatsApi.onContextPressure((eventChatId, pressure) => contextFeed.pushed(eventChatId, pressure)),
    [contextFeed],
  );
  React.useEffect(
    () => () => {
      contextFeed.dispose();
      if (contextCompactedTimerRef.current !== null) {
        window.clearTimeout(contextCompactedTimerRef.current);
      }
    },
    [contextFeed],
  );
  const cloneDraftRef = React.useRef<{
    text: string;
    attachments: Attachment[];
    grabbedElements: GrabbedElementContextV1[];
  }>({ text: "", attachments: [], grabbedElements: [] });
  const onDraftContextChange = React.useCallback(
    (
      value: string,
      draftAttachments: Attachment[],
      draftGrabbedElements: GrabbedElementContextV1[] = [],
    ) => {
      cloneDraftRef.current = {
        text: value,
        attachments: draftAttachments,
        grabbedElements: draftGrabbedElements,
      };
      const draftText = value.trim() ? value : undefined;
      const attachments = draftAttachments.length ? draftAttachments : undefined;
      contextFeed.draftChanged(draftText || attachments ? { draftText, attachments } : undefined);
      // New-chat entry points reuse only a draft whose composer is empty.
      setChatDraftHasContent(chatId, Boolean(draftText || attachments || draftGrabbedElements.length));
    },
    [chatId, contextFeed],
  );
  const googleThinkingSupported =
    providerId === GOOGLE_PROVIDER_ID &&
    Boolean(model) &&
    modelInfo.data?.[model]?.reasoning === true;
  const thinkingMetadata = model ? selectedProvider?.modelMetadata?.[model] : undefined;
  const googleThinkingLevels = useDeclaredThinkingLevels(
    GOOGLE_THINKING_LEVELS,
    thinkingMetadata?.thinkingLevels,
    defaultGoogleThinkingLevels,
    "off",
  );
  const storedGoogleThinkingLevel = model
    ? settings.data?.googleThinkingByModel?.[model]
    : undefined;
  const googleThinkingLevel = normalizeGoogleThinkingLevel(
    googleThinkingLevels,
    storedGoogleThinkingLevel,
  );
  const codexThinkingLevels = useDeclaredThinkingLevels(
    CODEX_THINKING_LEVELS,
    thinkingMetadata?.thinkingLevels,
  );
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
  const anthropicThinkingLevels = useDeclaredThinkingLevels(
    ANTHROPIC_THINKING_LEVELS,
    thinkingMetadata?.thinkingLevels,
  );
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
    if (selectedProvider?.kind === "openai") {
      const custom = customModelThinkingLevels(thinkingMetadata?.overrides);
      if (custom) return custom;
    }
    const declared = thinkingMetadata?.thinkingLevels;
    return declared?.filter(isGenerationThinkingLevel) ?? [];
  }, [selectedProvider?.kind, thinkingMetadata?.overrides, thinkingMetadata?.thinkingLevels]);
  const providerThinkingSupported =
    (selectedProvider?.isBuiltin === true ||
      (selectedProvider?.kind === "openai" &&
        customModelThinkingLevels(thinkingMetadata?.overrides) !== undefined)) &&
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
      React.startTransition(() => {
        selectWorkspace(effectiveWorkspaceId);
      });
    }
  }, [activeId, chat.data, effectiveWorkspaceId, selectWorkspace]);

  React.useEffect(() => {
    if (!chat.data || effectiveWorkspace) return;
    if (terminal.open) terminal.toggle();
    environmentPanel.closeAll();
  }, [chat.data, effectiveWorkspace, environmentPanel.closeAll, terminal.open, terminal.toggle]);

  const [streamingText, setStreamingText] = React.useState<string | null>(null);
  const [streamingReasoning, setStreamingReasoning] = React.useState<string | null>(null);
  const [streamingArtifacts, setStreamingArtifacts] = React.useState<ChatArtifactV1[]>([]);
  const [streamingArtifactPlacements, setStreamingArtifactPlacements] = React.useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [streamingWideVisuals, setStreamingWideVisuals] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [visualDrafts, setVisualDrafts] = React.useState<VisualDrafts>(NO_VISUAL_DRAFTS);
  const [streamingUiVisuals, setStreamingUiVisuals] = React.useState<readonly ChatUiVisualV1[]>(NO_UI_VISUALS);
  const [uiDrafts, setUiDrafts] = React.useState<UiDrafts>(NO_UI_DRAFTS);
  const [streamComplete, setStreamComplete] = React.useState(false);
  const [persistedHandoffMessageId, setPersistedHandoffMessageId] = React.useState<string | null>(
    null,
  );
  const [isStartingGeneration, setIsStartingGeneration] = React.useState(false);
  const [isStoppingGeneration, setIsStoppingGeneration] = React.useState(false);
  // Closes busy admission in the same tick as Stop, before React re-renders.
  const stopRequestedRef = React.useRef(false);
  React.useLayoutEffect(() => {
    stopRequestedRef.current = isStoppingGeneration;
  }, [isStoppingGeneration]);
  const [isModelLoading, setIsModelLoading] = React.useState(false);
  const [modelCallRetry, setModelCallRetry] = React.useState<ModelCallRetryView | null>(null);
  const [modelCallRetryNow, setModelCallRetryNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!modelCallRetry) return;
    const timer = window.setInterval(() => setModelCallRetryNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [modelCallRetry]);
  // Read aloud: one controller per chat surface; main owns eligibility.
  const { state: readAloudState, controller: readAloudController } = useReadAloud(chatId);
  const readAloudRef = React.useRef(readAloudController);
  readAloudRef.current = readAloudController;
  const [canStopGeneration, setCanStopGeneration] = React.useState(false);
  const [hasUnpersistedResponse, setHasUnpersistedResponse] = React.useState(false);
  const [generationTimeline, setGenerationTimeline] = React.useState<GenerationTimeline | null>(
    null,
  );
  const [liveSubagents, setLiveSubagents] = React.useState<SubagentRunSnapshot[]>([]);
  const [liveSubagentTranscripts, setLiveSubagentTranscripts] =
    React.useState<LiveSubagentTranscripts>(NO_LIVE_SUBAGENT_TRANSCRIPTS);
  const [error, setError] = React.useState<string | null>(null);
  const [approvals, setApprovals] = React.useState<ApprovalPrompt[]>([]);
  // After a Deny, the composer invites the user to say what to do instead,
  // until they send something or leave the chat.
  const [deniedApprovalChatId, setDeniedApprovalChatId] = React.useState<string | null>(null);
  const approvalStatus = useApprovalStatusLine(chatId);
  const showApprovalStatus = approvalStatus.show;
  const [questionnaire, setQuestionnaire] = React.useState<(AskUserQuestionPromptV1 & { source?: "remote" }) | null>(null);
  const [questionnaireSubmitting, setQuestionnaireSubmitting] = React.useState(false);
  // Aiden's "Open design mode?" card for this chat, while one is waiting.
  const designModeConsent = useDesignModeConsent(capabilities.designMode ? chatId : undefined);
  // Aiden's canvas_focus can arrive before the canvas loads; keep it until it does.
  useCanvasFocusRequests(capabilities.designMode);
  // The prompt whose agent deadline passed while its card was still open.
  const [expiredQuestionnaireId, setExpiredQuestionnaireId] = React.useState<string | null>(null);
  // An answer submitted after the deadline, offered as a follow-up message.
  const [lateQuestionnaireAnswer, setLateQuestionnaireAnswer] = React.useState<string | null>(null);
  const [lateAnswerSending, setLateAnswerSending] = React.useState(false);
  const [btwView, setBtwView] = React.useState<BtwLiveView | null>(null);
  const [todoSnapshot, setTodoSnapshot] = React.useState<TodoSnapshotViewV1 | null>(null);
  const [thinkingSaving, setThinkingSaving] = React.useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = React.useState<string | null>(null);
  const decidingApprovalRef = React.useRef<string | null>(null);
  const generationRef = React.useRef<GenerationHandle | null>(null);
  const generationChatIdRef = React.useRef<string | null>(null);
  const generationIntentRef = React.useRef(0);
  const visualizeTurnRef = React.useRef(false);
  /** The keep-going round main offered this window, which the next run starts instead of answering a send. */
  const goalRoundTokenRef = React.useRef<string | null>(null);
  const mountedRef = React.useRef(true);
  const chatIdRef = React.useRef(chatId);
  const todoSnapshotReadFenceRef = React.useRef<TodoSnapshotReadFence | null>(null);
  const todoSnapshotReadFence = (todoSnapshotReadFenceRef.current ??= new TodoSnapshotReadFence());
  const btwViewRef = React.useRef<BtwLiveView | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  useCommandHandler("composer.focus", () => composerRef.current?.focus());
  const findBar = useChatFind(chatId);
  // A new-chat entry point (⌘N, New Agent, the sidebar +, New chat in…) asks
  // the draft's composer for focus; it may mount a few frames after navigation.
  React.useEffect(() => {
    let frame = 0;
    const unsubscribe = subscribeChatDraftComposerFocus(chatId, () => {
      let attempts = 0;
      const attempt = () => {
        const composer = composerRef.current;
        if (composer && !composer.disabled) {
          composer.focus({ preventScroll: true });
          return;
        }
        if (++attempts < 30) frame = requestAnimationFrame(attempt);
      };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(attempt);
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [chatId]);
  useComposerTypeFocus(composerRef, questionnaire === null);
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
  const clearStreamBuffers = React.useCallback(() => {
    if (deltaFrameRef.current !== null) window.cancelAnimationFrame(deltaFrameRef.current);
    deltaFrameRef.current = null;
    pendingDeltaRef.current = "";
    pendingReasoningDeltaRef.current = "";
    streamedTextRef.current = "";
    streamedReasoningRef.current = "";
    streamingArtifactsRef.current = [];
    streamHandoffRef.current?.();
    streamHandoffRef.current = null;
  }, []);
  const resetLiveTurnCore = React.useCallback((nextStreamingText: string | null) => {
    setStreamingText(nextStreamingText);
    setStreamingReasoning(null);
    setStreamingArtifacts([]);
    setVisualDrafts(NO_VISUAL_DRAFTS);
    setStreamingUiVisuals(NO_UI_VISUALS);
    setUiDrafts(NO_UI_DRAFTS);
    setStreamComplete(false);
    setIsStoppingGeneration(false);
    setIsModelLoading(false);
    setModelCallRetry(null);
    setGenerationTimeline(null);
    generationTimelineRef.current = null;
    setLiveSubagents([]);
    setLiveSubagentTranscripts(NO_LIVE_SUBAGENT_TRANSCRIPTS);
    setApprovals([]);
    setQuestionnaire(null);
    setQuestionnaireSubmitting(false);
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
    if (draft) return;
    let active = true;
    const refresh = async () => {
      const requestId = ++remoteApprovalRefreshRef.current;
      try {
        const [remote, remoteQuestion] = await Promise.all([
          aidenRemoteApi.pendingApproval(chatId),
          aidenRemoteApi.pendingQuestion(chatId),
        ]);
        if (
          !active ||
          chatIdRef.current !== chatId ||
          !isLatestRemoteApprovalRefresh(requestId, remoteApprovalRefreshRef.current)
        )
          return;
        setApprovals((current) => mergeRemoteApproval(current, remote));
        setQuestionnaire((current) => current && current.source !== "remote" ? current : remoteQuestion);
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
  }, [chatId, Boolean(draft)]);

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
      // A reply that settled in view kept the chat's cache warm; leaving ends that.
      if (departingChatId) void chatsApi.releaseCacheWarming(departingChatId).catch(() => {});
      const sideQuestion = btwViewRef.current;
      if (
        sideQuestion &&
        sideQuestion.requestId !== "pending" &&
        (sideQuestion.status === "starting" || sideQuestion.status === "running")
      ) {
        void chatsApi.btwCancel(departingChatId, sideQuestion.requestId);
      }
      clearStreamBuffers();
    };
  }, [chatId, clearStreamBuffers]);

  // Reset transient state when switching chats. This runs as a layout effect so
  // the incoming chatId never paints a frame carrying the outgoing chat's
  // stream, timeline, or approvals.
  React.useLayoutEffect(() => {
    todoSnapshotReadFence.reset(chatId);
    setStreamingText(null);
    setStreamingReasoning(null);
    clearTextStreaming();
    setStreamingArtifacts([]);
    setVisualDrafts(NO_VISUAL_DRAFTS);
    setStreamingUiVisuals(NO_UI_VISUALS);
    setUiDrafts(NO_UI_DRAFTS);
    streamingArtifactsRef.current = [];
    setStreamComplete(false);
    setPersistedHandoffMessageId(null);
    setIsStartingGeneration(false);
    setIsStoppingGeneration(false);
    setIsModelLoading(false);
    setModelCallRetry(null);
    setCanStopGeneration(false);
    setHasUnpersistedResponse(false);
    setGenerationTimeline(null);
    generationTimelineRef.current = null;
    setLiveSubagents([]);
    setLiveSubagentTranscripts(NO_LIVE_SUBAGENT_TRANSCRIPTS);
    setError(null);
    setApprovals([]);
    setQuestionnaire(null);
    setQuestionnaireSubmitting(false);
    setExpiredQuestionnaireId(null);
    setLateQuestionnaireAnswer(null);
    setLateAnswerSending(false);
    setBtwView(null);
    setTodoSnapshot(null);
    decidingApprovalRef.current = null;
    setDecidingApprovalId(null);
  }, [chatId]);

  React.useEffect(() => {
    if (draft) return;
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
  }, [chatId, Boolean(draft)]);

  const messages = React.useMemo(() => chat.data?.messages ?? [], [chat.data?.messages]);
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
  const displayedStreamingArtifacts =
    streamingArtifacts.length > 0
      ? streamingArtifacts
      : (visibleDetachedProjection?.artifacts ?? NO_STREAMING_ARTIFACTS);
  const displayedStreamingUiVisuals =
    streamingUiVisuals.length > 0 ? streamingUiVisuals : (visibleDetachedProjection?.uiVisuals ?? NO_UI_VISUALS);
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
  const displayedLiveSubagentTranscripts = React.useMemo(
    () =>
      combineLiveSubagentTranscripts(
        liveSubagentTranscripts,
        visibleDetachedProjection?.subagentTranscripts,
      ),
    [liveSubagentTranscripts, visibleDetachedProjection?.subagentTranscripts],
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
  const chatSubagentViews =
    environmentPanel.subagents.chatId === chatId ? environmentPanel.subagentViews : null;
  // A helper that waits on one of your approvals reads "Waiting on you" in the
  // chat's helper rows and the tray, as its own chat does. Display only. Shared
  // labels are judged against every helper in the chat, as the side panel does.
  const shownLiveSubagents = React.useMemo(
    () =>
      withSubagentApprovalWaitSnapshots(
        displayedLiveSubagents,
        approvals,
        chatSubagentViews ?? displayedLiveSubagents,
      ),
    [approvals, chatSubagentViews, displayedLiveSubagents],
  );
  const shownSubagentViews = React.useMemo(
    () => (chatSubagentViews ? withSubagentApprovalWaitViews(chatSubagentViews, approvals) : null),
    [approvals, chatSubagentViews],
  );
  const subagentPill = useSubagentComposerPill(
    chatId,
    shownSubagentViews,
    environmentPanel.subagentsEnabled,
  );
  const [subagentTrayOpen, setSubagentTrayOpen] = React.useState(false);
  const [measuredFloatingRowHeight, setFloatingRowHeight] = React.useState(0);
  const subagentTrayShortcut = useShortcutBinding("subagents.toggleTray");
  // A batch to present, whether or not its pill is on screen right now.
  const subagentPillVisible = subagentPill.model !== null;
  const subagentPillGenerations = React.useMemo(
    () => [...new Set(subagentPill.model?.runs.map((run) => run.generationId) ?? [])],
    [subagentPill.model],
  );
  // One indicator at a time: while the batch's transcript card is on screen the
  // pill steps aside, unless its tray is open.
  const subagentCardOnScreen = useSubagentGroupOnScreen(subagentPillGenerations);
  const subagentPillShown = subagentPillVisible && (!subagentCardOnScreen || subagentTrayOpen);
  const floatingRowHeight = useHeldFloatingRowHeight(measuredFloatingRowHeight, subagentPillVisible);
  React.useEffect(() => {
    if (!subagentPillVisible) setSubagentTrayOpen(false);
  }, [subagentPillVisible]);
  // A finished batch's summary is for someone who scrolled away; once its card
  // is back on screen it has been seen.
  const subagentBatchSettled =
    subagentPill.model !== null && subagentPill.model.activeCount === 0 && !subagentPill.model.attention;
  const dismissSubagentPill = subagentPill.dismiss;
  React.useEffect(() => {
    if (subagentBatchSettled && subagentCardOnScreen && !subagentTrayOpen) dismissSubagentPill();
  }, [dismissSubagentPill, subagentBatchSettled, subagentCardOnScreen, subagentTrayOpen]);
  React.useEffect(() => setSubagentTrayOpen(false), [chatId]);
  useCommandHandler(
    "subagents.toggleTray",
    () => setSubagentTrayOpen((open) => !open),
    subagentPillVisible,
  );
  const transcriptStreamingRef = React.useRef(false);
  transcriptStreamingRef.current = displayedStreamingText !== null;
  const showSubagentsInChat = React.useCallback((runIds: readonly string[]) => {
    // While text streams the transcript pins itself each frame, which would cut a smooth scroll short.
    const instant =
      transcriptStreamingRef.current || document.documentElement.dataset.reduceMotion === "true";
    return runIds.some((runId) => revealSubagentRunInTranscript(runId, { instant }));
  }, []);
  const imageArtifactRecoveryPending =
    hasUnpersistedResponse || chat.data?.imageArtifactRecoveryPending === true;
  const imageArtifactRecoveryUnavailable = chat.data?.imageArtifactRecoveryUnavailable === true;
  const isGenerating = streamingText !== null && !hasUnpersistedResponse;
  const contextLiveGeneration = isGenerating || isStartingGeneration;
  // Aiden Live reads which chat is on screen (title, workspace, busy, stream).
  const liveOpenChatOwner = React.useMemo(() => Symbol("chat-pane"), []);
  const liveOpenChatTitle = chat.data?.title ?? "New agent";
  const liveOpenChatStreamId = generationRef.current?.streamId ?? null;
  React.useEffect(() => {
    liveOpenChat.publish(liveOpenChatOwner, {
      chatId,
      title: liveOpenChatTitle,
      workspaceId: chatWorkspaceId ?? null,
      busy: contextLiveGeneration,
      streamId: liveOpenChatStreamId,
    });
  }, [chatId, chatWorkspaceId, contextLiveGeneration, liveOpenChatOwner, liveOpenChatStreamId, liveOpenChatTitle]);
  React.useEffect(() => () => liveOpenChat.clear(liveOpenChatOwner), [liveOpenChatOwner]);
  // A run this pane did not start (a paired phone's turn) streams in live
  // once main reports the chat busy, and stays until its saved reply lands.
  // A draft or this pane's own turn stops it; an idle chat holds nothing.
  const activeChatIds = useActiveChatIds(chat.data?.id);
  useObservedLocalRun(
    draft || isGenerating || isStartingGeneration ? null : chatId,
    effectiveWorkspaceId,
    activeChatIds.has(chatId),
  );
  const modelChangeBlocked = isGenerating || isStartingGeneration || thinkingSaving;
  // In Custom a chat can still carry its own level; the effort control shows
  // it while the model's family offers it, since that is what the turn sends.
  const ownLevelIn = <Level extends GenerationThinkingLevel>(levels: readonly Level[]): Level | undefined =>
    selectionThinkingLevel && (levels as readonly GenerationThinkingLevel[]).includes(selectionThinkingLevel)
      ? (selectionThinkingLevel as Level)
      : undefined;
  const stepAgentSlider = (direction: 1 | -1) => {
    if (chat.data?.botId || modelChangeBlocked || getChatDraft(chatId)?.sending) return;
    const target = agentSliderStepTarget(agentSliderState, direction);
    if (target?.providerId && target.model) {
      select(target.providerId, target.model, target.thinkingLevel ?? null);
    }
  };
  useCommandHandler("agentSlider.next", () => stepAgentSlider(1), !chat.data?.botId);
  useCommandHandler("agentSlider.previous", () => stepAgentSlider(-1), !chat.data?.botId);
  const thinkingDisabledReason =
    isStartingGeneration || isGenerating
      ? "Available after this response"
      : thinkingSaving
        ? "Saving thinking level…"
        : undefined;
  // While a turn runs the harness pushes the authoritative in-turn projection;
  // ambient journal reads (and the draft reset's debounced refresh) would lag
  // behind and overwrite it. The meter resumes ambient reads once it settles.
  React.useLayoutEffect(() => {
    contextFeed.setLive(contextLiveGeneration);
  }, [contextFeed, contextLiveGeneration]);
  // Permission/folder changes clear the stale reading. The feed keeps the
  // scope across chat switches, so this only needs to run when it changes.
  React.useLayoutEffect(() => {
    contextFeed.setScope(
      `${effectiveWorkspace?.permission ?? ""}\u0000${effectiveWorkspace?.folderPath ?? ""}`,
    );
  }, [contextFeed, effectiveWorkspace?.permission, effectiveWorkspace?.folderPath]);
  React.useEffect(() => {
    if (!contextLiveGeneration) void contextFeed.refresh();
    // Workspace path and permission shape the next request's system prompt
    // and AGENTS.md scope, so a change re-prices the meter.
  }, [
    contextFeed,
    chatId,
    draft,
    providerId,
    model,
    chat.data?.updatedAt,
    contextLiveGeneration,
    effectiveWorkspace?.permission,
    effectiveWorkspace?.folderPath,
  ]);
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
      if (getChatDraft(chatId)) {
        updateChatDraft(chatId, { title });
        return;
      }
      await chatControl.rename(title);
      qc.setQueryData<Chat | null>(queryKeys.chat(chatId), (current) =>
        current ? { ...current, title } : current,
      );
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
    },
    [chatControl, chatId, qc],
  );

  const copyChat = React.useCallback(
    async (
      forkAt?: { messageId: string; position: ChatForkPosition },
      prefill?: {
        text: string;
        attachments: readonly Attachment[];
        grabbedElements?: readonly GrabbedElementContextV1[];
      },
      summary?: { instructions?: string },
      continueInWorkspaceId?: string,
    ) => {
      if (getChatDraft(chatId)) throw new Error("Send the first message before copying this chat.");
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
      const copied = continueInWorkspaceId
        ? await chatsApi.continueInNewChat(sourceChatId, continueInWorkspaceId)
        : await chatsApi.copyVisibleHistory(sourceChatId, forkAt, summary);
      if (prefill) {
        saveComposerDraftText(copied.id, prefill.text);
        seedComposerAttachments(copied.id, prefill.attachments);
        if (prefill.grabbedElements?.length) {
          seedComposerGrabbedElements(copied.id, prefill.grabbedElements, prefill.attachments);
        }
      }
      const copiedWorkspaceId = persistedChatWorkspaceId(copied.workspaceId);
      if (copiedWorkspaceId !== effectiveWorkspaceIdRef.current) {
        await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      }
      qc.setQueryData(queryKeys.chat(copied.id), copied);
      qc.setQueryData<ChatMeta[]>(queryKeys.chatsIn(copiedWorkspaceId), (current) => [
        {
          id: copied.id,
          title: copied.title,
          workspaceId: copiedWorkspaceId,
          providerId: copied.providerId,
          model: copied.model,
          ...(copied.forkedFrom ? { forkedFrom: copied.forkedFrom } : {}),
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

  // Continue in a new chat: fork the conversation into another workspace, or
  // No workspace, and take the unsent message along. This chat stays as it is.
  const [continuingInNewChat, setContinuingInNewChat] = React.useState(false);
  const missingFolderWorkspaceId = missingWorkspaceFolder?.id;
  const missingFolderMainWorkspaceId = missingWorkspaceFolder?.worktree?.mainWorkspaceId;
  const continueChoices = React.useMemo(
    () =>
      missingFolderWorkspaceId
        ? continueInWorkspaceChoices(workspaces, missingFolderWorkspaceId, missingFolderMainWorkspaceId)
        : [],
    [missingFolderMainWorkspaceId, missingFolderWorkspaceId, workspaces],
  );
  const continueInNewChat = React.useCallback(
    async (workspaceId: string) => {
      // The composer's draft goes along with its attachments. Otherwise a send
      // refused by the folder check may be waiting in the paused queue with the
      // composer already cleared, so that message goes instead.
      const draft = cloneDraftRef.current;
      const queued = chatMessageQueue(chatId).getSnapshot().messages[0];
      const storedText = loadComposerDraft(chatId).text.trim();
      const unsent =
        draft.text.trim() || draft.attachments.length || draft.grabbedElements.length
          ? {
              text: draft.text.trim(),
              attachments: draft.attachments,
              grabbedElements: draft.grabbedElements,
            }
          : queued &&
              (queued.text.trim() || queued.attachments.length || queued.grabbedElements?.length)
            ? {
                text: queued.text.trim(),
                attachments: queued.attachments,
                grabbedElements: queued.grabbedElements,
              }
            : storedText
              ? { text: storedText, attachments: [] }
              : undefined;
      setContinuingInNewChat(true);
      try {
        await copyChat(undefined, unsent, undefined, workspaceId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't continue in a new chat.");
      } finally {
        if (mountedRef.current) setContinuingInNewChat(false);
      }
    },
    [chatId, copyChat],
  );

  const forkLineage = chat.data?.forkedFrom;
  // A chat another chat started (Phase 5, D7). It wins over an outside app's provenance.
  const chatLineage = chat.data?.startedBy;
  const allChats = useAllRegularChats(Boolean(forkLineage) || Boolean(chatLineage));
  const leadChat = chatLineage ? allChats.data?.find((candidate) => candidate.id === chatLineage.chatId) : undefined;
  const leadChatLoading = Boolean(chatLineage) && allChats.isPending;
  const startedByChat = chatLineage ? (leadChatLoading ? "Started by another chat" : startedByChatLabel(leadChat?.title)) : undefined;
  const leadChatMessageLabel = chatLineage && !leadChatLoading ? fromLeadChatLabel(leadChat?.title) : undefined;
  const forkSource = forkLineage
    ? allChats.data?.find((candidate) => candidate.id === forkLineage.chatId)
    : undefined;
  const forkSourceLabel = forkLineage
    ? allChats.isPending
      ? "Forked chat"
      : forkedFromLabel(forkSource?.title)
    : undefined;
  const startedBy = useAidenMcpChatProvenance(
    chatId,
    capabilities.mcpServer && !draft && Boolean(persistedChat.data),
  );
  const startedByLabel = startedBy && !chatLineage ? `Started by ${startedBy.name}` : undefined;

  const forkDisabledReason =
    isGenerating || isStartingGeneration || approvals.length > 0
      ? "Finish the current response or approval before forking"
      : documentAppendReconciliationRequired
        ? "Reload Aiden before forking this chat"
        : imageArtifactRecoveryPending || imageArtifactRecoveryUnavailable
          ? "Recover this chat's visual artifacts before forking"
          : null;

  /**
   * Fork from a transcript message. `after` keeps the chosen reply; `before`
   * keeps everything earlier and pre-fills the chosen prompt for editing. The
   * first prompt has nothing before it, so editing it opens a fresh chat in
   * the same workspace instead.
   */
  const forkFromMessage = React.useCallback(
    async (messageId: string, position: ChatForkPosition, summary?: { instructions?: string }) => {
      if (position === "after") {
        await copyChat({ messageId, position }, undefined, summary);
        return;
      }
      const index = messages.findIndex((message) => message.id === messageId);
      const message = messages[index];
      if (!message || message.role !== "user") {
        throw new Error("That message is no longer in this chat.");
      }
      const prefill = {
        text: message.content,
        attachments: await attachmentsWithBytes(chatId, message.attachments ?? [], chatsApi.imageData),
        ...(message.grabbedElements?.length
          ? { grabbedElements: structuredClone(message.grabbedElements) }
          : {}),
      };
      if (messages.slice(0, index).some((earlier) => earlier.role === "user")) {
        await copyChat({ messageId, position }, prefill, summary);
        return;
      }
      if (summary) throw new Error("The first prompt has nothing before it to fork with a summary.");
      if (forkDisabledReason) throw new Error(`${forkDisabledReason}.`);
      const workspaceId = persistedChatWorkspaceId(chat.data?.workspaceId);
      const created = createChatDraft(workspaceId, undefined, prefill.text).chat;
      seedComposerAttachments(created.id, prefill.attachments);
      if (prefill.grabbedElements?.length) {
        seedComposerGrabbedElements(created.id, prefill.grabbedElements, prefill.attachments);
      }
      selectWorkspace(workspaceId);
      try {
        await navigate({ to: "/chat/$chatId", params: { chatId: created.id } });
        requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
      } catch {
        discardChatDraft(created.id);
        toast.info("Aiden could not open the new chat.");
      }
    },
    [chat.data?.workspaceId, copyChat, forkDisabledReason, messages, navigate, selectWorkspace],
  );

  const forkFromTranscript = React.useCallback(
    (messageId: string, position: ChatForkPosition) => {
      void forkFromMessage(messageId, position).then(
        () => toast.success(position === "before" ? "Forked — edit your message and send" : "Chat forked"),
        (error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Couldn't fork this chat."),
      );
    },
    [forkFromMessage],
  );

  const [forkSummaryRequest, setForkSummaryRequest] = React.useState<{
    messageId: string;
    position: ChatForkPosition;
  } | null>(null);
  const forkWithSummary = React.useCallback(
    async (instructions: string | undefined) => {
      if (!forkSummaryRequest) return;
      const { messageId, position } = forkSummaryRequest;
      try {
        await forkFromMessage(messageId, position, instructions ? { instructions } : {});
        toast.success(
          position === "before"
            ? "Forked — Aiden is summarizing the original chat. Edit your message and send"
            : "Forked — Aiden is summarizing the original chat",
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't fork this chat.");
        throw error;
      }
    },
    [forkFromMessage, forkSummaryRequest],
  );

  const forkSummary = forkLineage?.summary;
  const [forkSummaryBusy, setForkSummaryBusy] = React.useState(false);
  const runForkSummaryAction = React.useCallback(
    async (action: "retry" | "cancel" | "skip") => {
      setForkSummaryBusy(true);
      try {
        if (action === "cancel") {
          // Main publishes the failed state once the attempt stops.
          if (!(await chatsApi.cancelForkSummary(chatId))) {
            toast.info("The summary already finished.");
          }
          return;
        }
        const updated =
          action === "retry"
            ? await chatsApi.retryForkSummary(chatId)
            : await chatsApi.skipForkSummary(chatId);
        qc.setQueryData<Chat | null>(queryKeys.chat(chatId), (current) =>
          current ? withForkLineage(current, updated.forkedFrom) : current,
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't update the fork's summary.");
      } finally {
        if (mountedRef.current) setForkSummaryBusy(false);
      }
    },
    [chatId, qc],
  );

  const exportChat = React.useCallback(async () => {
    if (getChatDraft(chatId)) throw new Error("Send the first message before exporting this chat.");
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

  // A boolean, so a timeline update re-publishes the panel's details only when it flips.
  const timelineCompacting =
    displayedGenerationTimeline?.steps.some((step) => isToolStep(step) && step.toolName === "compact_context" && (step.status === "pending" || step.status === "running")) ?? false;
  React.useEffect(() => {
    environmentPanel.setContextDetails(!draft && chat.data ? {
      chat: chat.data,
      providerId,
      providerLabel: selectedProvider?.label ?? providerId ?? "Unavailable",
      providerArtwork: selectedProvider?.artwork,
      modelId: model,
      modelLabel: model ? resolveModelDisplay(model, modelInfo.data?.[model]).label : "Unavailable",
      pressure: contextPressure,
      compacting: contextCompactPending || timelineCompacting,
    } : null);
    return () => environmentPanel.setContextDetails(null);
  }, [chat.data, draft, selectedProvider?.label, selectedProvider?.artwork, providerId, model, modelInfo.data, contextPressure, contextCompactPending, timelineCompacting, environmentPanel.setContextDetails]);

  // The PR rail/push dialog read the presented chat even without subagents.
  React.useLayoutEffect(() => {
    environmentPanel.setActiveChat(chatId, effectiveWorkspaceId ?? null);
    return () => environmentPanel.setActiveChat(null, null);
  }, [chatId, effectiveWorkspaceId, environmentPanel.setActiveChat]);

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

  const createStreamCallbacks = React.useCallback(
    (
      generationIntent: number,
      options: { providerId?: string; fallbackWorkspaceId?: string } = {},
    ): StreamCallbacks => {
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
      return {
        onDelta: (delta) => {
          if (mountedRef.current && generationIntentRef.current === generationIntent) {
            setIsModelLoading(false);
            setModelCallRetry(null);
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
          setVisualDrafts((current) => reduceVisualDrafts(current, event));
          setUiDrafts((current) => reduceUiDrafts(current, event));
          setStreamingUiVisuals((current) => reduceUiVisuals(current, event));
          if (event.operation === "draft" || event.operation === "draft_end") return;
          if (event.operation === "ui" || event.operation === "ui_draft") {
            if (event.operation === "ui") setIsModelLoading(false);
            return;
          }
          if (event.operation === "reset") {
            setStreamingArtifacts([]);
            streamingArtifactsRef.current = [];
            return;
          }
          const { artifact } = event;
          setIsModelLoading(false);
          setModelCallRetry(null);
          // Seed main's ready preview before the frame mounts so the final
          // visual replaces its draft without a loading placeholder.
          if (artifact.kind === "html" && event.src) primeInlineVisualPreview(chatId, artifact, event.src);
          if (event.toolCallId) {
            const toolCallId = event.toolCallId;
            // Visuals key by mediaId, images by attachment id. Both
            // are unique per generation, so this map only grows; entries for
            // artifacts no longer shown are never looked up.
            const key = artifact.kind === "html" ? artifact.mediaId : artifact.attachment.id;
            setStreamingArtifactPlacements((current) =>
              current.get(key) === toolCallId ? current : new Map(current).set(key, toolCallId),
            );
          }
          if (artifact.kind === "html") {
            // The latest presentation wins, so a revision can widen or narrow.
            const wide = event.layout === "wide";
            setStreamingWideVisuals((current) => {
              if (current.has(artifact.mediaId) === wide) return current;
              const next = new Set(current);
              if (wide) next.add(artifact.mediaId);
              else next.delete(artifact.mediaId);
              return next;
            });
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
            setModelCallRetry(null);
            pendingReasoningDeltaRef.current += delta;
            scheduleStreamFlush();
          }
        },
        onStatus: (phase) => {
          if (!mountedRef.current || generationIntentRef.current !== generationIntent) return;
          if (phase === "model_loading") setIsModelLoading(true);
          else if (phase === "model_ready") setIsModelLoading(false);
        },
        onRetrying: (retry) => {
          if (!mountedRef.current || generationIntentRef.current !== generationIntent) return;
          setModelCallRetryNow(Date.now());
          setModelCallRetry(retry);
        },
        onAgentsInstructionNotices: (notices) => {
          if (!mountedRef.current || generationIntentRef.current !== generationIntent) return;
          for (const notice of agentsInstructionNotices.update(chatId, notices)) {
            toast.info(agentsInstructionNoticeMessage(notice));
          }
        },
        onHookMessages: (messages) => {
          if (!mountedRef.current || generationIntentRef.current !== generationIntent) return;
          const notice = hookMessagesNotice(messages);
          if (!notice) return;
          const description =
            notice.lines.length || notice.more ? (
              <span className="flex flex-col">
                {notice.lines.map((line, index) => (
                  <span key={index}>{line}</span>
                ))}
                {notice.more ? <span>{`and ${notice.more} more`}</span> : null}
              </span>
            ) : undefined;
          toast.info(notice.title, description ? { description } : undefined);
        },
        onContextPressure: (pressure) => {
          if (mountedRef.current && generationIntentRef.current === generationIntent) {
            setContextPressure(pressure);
          }
        },
        ...(environmentPanel.subagentsEnabled
          ? {
              onSubagents: (snapshot: SubagentRunSnapshot) => {
                const targetWorkspaceId =
                  effectiveWorkspaceIdRef.current ?? options.fallbackWorkspaceId;
                if (
                  !mountedRef.current ||
                  generationIntentRef.current !== generationIntent ||
                  chatIdRef.current !== chatId ||
                  snapshot.chatId !== chatId ||
                  // Read at event time: a New worktree draft's first turn
                  // starts while the chat moves into its new workspace.
                  (targetWorkspaceId !== undefined && snapshot.workspaceId !== targetWorkspaceId)
                ) {
                  return;
                }
                setLiveSubagents((current) =>
                  mergeSubagentSnapshots(current, [snapshot], {
                    chatId,
                    workspaceId: targetWorkspaceId ?? snapshot.workspaceId,
                  }),
                );
              },
              onSubagentTranscript: (update: SubagentTranscriptUpdateV1) => {
                if (
                  !mountedRef.current ||
                  generationIntentRef.current !== generationIntent ||
                  chatIdRef.current !== chatId
                ) {
                  return;
                }
                setLiveSubagentTranscripts((current) => foldLiveSubagentTranscript(current, update));
              },
            }
          : {}),
        onTimeline: (next) => {
          if (mountedRef.current && generationIntentRef.current === generationIntent) {
            // Each update carries every step; keeping the unchanged ones
            // lets their memoized rows skip rendering.
            const timeline = replaceEqualDeep(generationTimelineRef.current, next);
            generationTimelineRef.current = timeline;
            setGenerationTimeline(timeline);
            // A tool starting means the retried request answered.
            if (latestActiveAgentStep(timeline)) setModelCallRetry(null);
          }
        },
        onApproval: (prompt) => {
          if (mountedRef.current && generationIntentRef.current === generationIntent) {
            setApprovals((prev) =>
              prev.some((existing) => existing.approvalId === prompt.approvalId)
                ? prev
                : [...prev, prompt],
            );
          }
        },
        onQuestionnaire: (prompt) => {
          if (mountedRef.current && generationIntentRef.current === generationIntent) {
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
          const persistedAssistant = updatedChat?.messages[updatedChat.messages.length - 1];
          setPersistedHandoffMessageId(
            persistedAssistant?.role === "assistant" && persistedAssistant.content === full
              ? persistedAssistant.id
              : null,
          );
          clearTextStreaming();
          setStreamComplete(true);
          if (finalTimeline) {
            generationTimelineRef.current = finalTimeline;
            setGenerationTimeline(finalTimeline);
          }
          if (updatedChat) {
            await qc.cancelQueries({ queryKey: queryKeys.chat(chatId), exact: true });
            qc.setQueryData(queryKeys.chat(chatId), updatedChat);
            void qc.invalidateQueries({ queryKey: queryKeys.chats });
          }
          await waitForStreamHandoff(Boolean(full.trim()));
          if (generationIntentRef.current !== generationIntent) return;
          if (mountedRef.current) {
            setLiveSubagents([]);
            setLiveSubagentTranscripts(NO_LIVE_SUBAGENT_TRANSCRIPTS);
            setStreamingText(null);
            setStreamingReasoning(null);
            setStreamingArtifacts([]);
            setVisualDrafts(NO_VISUAL_DRAFTS);
            setStreamingUiVisuals(NO_UI_VISUALS);
            setUiDrafts(NO_UI_DRAFTS);
            streamingArtifactsRef.current = [];
            streamedTextRef.current = "";
            streamedReasoningRef.current = "";
            setStreamComplete(false);
            setPersistedHandoffMessageId(null);
            setIsStoppingGeneration(false);
            setIsModelLoading(false);
            setModelCallRetry(null);
            setGenerationTimeline(null);
            generationTimelineRef.current = null;
            setApprovals([]);
            // Timed-out prompts remain answerable after the agent continues with its default.
            setQuestionnaire((current) =>
              retainExpiredAskUserQuestionForLateAnswer(current),
            );
            setQuestionnaireSubmitting(false);
          }
        },
        onError: (message, partialContent, finalTimeline, updatedChat, finalReasoning) => {
          chatMessageQueue(chatId).pause();
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
            const persistedAssistant = updatedChat?.messages[updatedChat.messages.length - 1];
            setPersistedHandoffMessageId(
              persistedAssistant?.role === "assistant" &&
                persistedAssistant.content === resolvedPartialContent
                ? persistedAssistant.id
                : null,
            );
            clearTextStreaming();
            setStreamComplete(true);
            if (finalTimeline) {
              generationTimelineRef.current = finalTimeline;
              setGenerationTimeline(finalTimeline);
            }
            const resolvedProviderId = options.providerId ?? updatedChat?.providerId;
            if (resolvedProviderId === OPENAI_CODEX_PROVIDER_ID) {
              void refreshCodexProviderState(qc);
            }
            const partial = resolvedPartialContent.trim();
            if (updatedChat) {
              await qc.cancelQueries({ queryKey: queryKeys.chat(chatId), exact: true });
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
              if (updatedChat || !partial) {
                setLiveSubagents([]);
                setLiveSubagentTranscripts(NO_LIVE_SUBAGENT_TRANSCRIPTS);
              }
              if (!partial || updatedChat) {
                setStreamingText(null);
                setStreamingReasoning(null);
                streamedTextRef.current = "";
                streamedReasoningRef.current = "";
                setStreamComplete(false);
                setPersistedHandoffMessageId(null);
              }
              const hasUnpersistedArtifact = streamingArtifactsRef.current.length > 0;
              setHasUnpersistedResponse(
                Boolean((partial || hasUnpersistedArtifact) && !updatedChat),
              );
              if (updatedChat) {
                setStreamingArtifacts([]);
                setVisualDrafts(NO_VISUAL_DRAFTS);
                setStreamingUiVisuals(NO_UI_VISUALS);
                setUiDrafts(NO_UI_DRAFTS);
                streamingArtifactsRef.current = [];
              }
              setIsStoppingGeneration(false);
              setIsModelLoading(false);
              setModelCallRetry(null);
              if (!partial || updatedChat) {
                setGenerationTimeline(null);
                generationTimelineRef.current = null;
              }
              setApprovals([]);
              setQuestionnaire((current) =>
                retainExpiredAskUserQuestionForLateAnswer(current),
              );
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
      };
    },
    [
      chatId,
      clearTextStreaming,
      environmentPanel.subagentsEnabled,
      markTextStreaming,
      qc,
      waitForStreamHandoff,
    ],
  );

  const runGeneration = React.useCallback(
    (messageTurnId: string) => {
      const generationIntent = generationIntentRef.current;
      setError(null);
      setCanStopGeneration(true);
      setHasUnpersistedResponse(false);
      resetLiveTurnCore("");
      clearTextStreaming();
      streamingArtifactsRef.current = [];
      setPersistedHandoffMessageId(null);
      pendingDeltaRef.current = "";
      pendingReasoningDeltaRef.current = "";
      streamedTextRef.current = "";
      streamedReasoningRef.current = "";
      streamHandoffRef.current?.();
      streamHandoffRef.current = null;
      const visualize = visualizeTurnRef.current === true;
      visualizeTurnRef.current = false;
      const goalRoundToken = goalRoundTokenRef.current;
      goalRoundTokenRef.current = null;
      // A chat whose canvas is open says what it shows: the selection and its size on screen.
      const designView = designCanvasViewFor(chatId);
      const handle = startGeneration(
        {
          chatId,
          // The chat's latest workspace: a New worktree first send moves it
          // before this render has seen the new workspace.
          workspaceId: effectiveWorkspaceIdRef.current,
          providerId,
          model,
          ...(visualize ? { visualize: true as const } : {}),
          ...(designView ? { designView } : {}),
          inlineVisuals: readCachedAppearance()?.inlineVisuals ?? "automatic",
          thinkingLevel: turnThinkingLevel(selectionThinkingLevel, {
            google: { supported: googleThinkingSupported, level: googleThinkingLevel },
            codex: { supported: codexThinkingSupported, level: codexThinkingLevel },
            anthropic: { supported: anthropicThinkingSupported, level: anthropicThinkingLevel },
            provider: { supported: providerThinkingSupported, level: providerThinkingLevel },
          }),
        },
        createStreamCallbacks(generationIntent, { providerId }),
        messageTurnId,
        goalRoundToken ? goalRoundStart(goalRoundToken) : undefined,
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
      createStreamCallbacks,
      googleThinkingLevel,
      googleThinkingSupported,
      providerId,
      providerThinkingLevel,
      providerThinkingSupported,
      resetLiveTurnCore,
      selectionThinkingLevel,
      model,
    ],
  );

  // A New worktree draft's first send: the message and a progress row show
  // until the chat is saved in its new worktree, or the user answers a failure.
  // The send is kept per draft outside this pane, so leaving and coming back
  // (or sending another draft meanwhile) shows the same progress or failure.
  const worktreeSend = React.useSyncExternalStore(subscribeActiveWorktreeSends, () =>
    activeWorktreeSend(chatId),
  );
  /** The draft will send in New worktree mode; set where that mode is derived, below. */
  const draftWorktreeModeRef = React.useRef(false);
  /** Git status is still loading for a draft that remembers New worktree. */
  const draftGitPendingRef = React.useRef(false);
  /** Counts visits to a chat: the composer that started a send is gone once this changes. */
  const chatVisitRef = React.useRef(0);
  /** Identifies the newest side-question start so an older one cannot settle its card. */
  const btwStartAttemptRef = React.useRef(0);
  React.useLayoutEffect(() => {
    chatVisitRef.current += 1;
  }, [chatId]);

  const handleSend = React.useCallback(
    async (
      text: string,
      attachments: Attachment[],
      skillInvocation?: SkillInvocationV1,
      options?: {
        visualize?: boolean;
        btw?: boolean;
        goal?: string;
        goalSource?: "slash" | "proposal";
        inputSource?: ChatInputSourceV1;
        grabbedElements?: GrabbedElementContextV1[];
      },
    ) => {
      // Only Aiden Live's chat tools set this; the message shows "By voice".
      const inputSource = options?.inputSource;
      const grabbedElements = options?.grabbedElements?.length
        ? options.grabbedElements
        : undefined;
      if (options?.btw) {
        if (getChatDraft(chatId))
          throw new Error("Send the first message before asking a side question.");
        if (attachments.length > 0 || grabbedElements?.length || skillInvocation) {
          throw new Error("Side questions do not accept attachments, browser elements, or skills.");
        }
        // A new turn revokes any active read-aloud job for this chat.
        readAloudRef.current?.stop();
        const question = text.trim();
        // A refused follow-up must leave the earlier answer, and the card holding
        // the unsent text, on screen rather than unmounting it.
        const previousView = btwViewRef.current?.requestId === "pending" ? null : btwViewRef.current;
        // The pane outlives navigation and a later start replaces this one, so a
        // settling start may touch the card only while it still owns it.
        const visit = chatVisitRef.current;
        const attempt = ++btwStartAttemptRef.current;
        const ownsPendingView = (current: BtwLiveView | null): current is BtwLiveView =>
          current?.requestId === "pending" &&
          chatVisitRef.current === visit &&
          btwStartAttemptRef.current === attempt;
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
            ownsPendingView(current) ? { ...current, requestId: receipt.requestId } : current,
          );
        } catch (error) {
          setBtwView((current) => (ownsPendingView(current) ? previousView : current));
          throw error;
        }
        return;
      }
      if (chatMessageQueue(chatId).getSnapshot().messages.length === 0)
        chatMessageQueue(chatId).resume();
      // A new turn revokes any active read-aloud job for this chat.
      readAloudRef.current?.stop();
      visualizeTurnRef.current = options?.visualize === true;
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
      if (detachedGenerationDraining) {
        throw new Error("Wait for the previous response to finish saving before sending again.");
      }
      if (getChatDraft(chatId) && draftGitPendingRef.current) {
        throw new Error("Reading Git status… Send again in a moment.");
      }
      let worktreeRequest: FirstMessageWorktreeRequest | undefined;
      try {
        worktreeRequest =
          getChatDraft(chatId) && draftWorktreeModeRef.current
            ? chatDraftWorktreeRequest(getChatDraft(chatId)!)
            : undefined;
      } catch {
        // The base branch isn't resolved yet; the composer keeps the text.
        throw new Error("Reading Git status… Send again in a moment.");
      }
      const folderWorkspace = folderWorkspaceRef.current;
      if (folderWorkspace) {
        const cachedPresence = worktreeRequest
          ? qc.getQueryData<WorkspaceFolderPresenceResult>(
              queryKeys.workspaceFolderPresence(folderWorkspace.id),
            )
          : undefined;
        // Worktree-on-send validates the source folder live in main before
        // touching disk; skip the blocking pre-send IPC when the cached
        // presence is not missing so the user's bubble and progress row paint
        // on frame 1. If the cached presence says "missing", fall through to a
        // live check so a folder restored on disk is never blocked by stale cache.
        if (!worktreeRequest || cachedPresence?.presence === "missing") {
          const folderCheckVisit = chatVisitRef.current;
          // A failed check is no reason to refuse; main checks again at start.
          const presence = await qc
            .fetchQuery({
              queryKey: queryKeys.workspaceFolderPresence(folderWorkspace.id),
              queryFn: () => workspacesApi.folderPresence(folderWorkspace.id),
              staleTime: 0,
            })
            .catch(() => undefined);
          // The user left this chat during the check: send nothing from a pane
          // that now shows another chat. The composer's saved draft keeps the text.
          if (!(mountedRef.current && chatVisitRef.current === folderCheckVisit)) {
            throw new WorktreeSendCancelledError();
          }
          // The notice above the composer names the folder; the toast stays short.
          if (presence?.presence === "missing") {
            throw new Error(presence.worktree ? MANAGED_WORKTREE_MISSING_SEND_REFUSAL : WORKSPACE_FOLDER_MISSING_SEND_REFUSAL);
          }
        }
      }
      let worktreeSend: WorktreeFirstSend<Chat, Workspace> | undefined;
      /** The user answered a failed worktree send, possibly from a later view of this draft. */
      let continuedByUser = false;
      const firstDraft = getChatDraft(chatId) ? beginChatDraftSend(chatId) : undefined;
      const generationIntent = ++generationIntentRef.current;
      const messageTurnId = createChatTurnId();
      setIsStoppingGeneration(false);
      setIsStartingGeneration(true);
      try {
        let updated: Chat;
        try {
          const firstMessageInput = firstDraft
            ? {
                draftId: chatId,
                title: firstDraft.chat.title === "New agent" ? undefined : firstDraft.chat.title,
                workspaceId: firstDraft.chat.workspaceId!,
                ...(firstDraft.chat.ephemeral ? { ephemeral: true as const } : {}),
                providerId,
                model,
                // The new-chat pick's stop effort becomes the chat's own level,
                // so later turns keep it instead of the per-model setting.
                ...(selectionThinkingLevel ? { thinkingLevel: selectionThinkingLevel } : {}),
                turnId: messageTurnId,
                message: {
                  role: "user" as const,
                  content: text,
                  attachments: attachments.length ? attachments : undefined,
                  ...(grabbedElements ? { grabbedElements } : {}),
                },
                skillInvocation,
                ...(inputSource ? { inputSource } : {}),
              }
            : undefined;
          if (firstMessageInput && worktreeRequest) {
            const visit = chatVisitRef.current;
            setActiveWorktreeGrabbedElements(chatId, grabbedElements);
            performance.mark?.("aiden:worktree-send:start");
            worktreeSend = startWorktreeFirstSend({
              api: {
                createInWorktree: chatsApi.createWithFirstMessageInWorktree,
                createInCheckout: chatsApi.createWithFirstMessage,
                onProgress: chatsApi.onFirstMessageWorktreeProgress,
              },
              input: firstMessageInput,
              worktree: worktreeRequest,
              message: { text, attachments, ...(inputSource ? { inputSource } : {}) },
              onView: (view) => {
                if (view.status === "failed" && folderWorkspace) {
                  void qc.invalidateQueries({
                    queryKey: queryKeys.workspaceFolderPresence(folderWorkspace.id),
                  });
                }
              },
            });
            // The progress view holds the message now; a composer that opens
            // on this draft meanwhile starts empty instead of repeating it.
            discardComposerDraft(chatId);
            try {
              const outcome = await worktreeSend.result;
              performance.mark?.("aiden:worktree-send:done");
              try {
                performance.measure?.(
                  "aiden:worktree-send",
                  "aiden:worktree-send:start",
                  "aiden:worktree-send:done",
                );
              } catch {
                // Ignore missing marks if the performance buffer was cleared.
              }
              if (outcome.worktree) {
                if (outcome.workspace) {
                  const createdWorkspace = outcome.workspace;
                  upsertCreatedWorkspaceInCache(qc, createdWorkspace);
                  // Seed folder-presence for a brand-new worktree; leave Git
                  // status to main's `infoCache` (0-spawn when clean, or live
                  // post-hook status if WorktreeSetup modified the checkout).
                  if (!outcome.worktree.reused && createdWorkspace.folderPath) {
                    qc.setQueryData<WorkspaceFolderPresenceResult>(
                      queryKeys.workspaceFolderPresence(createdWorkspace.id),
                      { presence: "present" },
                    );
                  }
                  if (mountedRef.current && chatIdRef.current === chatId) {
                    React.startTransition(() => {
                      selectWorkspace(createdWorkspace.id);
                    });
                  }
                } else {
                  // Fallback when main omitted the workspace record.
                  await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
                }
                const note = worktreeBaseNote(outcome.worktree);
                if (note) toast.info(note);
              }
              if (outcome.keptWorktreeBranch) {
                void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
                toast.info(
                  `Worktree ${outcome.keptWorktreeBranch} was kept. Delete it from the sidebar if you don’t need it.`,
                );
              }
              updated = outcome.chat;
              continuedByUser = outcome.answered;
            } catch (error) {
              // Refresh folder presence if worktree creation failed (for
              // example, when the source folder was deleted just before send).
              if (folderWorkspace) {
                void qc.invalidateQueries({
                  queryKey: queryKeys.workspaceFolderPresence(folderWorkspace.id),
                });
              }
              // The composer that sent this restores its own text; any other
              // (the user left and came back) gets the text, attachments, and grabbed elements back.
              if (
                isWorktreeSendCancelled(error) &&
                !(mountedRef.current && chatVisitRef.current === visit)
              ) {
                restoreUnsentMessage(chatId, text, attachments, grabbedElements);
              }
              throw error;
            }
          } else {
            updated = firstMessageInput
              ? await chatsApi.createWithFirstMessage(firstMessageInput)
              : await chatsApi.appendMessage(
                  chatId,
                  {
                    role: "user",
                    content: text,
                    attachments: attachments.length ? attachments : undefined,
                    ...(grabbedElements ? { grabbedElements } : {}),
                  },
                  {
                    providerId,
                    model,
                    autoTitle: true,
                    turnId: messageTurnId,
                    skillInvocation,
                    ...(inputSource ? { inputSource } : {}),
                  },
                );
          }
        } catch (appendError) {
          if (isAppendReconciliationRequired(appendError)) {
            setAppendReconciliationRequiredChats((current) => new Set(current).add(chatId));
            if (!firstDraft) void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
          }
          throw appendError;
        }
        await installAppendedChatSnapshot(qc, chatId, updated);
        if (firstDraft) {
          // Only suppress the immediate mount `chats:get` when this pane is
          // still actively showing the promoted chat; leaving before commit
          // abandons the turn and must re-read on revisit.
          if (
            generationIntentRef.current === generationIntent &&
            mountedRef.current &&
            chatIdRef.current === chatId
          ) {
            markChatRecentlyPromoted(chatId);
          }
          finishChatDraftSend(chatId, true);
        }
        void qc.invalidateQueries({ queryKey: queryKeys.chats });
        if (
          generationIntentRef.current !== generationIntent ||
          (firstDraft && (!mountedRef.current || chatIdRef.current !== chatId))
        ) {
          // The user came back to this draft and chose to continue its
          // worktree send there: the view showing the chat starts the reply.
          if (
            continuedByUser &&
            continueWorktreeSendInView(chatId, {
              turnId: messageTurnId,
              workspaceId: updated.workspaceId,
              visualize: options?.visualize === true,
            })
          ) {
            return;
          }
          try {
            await chatsApi.abandonTurn(chatId, messageTurnId);
          } catch (error) {
            if (mountedRef.current) {
              setError(error instanceof Error ? error.message : String(error));
            }
          }
          return;
        }
        // The user message crossed its durability barrier in appendMessage, so
        // the send is finished here. Main may still be preparing the response:
        // Stop and the Steer/Queue pill are live already, and holding this
        // promise until start is acknowledged would make the composer drop
        // whatever the user steers or queues in that window. A start rejection
        // is surfaced as an error and cannot turn the committed message back
        // into an unsent composer payload.
        // A New worktree send saved the chat in the worktree's workspace,
        // which this render has not seen yet.
        // A No workspace draft that needed its own folder was saved in a fresh one.
        if (firstDraft) effectiveWorkspaceIdRef.current = updated.workspaceId;
        if (options?.goal) {
          // The chat exists now (a draft was just saved): set its goal before the answer
          // starts, so the kickoff note rides on it. A refusal leaves an ordinary answer.
          await chatsApi.setGoal(updated.id, options.goal, options.goalSource ?? "slash").catch((error: unknown) => {
            toast.error(error instanceof Error ? error.message : "The goal could not be set.");
          });
        }
        void runGeneration(messageTurnId).then((started) => {
          if (!started.ok && mountedRef.current && chatIdRef.current === chatId) {
            setError(started.error.message);
          }
        });
      } finally {
        if (firstDraft) finishChatDraftSend(chatId, false);
        // The saved chat (or the restored composer text) replaces the progress row.
        worktreeSend?.release();
        if (worktreeSend) setActiveWorktreeGrabbedElements(chatId, undefined);
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
      detachedGenerationDraining,
      imageArtifactRecoveryPending,
      imageArtifactRecoveryUnavailable,
      providerId,
      model,
      selectionThinkingLevel,
      qc,
      runGeneration,
      selectWorkspace,
    ],
  );

  // This view starts the reply for a worktree send the user continued here
  // after leaving the pane that sent it (that pane's send no longer owns it).
  React.useEffect(
    () =>
      registerWorktreeSendContinuation(chatId, (turn) => {
        ++generationIntentRef.current;
        if (turn.workspaceId) effectiveWorkspaceIdRef.current = turn.workspaceId;
        // Per-turn options the sending view kept locally (runGeneration reads
        // the rest from the saved chat and app settings).
        visualizeTurnRef.current = turn.visualize;
        void runGeneration(turn.turnId).then((started) => {
          if (!started.ok && mountedRef.current && chatIdRef.current === chatId) {
            setError(started.error.message);
          }
        });
      }),
    [chatId, runGeneration],
  );

  /** Anything that makes an immediate send unsafe; refreshed below once the queue is known. */
  const visualPromptBusyRef = React.useRef(false);
  /** The user clicked Send (or Add to draft) on a visual's follow-up chip. */
  const handleVisualPrompt = React.useCallback<GuestPromptHandler>(
    (text) => {
      if (visualPromptBusyRef.current) {
        stageComposerText(chatId, text);
        return;
      }
      // Same path as typed input: queue/steer rules, permissions, and a
      // visible user bubble all apply.
      void handleSend(text, []).catch((error: unknown) => {
        stageComposerText(chatId, text);
        toast.error(error instanceof Error ? error.message : "Could not send the visual's follow-up.");
      });
    },
    [chatId, handleSend],
  );
  // Follow-ups confirmed on a workspace artifact go through the same path.
  React.useEffect(
    () => registerChatPromptTarget(chatId, (text) => handleVisualPrompt(text, "")),
    [chatId, handleVisualPrompt],
  );

  const handleStop = React.useCallback(() => {
    if (visibleDetachedProjection && !generationRef.current && !isStoppingGeneration) {
      const { streamId } = visibleDetachedProjection;
      setIsStoppingGeneration(true);
      void chatControl.cancel(streamId).then((cancelled) => {
        if (!cancelled && chatIdRef.current === chatId) setIsStoppingGeneration(false);
      }).catch((error: unknown) => {
        if (chatIdRef.current === chatId) {
          setIsStoppingGeneration(false);
          toast.error(error instanceof Error ? error.message : "Couldn't stop this response.");
        }
      });
      return true;
    }
    if (!generationRef.current || !canStopGeneration) return false;
    setIsStoppingGeneration(true);
    setCanStopGeneration(false);
    generationRef.current.cancel("user_stop");
    return true;
  }, [canStopGeneration, chatControl, chatId, visibleDetachedProjection, isStoppingGeneration]);

  React.useEffect(() => {
    // Detached Stop has no pane-owned terminal callback. The shell clears its
    // exact stream after authoritative settlement; release the local stop UI.
    if (!detachedGenerationDraining && !generationRef.current) setIsStoppingGeneration(false);
  }, [detachedGenerationDraining, detachedProjection]);

  const { queue: messageQueue, snapshot: queuedState } = useChatMessageQueue({
    chatId,
    contextKey: JSON.stringify([
      providerId,
      model,
      effectiveWorkspaceId,
      effectiveWorkspace?.permission,
    ]),
    enabled:
      !draft &&
      ready &&
      !isGenerating &&
      !isStartingGeneration &&
      !isStoppingGeneration &&
      !detachedGenerationDraining &&
      !thinkingSaving &&
      !environmentPanel.gitOperationBusy &&
      !imageArtifactRecoveryPending &&
      !imageArtifactRecoveryUnavailable &&
      !questionnaire &&
      approvals.length === 0,
    send: (message) => {
      if (
        visionSupported === false &&
        withoutGrabbedElementThumbnails(message.attachments).some(
          (attachment) => attachment.kind === "image",
        )
      ) {
        return Promise.reject(
          new Error("Switch to a vision-capable model before resuming these queued images."),
        );
      }
      const sendOptions =
        message.options || message.grabbedElements?.length
          ? {
              ...message.options,
              ...(message.grabbedElements?.length
                ? { grabbedElements: message.grabbedElements }
                : {}),
            }
          : undefined;
      return handleSend(
        message.text,
        message.attachments,
        message.skillInvocation,
        sendOptions,
      );
    },
  });
  // A visual's follow-up must never race a starting run, a detached run, or
  // queued messages; in those states it is staged instead of sent.
  const visualPromptBusy =
    isGenerating ||
    isStartingGeneration ||
    visibleDetachedProjection !== null ||
    queuedState.messages.length > 0;
  React.useLayoutEffect(() => {
    visualPromptBusyRef.current = visualPromptBusy;
  }, [visualPromptBusy]);

  /** Start on the agent's suggested goal: the objective goes as the person's message, with the goal, as `/goal` does. */
  const startProposedGoal = React.useCallback(
    async (objective: string) => {
      if (visualPromptBusyRef.current) throw new Error("Wait for the answer to finish, then press Start.");
      await handleSend(objective, [], undefined, { goal: objective, goalSource: "proposal" });
    },
    [handleSend],
  );

  // Keep-going rounds on screen: tell main which chat this pane shows (a new
  // chat counts as another chat), so a round this window owns elsewhere stops.
  useReportGoalView(draft ? null : chatId);
  React.useEffect(() => {
    if (draft) return;
    return chatsApi.onGoalWindowRound(({ chatId: roundChatId, token }) => {
      if (roundChatId !== chatId) return;
      if (visualPromptBusyRef.current || !mountedRef.current) {
        // Main runs it without this window instead.
        void chatsApi.declineGoalWindowRound(token).catch(() => undefined);
        return;
      }
      ++generationIntentRef.current;
      goalRoundTokenRef.current = token;
      void runGeneration(createChatTurnId());
    });
  }, [chatId, draft, runGeneration]);

  // Main refuses a fork's sends while its summary is pending or failed, so
  // follow-ups wait in the queue until the summary is ready or skipped.
  const forkSummaryHeld = forkSummaryHoldsSend(forkLineage);
  React.useEffect(() => {
    messageQueue.holdForForkSummary(forkSummaryHeld);
  }, [forkSummaryHeld, messageQueue]);

  const queueMessage = React.useCallback(
    async (
      text: string,
      attachments: Attachment[],
      skillInvocation?: SkillInvocationV1,
      options?: {
        visualize?: boolean;
        btw?: boolean;
        goal?: string;
        inputSource?: ChatInputSourceV1;
        grabbedElements?: GrabbedElementContextV1[];
      },
    ) => {
      if (stopRequestedRef.current) {
        throw new Error("Aiden is stopping this response. Send your message after it stops.");
      }
      messageQueue.add({
        id: createChatTurnId(),
        text,
        attachments,
        ...(options?.grabbedElements?.length ? { grabbedElements: options.grabbedElements } : {}),
        skillInvocation,
        options:
          options?.visualize || options?.inputSource
            ? {
                ...(options.visualize ? { visualize: true } : {}),
                ...(options.inputSource ? { inputSource: options.inputSource } : {}),
              }
            : undefined,
      });
    },
    [messageQueue],
  );

  /** Admit run input and show what main committed without waiting for the run to end. */
  const admitSteer = React.useCallback(
    async (streamId: string, text: string, inputSource?: ChatInputSourceV1) => {
      const receipt = await admitRunInputOnceStarted({
        admit: () =>
          chatControl.submitInput(streamId, "steer", text, inputSource ? { inputSource } : undefined),
        // This pane's own run can still be starting; a detached one is not retried.
        live: () => generationRef.current?.streamId === streamId && !stopRequestedRef.current,
      });
      if (receipt.committed && receipt.messageId) {
        const committed = {
          messageId: receipt.messageId,
          text,
          createdAt: Date.now(),
          ...(inputSource ? { inputSource } : {}),
        };
        qc.setQueryData<Chat | null>(queryKeys.chat(chatId), (current) =>
          current ? withCommittedRunInput(current, committed) : current,
        );
      }
      return receipt;
    },
    [chatControl, chatId, qc],
  );

  const steerMessage = React.useCallback(
    async (
      text: string,
      attachments: Attachment[],
      skillInvocation?: SkillInvocationV1,
      options?: { grabbedElements?: GrabbedElementContextV1[] },
    ) => {
      if (!text.trim() || attachments.length > 0 || options?.grabbedElements?.length || skillInvocation) {
        throw new Error("Steer requires text without attachments, browser elements, or a skill.");
      }
      if (text.length > MAX_RUN_INPUT_TEXT) {
        throw new Error("Guidance is too long to steer. Queue it as a follow-up instead.");
      }
      // The same main-owned admission as Remote and Telegram: the guidance is
      // durable in the transcript before Pi reads it. A run that already
      // ended, or ends unsaved while admission waits, queues the draft as the
      // next turn instead; a run the person is stopping keeps the draft.
      const outcome = await steerDraftOrQueue({
        queue: messageQueue,
        message: { id: createChatTurnId(), text, attachments: [] },
        streamId: generationRef.current?.streamId ?? steerableDetachedProjection?.streamId,
        stopping: () => isStoppingGeneration || stopRequestedRef.current,
        admit: (streamId, guidance) => admitSteer(streamId, guidance),
      });
      if (outcome.kind === "admitted") {
        toast.info("Guidance sent. Aiden will read it at the next step.");
      } else if (outcome.kind === "committed") {
        // Main already saved it; resolving consumes the draft so it is not resent.
        toast.info(committedRunInputNotice(outcome.reason));
      } else if (outcome.kind === "queued") {
        // Resolving consumes the draft: the queue now owns the only copy.
        toast.info(lateSteerQueuedNotice(outcome.paused));
      } else if (outcome.kind === "unknown") {
        throw new Error(
          "Aiden couldn't confirm the guidance. Check the conversation before sending it again.",
        );
      } else {
        throw new Error(steerRejectionMessage(outcome.reason));
      }
    },
    [admitSteer, isStoppingGeneration, messageQueue, steerableDetachedProjection],
  );

  const canSteerQueued =
    !draft &&
    (canStopGeneration || Boolean(steerableDetachedProjection)) &&
    !isStoppingGeneration;

  const steerQueued = React.useCallback(
    async (id: string) => {
      const streamId = generationRef.current?.streamId ?? steerableDetachedProjection?.streamId;
      const stopping = () => isStoppingGeneration || stopRequestedRef.current;
      if (stopping()) {
        toast.error(`${steerRejectionMessage("cancelled")} The message stays queued.`);
        return;
      }
      if (!streamId) {
        // The row is already queued; it sends as the next turn once the run settles.
        toast.info(lateSteerQueuedNotice(messageQueue.getSnapshot().paused));
        return;
      }
      const queuedSource = messageQueue
        .getSnapshot()
        .messages.find((message) => message.id === id)?.options?.inputSource;
      const outcome = await steerQueuedMessage({
        queue: messageQueue,
        id,
        admit: (text) => admitSteer(streamId, text, queuedSource),
        stopping,
      });
      if (outcome.kind === "admitted") {
        toast.info("Guidance sent. Aiden will read it at the next step.");
      } else if (outcome.kind === "committed") {
        toast.info(committedRunInputNotice(outcome.reason));
      } else if (outcome.kind === "rejected" && outcome.reason === "run_not_active") {
        // Nothing was saved and the row stays queued, so the queue sends it
        // as the next turn once the run settles.
        toast.info(lateSteerQueuedNotice(messageQueue.getSnapshot().paused));
      } else if (outcome.kind === "rejected") {
        toast.error(`${steerRejectionMessage(outcome.reason)} The message stays queued.`);
      } else if (outcome.kind === "unknown") {
        toast.error(
          "Aiden couldn't confirm the guidance. The queue is paused; check the conversation before resuming.",
        );
      }
    },
    [admitSteer, isStoppingGeneration, messageQueue, steerableDetachedProjection],
  );

  // Aiden Live's chat tools read, send to and stop this chat through the
  // composer's own paths; the message they send shows "By voice".
  useLiveChatController({
    reachable: liveChatReachable(chat.data),
    chatId,
    workspaceId: chatWorkspaceId ?? null,
    isDraft: Boolean(draft),
    title: liveOpenChatTitle,
    messages,
    busy: isGenerating || isStartingGeneration || Boolean(visibleDetachedProjection),
    steerAvailable: !draft && !observedRunVisible && canSteerQueued,
    queueAvailable: !draft,
    hasQueued: queuedState.messages.length > 0,
    queuePaused: queuedState.paused,
    ready: ready && !imageArtifactRecoveryPending && !imageArtifactRecoveryUnavailable,
    firstSending: draft?.sending === true,
    waitingForApproval: approvals.length > 0,
    send: (text) => {
      setDeniedApprovalChatId(null);
      return handleSend(text, [], undefined, { inputSource: "voice" });
    },
    queue: (text) => {
      setDeniedApprovalChatId(null);
      return queueMessage(text, [], undefined, { inputSource: "voice" });
    },
    steer: (text) => {
      const streamId = generationRef.current?.streamId ?? steerableDetachedProjection?.streamId;
      if (!streamId || isStoppingGeneration || stopRequestedRef.current) return Promise.resolve(null);
      setDeniedApprovalChatId(null);
      return admitSteer(streamId, text, "voice");
    },
    stop: () =>
      stopForLive({
        stop: handleStop,
        pauseQueue: () => messageQueue.pause(),
        markStopRequested: () => {
          stopRequestedRef.current = true;
        },
      }),
    showError: (message) => toast.error(message),
  });

  const cancelAgentForContextChange = React.useCallback(() => {
    generationIntentRef.current += 1;
    generationRef.current?.cancel("lifecycle");
    generationRef.current = null;
    generationChatIdRef.current = null;
    clearStreamBuffers();
    resetLiveTurnCore(null);
    setIsStartingGeneration(false);
    setCanStopGeneration(false);
    decidingApprovalRef.current = null;
    setDecidingApprovalId(null);
  }, [clearStreamBuffers, resetLiveTurnCore]);

  React.useEffect(() => {
    environmentPanel.setCancelAgentHandler(cancelAgentForContextChange);
    return () => environmentPanel.setCancelAgentHandler(null);
  }, [cancelAgentForContextChange, environmentPanel.setCancelAgentHandler]);

  const decideApproval = React.useCallback(
    async (
      prompt: ApprovalPrompt,
      decision: "allow" | "deny",
      options?: { formFillExcludedOrders?: number[]; scope?: ToolApprovalScope },
    ) => {
      if (decidingApprovalRef.current) return;
      const decisionChatId = chatId;
      decidingApprovalRef.current = prompt.approvalId;
      setDecidingApprovalId(prompt.approvalId);
      try {
        await chatControl.respondApproval({
          approvalId: prompt.approvalId,
          decision,
          ...(options?.formFillExcludedOrders !== undefined
            ? { formFillExcludedOrders: options.formFillExcludedOrders }
            : {}),
          ...(options?.scope !== undefined ? { scope: options.scope } : {}),
          ...(prompt.source === "remote" ? { source: "remote" as const } : {}),
        });
        if (chatIdRef.current !== decisionChatId) return;
        setApprovals((prev) =>
          prev.filter((approval) => approval.approvalId !== prompt.approvalId),
        );
        setDeniedApprovalChatId(decision === "deny" ? decisionChatId : null);
        const workspaceId = effectiveWorkspaceIdRef.current;
        if (decision === "allow" && options?.scope === undefined && workspaceId && repeatableApproval(prompt)) {
          noteWorkspaceAllow(workspaceId, prompt.toolName);
        }
        showApprovalStatus(
          decision === "deny"
            ? { decision: "deny" }
            : {
                decision: "allow",
                ...(options?.scope ? { scope: options.scope } : {}),
                // Computer Use's always covers every chat; elsewhere it is this workspace's list.
                always: isComputerUseAccessApprovalDetails(prompt.details) ? "everywhere" : "workspace",
              },
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
    [chatControl, chatId, showApprovalStatus],
  );
  // Aiden Live answers the first approval by voice through this same decide.
  usePublishLiveChatApprovals(chatId, approvals, decideApproval);

  // The helper chats read this chat's live helper updates and its approvals.
  const helperChatStore = useSubagentHelperChatStore();
  React.useLayoutEffect(() => {
    helperChatStore?.syncLive(chatId, displayedLiveSubagentTranscripts);
  }, [chatId, displayedLiveSubagentTranscripts, helperChatStore]);
  React.useLayoutEffect(() => {
    helperChatStore?.syncApprovals(chatId, approvals, decidingApprovalId, decideApproval);
  }, [approvals, chatId, decideApproval, decidingApprovalId, helperChatStore]);
  React.useLayoutEffect(() => {
    if (!helperChatStore) return;
    // Leaving the chat closes its expanded helper chat.
    return () => {
      if (helperChatStore.getState().chatId === chatId) helperChatStore.collapse({ restoreFocus: false });
    };
  }, [chatId, helperChatStore]);
  // Only whether this chat's helper chat is expanded; streamed helper tokens do not redraw the pane.
  const helperChatExpanded = useSubagentHelperChatSelector(
    (state) => state.chatId === chatId && state.expandedRunId !== null,
  );

  React.useEffect(() => {
    if (!questionnaire) return;
    const remaining = askUserQuestionMsUntilExpiry(questionnaire, Date.now());
    if (remaining === undefined) return;
    const promptId = questionnaire.promptId;
    const timer = window.setTimeout(() => setExpiredQuestionnaireId(promptId), remaining);
    return () => window.clearTimeout(timer);
  }, [questionnaire]);
  const questionnaireExpired =
    questionnaire !== null && expiredQuestionnaireId === questionnaire.promptId;

  const answerQuestionnaire = React.useCallback(
    async (response: AskUserQuestionResponseV1) => {
      if (!questionnaire || questionnaireSubmitting) return;
      const prompt = questionnaire;
      setQuestionnaireSubmitting(true);
      try {
        // Once the deadline passed the agent has moved on; skip the host round
        // trip and turn a real answer into a follow-up offer.
        const status =
          expiredQuestionnaireId === prompt.promptId
            ? "expired"
            : (await chatControl.answerQuestion({ promptId: prompt.promptId, response, source: prompt.source }))?.status;
        if (chatIdRef.current !== chatId) return;
        setQuestionnaire((current) => current?.promptId === prompt.promptId ? null : current);
        if (status === "expired") {
          setLateQuestionnaireAnswer(
            response.cancelled
              ? null
              : (formatLateAskUserQuestionFollowUp(prompt.questions, response.answers) ?? null),
          );
        }
      } catch (questionError) {
        if (chatIdRef.current !== chatId) return;
        toast.error(
          questionError instanceof Error ? questionError.message : "Couldn't send that answer.",
        );
      } finally {
        if (chatIdRef.current === chatId) setQuestionnaireSubmitting(false);
      }
    },
    [chatControl, chatId, expiredQuestionnaireId, questionnaire, questionnaireSubmitting],
  );

  const sendLateQuestionnaireAnswer = React.useCallback(async () => {
    const text = lateQuestionnaireAnswer;
    if (!text || lateAnswerSending) return;
    setLateAnswerSending(true);
    try {
      // A response still streaming gets the answer as the next queued turn,
      // exactly as if the user had typed it into the composer.
      if (isGenerating || isStartingGeneration) await queueMessage(text, []);
      else await handleSend(text, []);
      if (chatIdRef.current === chatId) setLateQuestionnaireAnswer(null);
    } catch (sendError) {
      if (chatIdRef.current !== chatId) return;
      toast.error(sendError instanceof Error ? sendError.message : "Couldn't send that answer.");
    } finally {
      if (chatIdRef.current === chatId) setLateAnswerSending(false);
    }
  }, [
    chatId,
    handleSend,
    isGenerating,
    isStartingGeneration,
    lateAnswerSending,
    lateQuestionnaireAnswer,
    queueMessage,
  ]);

  // A Computer Use request that stopped on missing macOS permissions leaves a
  // marker on the chat; once ready, Continue resumes it as a normal turn.
  const computerUsePendingContinue =
    !draft && computerUseGloballyEnabled && chat.data?.computerUsePendingContinue === true;
  const [computerUseContinueHiddenFor, setComputerUseContinueHiddenFor] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!computerUsePendingContinue) setComputerUseContinueHiddenFor(null);
  }, [computerUsePendingContinue]);
  const continueComputerUse = React.useCallback(async () => {
    // Main clears the marker when the generation starts; hide the callout now.
    setComputerUseContinueHiddenFor(chatId);
    try {
      await handleSend(COMPUTER_USE_CONTINUE_PROMPT, []);
    } catch (sendError) {
      if (chatIdRef.current !== chatId) return;
      setComputerUseContinueHiddenFor(null);
      toast.error(userFacingErrorMessage(sendError, "Couldn’t continue this chat."));
    }
  }, [chatId, handleSend]);
  const dismissComputerUseContinue = React.useCallback(async () => {
    try {
      const updated = await chatsApi.dismissComputerUseContinue(chatId);
      qc.setQueryData(queryKeys.chat(chatId), updated);
    } catch (dismissError) {
      toast.error(userFacingErrorMessage(dismissError, "Couldn’t dismiss this reminder."));
    }
  }, [chatId, qc]);

  const openFolder = React.useCallback(() => {
    if (effectiveWorkspace?.folderPath) void workspacesApi.openFolder(effectiveWorkspace.id);
  }, [effectiveWorkspace?.folderPath, effectiveWorkspace?.id]);

  const changeApprovals = React.useCallback(
    async (patch: ComposerApprovalsPatch) => {
      if (!effectiveWorkspace) return;
      if (getChatDraft(chatId)?.sending)
        throw new Error("Wait for the first message to finish saving.");
      if (environmentPanel.gitOperationBusy)
        throw new Error(
          "Wait for the current Git operation to finish before changing approvals.",
        );
      if (environmentPanel.editorState.saving)
        throw new Error(
          "Wait for the open file to finish saving before changing approvals.",
        );
      if (environmentPanel.editorState.dirty)
        throw new Error("Save or discard the open file's edits before changing approvals.");
      if (environmentPanel.agentBusy) environmentPanel.cancelAgent?.();
      let targetId = effectiveWorkspace.id;
      // A No workspace draft shares its folder with an existing chat until it
      // is sent. Give it its own folder now so that chat keeps its access.
      if (getChatDraft(chatId) && isNoWorkspace(effectiveWorkspace)) {
        const separateId = await noWorkspaceFolderForFirstSend(
          { listChats: chatsApi.list, createNoWorkspace: workspacesApi.createNoWorkspace },
          effectiveWorkspace.id,
        );
        if (separateId) {
          updateChatDraft(chatId, { workspaceId: separateId });
          selectWorkspace(separateId);
          targetId = separateId;
        }
      }
      await workspacesApi.update(targetId, patch);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.workspaces }),
        qc.invalidateQueries({
          queryKey: queryKeys.skillCatalog(targetId),
        }),
      ]);
    },
    [
      chatId,
      effectiveWorkspace,
      environmentPanel.agentBusy,
      environmentPanel.cancelAgent,
      environmentPanel.editorState.dirty,
      environmentPanel.editorState.saving,
      environmentPanel.gitOperationBusy,
      qc,
      selectWorkspace,
    ],
  );

  // The composer's effort control saves the model's level. A level the chat
  // carries itself (from a slider stop, or the new-chat pick) would override
  // it, so changing the effort in Custom drops that level too.
  const clearOwnThinkingLevel = React.useCallback(() => {
    if (selectionThinkingLevel && providerId && model) select(providerId, model, null);
  }, [model, providerId, select, selectionThinkingLevel]);

  const saveThinkingSetting = React.useCallback(
    async (
      enabled: boolean,
      failureCopy: string,
      save: () => Promise<AppSettings>,
      clearOwnLevel = true,
    ) => {
      if (!enabled || thinkingSaving || isStartingGeneration || isGenerating) return;
      setThinkingSaving(true);
      try {
        const updated = await save();
        qc.setQueryData(queryKeys.settings, updated);
        if (clearOwnLevel) clearOwnThinkingLevel();
      } catch (changeError) {
        toast.error(changeError instanceof Error ? changeError.message : failureCopy);
      } finally {
        setThinkingSaving(false);
      }
    },
    [clearOwnThinkingLevel, isGenerating, isStartingGeneration, qc, thinkingSaving],
  );

  const changeGoogleThinking = React.useCallback(
    (level: GoogleThinkingLevel) => {
      if (!model) return Promise.resolve();
      return saveThinkingSetting(
        googleThinkingSupported,
        "Couldn't save the Gemini thinking level.",
        () => settingsApi.setGoogleThinking(model, level),
      );
    },
    [googleThinkingSupported, model, saveThinkingSetting],
  );

  const changeCodexThinking = React.useCallback(
    (level: CodexThinkingLevel) => {
      if (!model) return Promise.resolve();
      return saveThinkingSetting(
        codexThinkingSupported,
        "Couldn't save the Codex thinking level.",
        () => settingsApi.setCodexThinking(model, level),
      );
    },
    [codexThinkingSupported, model, saveThinkingSetting],
  );

  const changeAnthropicThinking = React.useCallback(
    (level: AnthropicThinkingLevel) => {
      if (!model) return Promise.resolve();
      return saveThinkingSetting(
        anthropicThinkingSupported,
        "Couldn't save the Claude thinking level.",
        () => settingsApi.setAnthropicThinking(model, level),
      );
    },
    [anthropicThinkingSupported, model, saveThinkingSetting],
  );

  const changeProviderThinking = React.useCallback(
    (level: GenerationThinkingLevel) => {
      if (!model) return Promise.resolve();
      return saveThinkingSetting(
        providerThinkingSupported,
        "Couldn't save this model's thinking level.",
        () => settingsApi.setProviderThinking(providerId, model, level),
      );
    },
    [model, providerId, providerThinkingSupported, saveThinkingSetting],
  );

  const changeLocalReasoningVisibility = React.useCallback(
    (visible: boolean) =>
      saveThinkingSetting(
        localReasoningVisibilitySupported,
        "Couldn't save the local reasoning visibility.",
        () =>
          settingsApi.set({
            showLocalModelReasoning: visible,
          }),
        false,
      ),
    [localReasoningVisibilitySupported, saveThinkingSetting],
  );

  // One busy signal for every way of changing a draft's workspace (chip,
  // headline, palette Clone, ⌘⇧O): never retarget a draft mid-send.
  const workspaceChangeBusy = workspaceChangeBusyReason({
    sending: draft?.sending === true,
    generating: isGenerating || isStartingGeneration,
    gitBusy: environmentPanel.gitOperationBusy,
  });

  // Claim a cross-window handoff (e.g. expanding from the Floating Mini-Modal)
  // so an in-flight stream, pending approvals/questions, queued messages, and
  // unsent follow-up drafts transfer seamlessly into this ChatPane.
  const claimPendingHandoffRef = React.useRef<() => void>(() => undefined);
  claimPendingHandoffRef.current = () => {
    const buffer = createGenerationStreamBuffer();
    void claimChatHandoff({ chatId })
      .then((claimed) => {
        if (!claimed || claimed.kind !== "chat") {
          buffer.dispose();
          return;
        }
        const live = claimed.liveStream;
        if (!mountedRef.current || chatIdRef.current !== chatId) {
          buffer.dispose();
          if (live) {
            detachHandoffStream(
              live.streamId,
              { chatId, workspaceId: live.workspaceId },
              {
                content: live.content,
                reasoning: live.reasoning,
                timeline: live.timeline,
                artifacts: live.artifacts,
                uiVisuals: live.uiVisuals,
                subagents: live.subagents,
              },
            );
          }
          return;
        }
        if (claimed.draftText || (claimed.draftAttachments && claimed.draftAttachments.length > 0)) {
          restoreUnsentMessage(
            chatId,
            claimed.draftText ?? "",
            (claimed.draftAttachments ?? []) as Attachment[],
          );
        }
        if (claimed.queuedMessages && claimed.queuedMessages.length > 0) {
          const queue = chatMessageQueue(chatId);
          // If the handed-off run already settled before claim, keep queued items
          // paused so we never auto-send blindly into a failed or finished chat.
          if (!live) queue.pause();
          for (const item of claimed.queuedMessages) {
            try {
              queue.add({
                id: createChatTurnId(),
                text: item.content,
                attachments: (item.attachments ?? []) as Attachment[],
              });
            } catch {
              // Bounded queue full or empty item; best-effort handoff.
            }
          }
        }
        if (!live) {
          buffer.dispose();
          void qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
          return;
        }

        try {
          const generationIntent = (generationIntentRef.current += 1);
          if (deltaFrameRef.current !== null) {
            window.cancelAnimationFrame(deltaFrameRef.current);
            deltaFrameRef.current = null;
          }
          pendingDeltaRef.current = "";
          pendingReasoningDeltaRef.current = "";
          streamedTextRef.current = live.content;
          streamedReasoningRef.current = live.reasoning;
          generationTimelineRef.current = live.timeline;
          streamingArtifactsRef.current = live.artifacts;
          streamHandoffRef.current?.();
          streamHandoffRef.current = null;

          setError(null);
          setHasUnpersistedResponse(false);
          setIsStoppingGeneration(false);
          setIsModelLoading(false);
          setModelCallRetry(null);
          setStreamComplete(false);
          setPersistedHandoffMessageId(null);
          setVisualDrafts(NO_VISUAL_DRAFTS);
          setUiDrafts(NO_UI_DRAFTS);
          setStreamingArtifactPlacements(new Map());
          setStreamingWideVisuals(new Set());
          setStreamingText(live.content);
          setStreamingReasoning(live.reasoning.trim() ? live.reasoning : null);
          setGenerationTimeline(live.timeline);
          setStreamingArtifacts(live.artifacts);
          setStreamingUiVisuals(live.uiVisuals);
          setLiveSubagents(live.subagents);
          if (live.todoSnapshot) {
            todoSnapshotReadFence.markLive(live.todoSnapshot.chatId);
            setTodoSnapshot(live.todoSnapshot);
          }
          if (live.contextPressure) setContextPressure(live.contextPressure);
          setApprovals(
            live.pendingApprovals.map((prompt) => {
              const { scopes, ...rest } = prompt;
              return {
                ...rest,
                ...(scopes ? { scopes: [...scopes] } : {}),
              };
            }),
          );
          setQuestionnaire(live.pendingQuestions[0] ?? null);
          setQuestionnaireSubmitting(false);
          setCanStopGeneration(true);
          if (live.content) markTextStreaming();

          const resolvedWorkspaceId = effectiveWorkspaceIdRef.current ?? live.workspaceId;
          const bufferedNotifications = buffer.drain();
          attachGenerationStream(
            live.streamId,
            { chatId, workspaceId: resolvedWorkspaceId },
            {
              content: live.content,
              reasoning: live.reasoning,
              timeline: live.timeline,
              artifacts: live.artifacts,
              uiVisuals: live.uiVisuals,
              subagents: live.subagents,
            },
            createStreamCallbacks(generationIntent, {
              providerId: chat.data?.providerId,
              fallbackWorkspaceId: live.workspaceId,
            }),
            bufferedNotifications,
            (handle) => {
              // Install handle BEFORE replaying buffered notifications so a
              // buffered terminal `chat:done`/`chat:error` clears it cleanly.
              generationRef.current = handle;
              generationChatIdRef.current = chatId;
            },
          );
        } catch {
          buffer.dispose();
          detachHandoffStream(
            live.streamId,
            { chatId, workspaceId: live.workspaceId },
            {
              content: live.content,
              reasoning: live.reasoning,
              timeline: live.timeline,
              artifacts: live.artifacts,
              uiVisuals: live.uiVisuals,
              subagents: live.subagents,
            },
          );
        }
      })
      .catch(() => {
        buffer.dispose();
      });
  };

  React.useEffect(() => {
    const run = () => {
      if (consumePendingChatHandoff(chatId)) {
        claimPendingHandoffRef.current();
      }
    };
    run();
    return subscribePendingChatHandoff(chatId, run);
  }, [chatId]);
  const [attachDialogOpen, setAttachDialogOpen] = React.useState(false);
  const [promotingEphemeral, setPromotingEphemeral] = React.useState(false);
  const attachWorkspaceBlockedReason = React.useMemo(() => {
    if (documentAppendReconciliationRequired) {
      return "Reload Aiden before attaching to a workspace.";
    }
    if (workspaceChangeBusy) return workspaceChangeBusy;
    if (environmentPanel.editorState.saving) {
      return "Wait for the open file to finish saving before attaching to a workspace.";
    }
    if (environmentPanel.editorState.dirty) {
      return "Save or discard the open file's edits before attaching to a workspace.";
    }
    return null;
  }, [
    documentAppendReconciliationRequired,
    environmentPanel.editorState.dirty,
    environmentPanel.editorState.saving,
    workspaceChangeBusy,
  ]);
  const canAttachChatToWorkspace =
    !isNewChat && Boolean(chat.data) && effectiveWorkspace?.noWorkspace === true;
  const promoteEphemeralChat = React.useCallback(async () => {
    if (promotingEphemeral) return;
    setPromotingEphemeral(true);
    try {
      await qc.cancelQueries({ queryKey: queryKeys.chat(chatId), exact: true });
      const promoted = await chatsApi.promoteEphemeral(chatId);
      qc.setQueryData(queryKeys.chat(chatId), promoted);
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
      toast.success("Saved to Chats");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save this temporary chat.");
    } finally {
      setPromotingEphemeral(false);
    }
  }, [chatId, promotingEphemeral, qc]);
  const moveNewChatToWorkspace = React.useCallback(
    async (workspaceId: string) => {
      if (documentAppendReconciliationRequired) {
        throw new Error("Reload Aiden before changing this chat's workspace.");
      }
      if (!isNewChat) throw new Error("Only a new chat can change workspaces.");
      if (workspaceChangeBusy) throw new Error(workspaceChangeBusy);
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
      if (getChatDraft(chatId)) {
        updateChatDraft(chatId, { workspaceId });
        selectWorkspace(workspaceId);
        return;
      }
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
      workspaceChangeBusy,
    ],
  );

  const createScratchWorkspace = React.useCallback(async () => {
    if (documentAppendReconciliationRequired) {
      throw new Error("Reload Aiden before creating a scratch workspace from this chat.");
    }
    if (!isNewChat) throw new Error("Start a new chat before choosing a scratch folder.");
    if (workspaceChangeBusy) throw new Error(workspaceChangeBusy);
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
    workspaceChangeBusy,
  ]);

  // The workspace menu's No workspace: the draft joins the Chats group. It
  // gets its own hidden folder when sent (see noWorkspaceFolderForFirstSend).
  const chooseNoWorkspace = React.useCallback(async () => {
    let home = noWorkspaceHome(workspaces);
    if (!home) {
      home = await workspacesApi.createNoWorkspace();
      await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    }
    await moveNewChatToWorkspace(home.id);
  }, [moveNewChatToWorkspace, qc, workspaces]);

  // The workspace menu's Open folder… and ⌘⇧O on a draft: the native folder
  // picker registers the folder, then this draft (text, attachments and model
  // included) moves there.
  const openFolderForDraft = React.useCallback(async () => {
    if (documentAppendReconciliationRequired) {
      throw new Error("Reload Aiden before changing this chat's workspace.");
    }
    if (!isNewChat) throw new Error("Only a new chat can change workspaces.");
    if (workspaceChangeBusy) throw new Error(workspaceChangeBusy);
    const workspace = await workspacesApi.createFromFolder();
    if (!workspace) return;
    await adoptWorkspace(qc, workspace);
    await moveNewChatToWorkspace(workspace.id);
  }, [documentAppendReconciliationRequired, isNewChat, moveNewChatToWorkspace, qc, workspaceChangeBusy]);

  // The headline name and app-level entry points open the composer's menu.
  const [cloningProject, setCloningProject] = React.useState(false);
  const [workspaceMenuRequest, setWorkspaceMenuRequest] = React.useState<WorkspaceMenuRequest>();
  const openWorkspaceMenu = React.useCallback((view: DraftWorkspaceMenuView) => {
    setWorkspaceMenuRequest((current) => ({ nonce: (current?.nonce ?? 0) + 1, view }));
  }, []);
  const workspaceMenuAvailable = isNewChat && !documentAppendReconciliationRequired;
  React.useEffect(() => {
    if (!workspaceMenuAvailable) return;
    let frame = 0;
    const unregister = registerDraftWorkspaceMenu(chatId, {
      openFolder: openFolderForDraft,
      // Let a pending composer focus request settle first, so it cannot pull
      // focus out of (and dismiss) the menu that is opening.
      openMenu: (view) => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => openWorkspaceMenu(view));
        });
      },
    });
    return () => {
      cancelAnimationFrame(frame);
      unregister();
    };
  }, [chatId, openFolderForDraft, openWorkspaceMenu, workspaceMenuAvailable]);

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
      performance.mark?.("aiden:worktree-create:start");
      const workspace = await gitApi.createWorktree(effectiveWorkspace.id, branchName);
      performance.mark?.("aiden:worktree-create:done");
      try {
        performance.measure?.(
          "aiden:worktree-create",
          "aiden:worktree-create:start",
          "aiden:worktree-create:done",
        );
      } catch {
        // Ignore missing marks if the performance buffer was cleared.
      }
      upsertCreatedWorkspaceInCache(qc, workspace);
      // Seed folder-presence for the new worktree; leave Git status to main's
      // `infoCache` so synchronous WorktreeSetup hook edits are never hidden.
      if (workspace.folderPath) {
        qc.setQueryData<WorkspaceFolderPresenceResult>(
          queryKeys.workspaceFolderPresence(workspace.id),
          { presence: "present" },
        );
      }
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
      const created = createChatDraft(workspace.id).chat;
      selectWorkspace(workspace.id);
      try {
        await navigate({ to: "/chat/$chatId", params: { chatId: created.id } });
        requestChatDraftComposerFocus(created.id);
      } catch {
        discardChatDraft(created.id);
        selectWorkspace(effectiveWorkspace.id);
        toast.info("The worktree was created, but Aiden could not open its new chat.");
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

  // A draft chooses New worktree in the branch menu; the worktree is created
  // on first send, never from the Environment overview.
  React.useEffect(() => {
    environmentPanel.setCreateWorktreeHandler(isNewChat ? null : createGitWorktree);
    return () => environmentPanel.setCreateWorktreeHandler(null);
  }, [createGitWorktree, environmentPanel.setCreateWorktreeHandler, isNewChat]);

  // Work in, for a draft in a Git repo: this checkout, a new worktree created
  // on first send, or one of the repository's managed worktrees.
  const draftWorkIn = React.useMemo(
    () => (draft ? draftWorkInOptions(workspaces, effectiveWorkspaceId) : undefined),
    [draft, effectiveWorkspaceId, workspaces],
  );
  const draftCanUseWorktree =
    Boolean(draft) && git.data?.isRepo === true && effectiveWorkspace?.permission !== "none";
  // A draft that runs in an existing worktree uses it as it is, and a
  // repository with no commit has nothing to start a worktree from.
  const draftGitMode =
    draft && draftCanUseWorktree && !git.data?.unborn && !draftWorkIn?.selectedWorktreeId
      ? draft.gitMode
      : ("checkout" as const);
  const draftWorktreeBase = draftGitMode === "worktree" ? draft?.worktree?.baseRef : undefined;
  draftWorktreeModeRef.current = draftGitMode === "worktree";
  draftGitPendingRef.current = Boolean(draftGitPending);

  /** Move the draft back to the repository checkout when it sits in a worktree. */
  const moveDraftToRepositoryCheckout = React.useCallback(async () => {
    const source = draftWorkIn?.source;
    if (source && source.id !== effectiveWorkspaceId) await moveNewChatToWorkspace(source.id);
  }, [draftWorkIn?.source, effectiveWorkspaceId, moveNewChatToWorkspace]);

  const selectDraftCheckout = React.useCallback(async () => {
    await moveDraftToRepositoryCheckout();
    setChatDraftGitMode(chatId, "checkout");
  }, [chatId, moveDraftToRepositoryCheckout]);

  const selectDraftNewWorktree = React.useCallback(
    async (branchName?: string) => {
      const name = branchName?.trim();
      if (name && !isValidBranchName(name)) throw new Error("Enter a valid Git branch name.");
      // `/worktree` reaches here without the menu's disabled row.
      if (git.data?.unborn) throw new Error("Create the first commit before starting a new worktree.");
      if (draftWorkIn?.selectedWorktreeId && !draftWorkIn.source) {
        throw new Error(
          "This worktree's repository isn't an Aiden workspace, so a new worktree can't start from it.",
        );
      }
      await moveDraftToRepositoryCheckout();
      setChatDraftGitMode(chatId, "worktree");
      const current = getChatDraft(chatId);
      const workspaceId = current?.chat.workspaceId;
      if (!current || !workspaceId) return;
      let baseRef = current.worktree?.baseRef;
      let fromOrigin = current.worktree?.fromOrigin;
      if (!baseRef) {
        const targetGit =
          workspaceId === effectiveWorkspaceId
            ? git.data
            : qc.getQueryData<GitInfo>(queryKeys.git(workspaceId));
        const seeded = seedDraftWorktreeFromGitInfo(readChatDraftGitMemory(workspaceId), targetGit);
        if (seeded) {
          baseRef = seeded.baseRef;
          fromOrigin = seeded.fromOrigin;
        }
      }
      if (!name) {
        if (baseRef && !current.worktree?.baseRef) {
          updateChatDraftWorktree(chatId, { baseRef, fromOrigin: fromOrigin ?? false });
        }
        return;
      }
      if (!baseRef) {
        // `/worktree <name>` before the menu has read the branches: resolve
        // the base the menu would pick (a local Git read, no network).
        const branches = await qc.fetchQuery<GitBranches>({
          queryKey: queryKeys.gitBranches(workspaceId),
          queryFn: () => gitApi.branches(workspaceId),
          staleTime: 5_000,
        });
        const defaults = resolveDraftWorktreeDefaults(readChatDraftGitMemory(workspaceId), branches);
        if (!defaults) throw new Error("Create the first commit before starting a new worktree.");
        baseRef = defaults.baseRef;
        fromOrigin = defaults.fromOrigin;
      }
      updateChatDraftWorktree(chatId, {
        baseRef,
        ...(fromOrigin !== undefined ? { fromOrigin } : {}),
        branchName: name,
      });
    },
    [chatId, draftWorkIn, effectiveWorkspaceId, git.data, moveDraftToRepositoryCheckout, qc],
  );

  const selectDraftWorktree = React.useCallback(
    async (workspaceId: string) => {
      await moveNewChatToWorkspace(workspaceId);
      // An existing worktree is used as it is, never as a base for another.
      if (getChatDraft(chatId)?.gitMode === "worktree") setChatDraftGitMode(chatId, "checkout");
    },
    [chatId, moveNewChatToWorkspace],
  );

  const updateDraftWorktree = React.useCallback<GitBranchPickerDraft["onUpdateWorktree"]>(
    (update) => updateChatDraftWorktree(chatId, update),
    [chatId],
  );

  const draftGit = React.useMemo<GitBranchPickerDraft | undefined>(
    () =>
      draft && draftWorkIn && draftCanUseWorktree
        ? {
            gitMode: draftGitMode,
            ...(draft.worktree ? { worktree: draft.worktree } : {}),
            workIn: draftWorkIn,
            onSelectCheckout: selectDraftCheckout,
            onSelectNewWorktree: () => selectDraftNewWorktree(),
            onSelectWorktree: selectDraftWorktree,
            onUpdateWorktree: updateDraftWorktree,
          }
        : undefined,
    [
      draft,
      draftCanUseWorktree,
      draftGitMode,
      draftWorkIn,
      selectDraftCheckout,
      selectDraftNewWorktree,
      selectDraftWorktree,
      updateDraftWorktree,
    ],
  );

  const pending = approvals[0];
  // Allowed again and again in Ask: the card offers Auto.
  const repeatNudge = useWorkspaceRepeatNudge(effectiveWorkspace, pending);
  const pendingLiveVoice = useLiveApprovalVoiceHint(pending?.approvalId);
  const showComputerUseContinue =
    computerUsePendingContinue &&
    computerUseContinueHiddenFor !== chatId &&
    !pending &&
    !questionnaire &&
    !isGenerating &&
    !isStartingGeneration &&
    !detachedGenerationDraining &&
    !visibleDetachedProjection;
  const usageLimitWait = useUsageLimitWait("chat", draft ? undefined : chatId);
  const usageLimitNow = useUsageLimitNow(usageLimitWait);
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
    usageLimitWait: usageLimitWait ?? null,
    streamingText:
      canStopGeneration || isStoppingGeneration || detachedGenerationDraining
        ? displayedStreamingText
        : null,
    textStreaming,
    pendingApproval: Boolean(pending),
    toolActivity,
    modelCallRetry,
    // Each ticks only while its own row shows.
    now: usageLimitWait ? usageLimitNow : modelCallRetryNow,
  });
  const visualizingLive =
    (hasActiveToolStep(displayedGenerationTimeline, RENDER_ARTIFACT_TOOL_NAME) ||
      hasActiveToolStep(displayedGenerationTimeline, RENDER_UI_TOOL_NAME)) &&
    !streamComplete && !visibleDetachedProjection;
  const timelineActivity = visualizingLive &&
    agentActivity?.phase !== "waiting" && agentActivity?.phase !== "stopping"
      ? { phase: "visualizing" as const, label: "Visualizing", mark: "scan-grid" as const }
      : agentActivity;
  const chronologicalLiveRows = liveAssistantPresentationRows(
    displayedStreamingText ?? "",
    displayedGenerationTimeline,
    displayedStreamingReasoning ?? "",
  );
  const visibleAgentActivity = resolveVisibleAgentActivity(timelineActivity, {
    reasoningVisible:
      hasActiveThinkingStep(displayedGenerationTimeline) &&
      chronologicalLiveRows?.some((row) => row.kind === "reasoning" && row.step.finishedAt === undefined) === true,
    visualizingVisible:
      visualizingLive && chronologicalLiveRows?.some((row) => row.kind === "activity" &&
        row.steps.some((step) => step.kind === "tool" &&
          (step.toolName === RENDER_ARTIFACT_TOOL_NAME || step.toolName === RENDER_UI_TOOL_NAME))) === true,
    toolVisible:
      chronologicalLiveRows?.some((row) => row.kind === "activity" &&
        row.steps.some((step) => step.kind === "tool" &&
          (step.status === "pending" || step.status === "running"))) === true,
  });

  React.useEffect(() => {
    if (!pending) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const takeFocus = approvalShouldTakeFocus({
      typing:
        isEditableTypingTarget(previousFocus) || isReservedTypingSurface(previousFocus),
      overlayOpen: typingRedirectBlockedByOverlay(previousFocus),
    });
    if (!takeFocus) return;
    const frame = requestAnimationFrame(() => approvalDenyRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      // A chat opened from the sidebar (an Inbox row, ⌘1–9) answers in the chat:
      // once the prompt resolves, focus stays with the composer.
      if (previousFocus && !previousFocus.closest("[data-sidebar]")) {
        requestAnimationFrame(() => returnFocus([previousFocus]));
      }
    };
  }, [pending?.approvalId]);

  React.useLayoutEffect(() => {
    if (pending) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && approvalCardRef.current?.contains(focused)) {
      composerRef.current?.focus({ preventScroll: true });
    }
  }, [pending]);

  const compactChat = React.useCallback(
    async (engine?: CompactionEngine) => {
      const compactChatId = chatId;
      // Follow-ups typed during compaction queue behind it and
      // wait until it settles, even if the user leaves the chat.
      const compactQueue = chatMessageQueue(compactChatId);
      let compactOutcome: Awaited<ReturnType<typeof chatsApi.compact>> | undefined;
      compactQueue.holdForCompaction();
      setContextCompactPending(true);
      try {
        const result = await chatsApi.compact(compactChatId, engine);
        compactOutcome = result;
        // The pane may now show another chat; its meter
        // chrome belongs to that chat, not this compaction.
        if (result.compacted && chatIdRef.current === compactChatId) {
          setContextCompactedFlash(true);
          if (contextCompactedTimerRef.current !== null) {
            window.clearTimeout(contextCompactedTimerRef.current);
          }
          contextCompactedTimerRef.current = window.setTimeout(() => {
            contextCompactedTimerRef.current = null;
            setContextCompactedFlash(false);
          }, 6_000);
        }
        return result;
      } finally {
        if (chatIdRef.current === compactChatId) setContextCompactPending(false);
        if (compactQueue.releaseCompactionHold(compactOutcome)) {
          const count = compactQueue.getSnapshot().messages.length;
          toast.info(
            `Compaction didn't finish, so ${count === 1 ? "your queued message is" : `${count} queued messages are`} paused. Resume the queue to send ${count === 1 ? "it" : "them"}.`,
          );
        }
      }
    },
    [chatId],
  );

  // --- Read aloud wiring --------------------------------------------------
  // Local candidate mirrors main's policy: the last assistant message after
  // the latest user turn, while no live generation row is mounted. Main
  // revalidates authoritatively on every start and segment.
  const transcriptIdle = displayedStreamingText === null && !isStartingGeneration;
  const readAloudCandidateId = React.useMemo(() => {
    if (!transcriptIdle) return undefined;
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
      const message = messages[index]!;
      if (message.role === "assistant") {
        // Never scan past a newer failed or empty response.
        return message.providerFailure === undefined &&
          (!message.timeline || message.timeline.status === "completed") && message.content.trim().length > 0
          ? message.id : undefined;
      }
    }
    return undefined;
  }, [messages, transcriptIdle]);

  // The latest reply failed: its card offers the next step that fits the cause.
  const failedReplyId = React.useMemo(() => {
    if (!transcriptIdle || draft) return undefined;
    const last = messages[messages.length - 1];
    return last?.role === "assistant" && last.providerFailure ? last.id : undefined;
  }, [draft, messages, transcriptIdle]);
  // A card action belongs to the chat it started in: each chat's card is busy
  // only while its own action runs, and only that action clears it.
  const failureActionTokenRef = React.useRef(0);
  const [failureActionOwners, setFailureActionOwners] = React.useState<
    Readonly<Record<string, number>>
  >({});
  const failureActionBusy = failureActionOwners[chatId] !== undefined;
  const runFailureAction = React.useCallback(
    async (action: ProviderFailureAction) => {
      if (action === "open_providers") {
        void navigate({ to: "/settings", search: { section: "providers" } });
        return;
      }
      const token = ++failureActionTokenRef.current;
      setFailureActionOwners((owners) => ({ ...owners, [chatId]: token }));
      try {
        if (action === "compact") {
          const result = await compactChat();
          // Already compact (an earlier press finished while the person was away) still sends.
          if (!result.compacted && result.reason !== "already_compact") return;
          // The pane may show another chat now: skip the follow-up, and this
          // chat's card is still there when the person comes back.
          if (chatIdRef.current !== chatId) return;
        }
        await handleSend(
          action === "continue" ? PROVIDER_FAILURE_FOLLOW_UPS.continue : PROVIDER_FAILURE_FOLLOW_UPS.try_again,
          [],
        );
      } catch (actionError) {
        if (chatIdRef.current !== chatId) return;
        toast.error(userFacingErrorMessage(actionError, "Couldn’t continue this chat."));
      } finally {
        setFailureActionOwners((owners) => {
          if (owners[chatId] !== token) return owners;
          const { [chatId]: _settled, ...rest } = owners;
          return rest;
        });
      }
    },
    [chatId, compactChat, handleSend, navigate],
  );
  const failureActions = React.useMemo(
    () =>
      failedReplyId
        ? {
            messageId: failedReplyId,
            busy: failureActionBusy,
            onAction: (action: ProviderFailureAction) => void runFailureAction(action),
            onSwitchModel: () => commandSystem.execute("model.change"),
          }
        : undefined,
    [commandSystem, failedReplyId, failureActionBusy, runFailureAction],
  );

  // A reply cut short by a quit or crash offers Resume; it never resumes itself.
  const replyInterruptedQuery = useQuery({
    queryKey: ["chat-reply-interrupted", chatId, messages.length],
    queryFn: () => chatsApi.replyInterrupted(chatId),
    enabled: transcriptIdle && !draft && messages.length > 0,
    staleTime: Infinity,
    // An unreadable run history only hides the offer; don't keep asking.
    retry: false,
  });
  // Like the failure card, a Resume press is busy only in its own chat.
  const resumeTokenRef = React.useRef(0);
  const [resumeOwners, setResumeOwners] = React.useState<Readonly<Record<string, number>>>({});
  const resumeBusy = resumeOwners[chatId] !== undefined;
  const resumeInterruptedReply = React.useCallback(async () => {
    const token = ++resumeTokenRef.current;
    setResumeOwners((owners) => ({ ...owners, [chatId]: token }));
    try {
      await handleSend(INTERRUPTED_REPLY_FOLLOW_UP, []);
    } catch (resumeError) {
      if (chatIdRef.current !== chatId) return;
      toast.error(userFacingErrorMessage(resumeError, "Couldn’t resume this chat."));
    } finally {
      setResumeOwners((owners) => {
        if (owners[chatId] !== token) return owners;
        const { [chatId]: _settled, ...rest } = owners;
        return rest;
      });
    }
  }, [chatId, handleSend]);
  const replyInterrupted = transcriptIdle && !draft && !failedReplyId && replyInterruptedQuery.data === true;
  // What the interrupted reply was waiting on. A question is offered again in
  // place of Resume; an approval is only named on the Resume card.
  const interruptedWaitsQuery = useQuery({
    queryKey: ["chat-interrupted-waits", chatId, messages.length],
    queryFn: () => chatsApi.interruptedWaits(chatId),
    enabled: replyInterruptedQuery.data === true,
    staleTime: Infinity,
    retry: false,
  });
  const [dismissedWaitIds, setDismissedWaitIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const interruptedWaits = React.useMemo(
    () =>
      replyInterrupted ? (interruptedWaitsQuery.data ?? []).filter((wait) => !dismissedWaitIds.has(wait.waitId)) : [],
    [dismissedWaitIds, interruptedWaitsQuery.data, replyInterrupted],
  );
  const recoveredQuestion = React.useMemo<AskUserQuestionPromptV1 | undefined>(() => {
    const wait = interruptedWaits.find((item) => item.kind === "question");
    return wait?.kind === "question" && !questionnaire
      ? {
          version: ASK_USER_QUESTION_VERSION,
          promptId: wait.waitId,
          streamId: "s-recovered",
          toolCallId: "recovered",
          questions: wait.questions,
        }
      : undefined;
  }, [interruptedWaits, questionnaire]);
  // An expanded helper chat says when the main chat waits on a question, and
  // its Back to main chat lands on the approval or question waiting here.
  const mainQuestionPending = Boolean(questionnaire || recoveredQuestion);
  // A question replaces the message box, and the questionnaire is the message
  // box's focus area then.
  const focusMainWaiting = React.useCallback((kind: MainChatWaitingKind) => {
    if (kind === "approval") {
      // The card itself, never a decision button: arriving here answers nothing.
      const target = approvalCardRef.current;
      if (target?.isConnected) {
        revealApprovalCard(target);
        return;
      }
    }
    focusRegion("composer");
  }, []);
  React.useLayoutEffect(() => {
    helperChatStore?.syncMainWaiting(chatId, mainQuestionPending, focusMainWaiting);
  }, [chatId, focusMainWaiting, helperChatStore, mainQuestionPending]);
  // Like Resume, sending a recovered answer is busy only in its own chat.
  const recoveredAnswerTokenRef = React.useRef(0);
  const [recoveredAnswerOwners, setRecoveredAnswerOwners] = React.useState<Readonly<Record<string, number>>>({});
  const recoveredAnswerSending = recoveredAnswerOwners[chatId] !== undefined;
  const answerRecoveredQuestion = React.useCallback(
    async (response: AskUserQuestionResponseV1) => {
      if (!recoveredQuestion || recoveredAnswerSending) return;
      const waitId = recoveredQuestion.promptId;
      const token = ++recoveredAnswerTokenRef.current;
      setRecoveredAnswerOwners((owners) => ({ ...owners, [chatId]: token }));
      try {
        // Closing the card leaves the plain Resume card; Submit always sends, skipped questions included.
        if (!response.cancelled) {
          await handleSend(formatRecoveredAskUserQuestionAnswers(recoveredQuestion.questions, response.answers), []);
        }
        setDismissedWaitIds((ids) => new Set(ids).add(waitId));
        // Once the host forgets the wait, drop it from the cached reads too, so
        // the card stays gone when the pane opens this chat again.
        void chatsApi
          .dismissInterruptedWait(chatId, waitId)
          .then(() =>
            qc.setQueriesData<InterruptedWaitV1[]>({ queryKey: ["chat-interrupted-waits", chatId] }, (waits) =>
              waits?.filter((wait) => wait.waitId !== waitId),
            ),
          )
          .catch(() => undefined);
      } catch (answerError) {
        if (chatIdRef.current !== chatId) return;
        toast.error(userFacingErrorMessage(answerError, "Couldn’t send your answers."));
      } finally {
        setRecoveredAnswerOwners((owners) => {
          if (owners[chatId] !== token) return owners;
          const { [chatId]: _settled, ...rest } = owners;
          return rest;
        });
      }
    },
    [chatId, handleSend, qc, recoveredAnswerSending, recoveredQuestion],
  );
  // Held until the saved waits are read, so Resume never shows in front of a question it would orphan.
  const interruptedWaitsRead = interruptedWaitsQuery.isFetched || interruptedWaitsQuery.isError;
  const interruptedReply = React.useMemo(() => {
    if (!replyInterrupted || !interruptedWaitsRead || recoveredQuestion) return undefined;
    const approvalSummaries = interruptedWaits.flatMap((wait) => (wait.kind === "approval" ? [wait.summary] : []));
    return {
      busy: resumeBusy,
      onResume: () => void resumeInterruptedReply(),
      ...(approvalSummaries.length ? { approvalSummaries } : {}),
    };
  }, [interruptedWaits, interruptedWaitsRead, recoveredQuestion, replyInterrupted, resumeBusy, resumeInterruptedReply]);

  React.useEffect(() => {
    void readAloudController.refreshStatus(chatId);
    return () => readAloudController.stop();
  }, [chatId, readAloudCandidateId, readAloudController]);

  const readAloudActive =
    readAloudState.job?.kind === "read-aloud" &&
    readAloudState.job.chatId === chatId &&
    (readAloudState.busy || readAloudState.playing || readAloudState.paused);
  const readAloudPhase: ReadAloudActionProps["phase"] = !readAloudState.status
    ? "not-configured"
    : !readAloudState.status.synthesisReady
      ? "not-configured"
      : readAloudActive || readAloudState.busy
        ? readAloudState.paused
          ? "paused"
          : readAloudState.playing
            ? "playing"
            : "busy"
        : readAloudState.error
          ? "error"
          : "ready";
  const readAloudProps: ReadAloudActionProps | undefined = readAloudCandidateId &&
    (!readAloudState.latestSource || readAloudState.latestSource.source?.messageId === readAloudCandidateId)
    ? {
        active: Boolean(readAloudActive || readAloudState.busy),
        phase: readAloudPhase,
        omissions: readAloudState.job?.omissions ?? [],
        error: readAloudState.error?.message,
        onActivate: () => {
          const source = readAloudState.latestSource?.source;
          if (!readAloudState.status?.synthesisReady) {
            void navigate({ to: "/settings", search: { section: "tts" } });
            return;
          }
          if (!source || source.messageId !== readAloudCandidateId) {
            void readAloudController.refreshStatus(chatId);
            return;
          }
          void readAloudController.start(source);
        },
        onStop: () => readAloudController.stop(),
        onTogglePause: () => {
          if (readAloudState.paused) void readAloudController.resume();
          else void readAloudController.pause();
        },
      }
    : undefined;
  const floatingChromeVisible = todoPanelHasVisibleChrome(todoSnapshot) || subagentPillVisible;

  // A Bot chat redirects to its Bot route above; render nothing while it leaves.
  if (botChatId) return null;

  const chatTitleMenu = (
    <ChatTitleMenu
      title={chat.data?.title ?? "New agent"}
      persisted={!draft && Boolean(persistedChat.data)}
      onRename={renameChat}
      onDuplicate={() => copyChat()}
      duplicateDisabledReason={forkDisabledReason}
    />
  );

  const newChatHeadline = (
    <NewChatHeadline
      workspace={effectiveWorkspace}
      workspaces={workspaces}
      onChooseWorkspace={
        workspaceMenuAvailable && !settingsBlockedReason && !workspaceChangeBusy
          ? () => openWorkspaceMenu("list")
          : undefined
      }
    />
  );

  return (
    <>
      <ScrollArea
        focusRegion="chat"
        bodyHidden={designChatBodyHidden}
        bodyReplacement={
          helperChatExpanded ? <ExpandedSubagentHelperChat chatId={chatId} /> : undefined
        }
        overlay={findBar}
        toolbarAccessory={<DesignModeBannerSlot />}
        className="h-full min-h-0"
        alignFooterToScrollContent
        title={
          forkSourceLabel || startedByLabel || startedByChat ? (
            <span
              className="block min-w-0"
              data-chat-fork-lineage={forkSourceLabel ? true : undefined}
              data-chat-started-by={startedByLabel ? true : undefined}
              data-chat-started-by-chat={startedByChat ? true : undefined}
            >
              {chatTitleMenu}
              {startedByChat ? (
                <span className="flex min-w-0 items-center gap-1 text-small font-normal text-secondary">
                  <MessagesSquare aria-hidden="true" className="size-3 shrink-0" />
                  {leadChat ? (
                    <button
                      type="button"
                      className="min-w-0 truncate rounded-control text-left outline-none hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                      onClick={() => void navigate({ to: "/chat/$chatId", params: { chatId: leadChat.id } })}
                    >
                      {startedByChat}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate">{startedByChat}</span>
                  )}
                </span>
              ) : null}
              {forkSourceLabel ? (
                <span className="flex min-w-0 items-center gap-1 text-small font-normal text-secondary">
                  <GitFork aria-hidden="true" className="size-3 shrink-0" />
                  {forkSource ? (
                    <button
                      type="button"
                      className="min-w-0 truncate rounded-control text-left outline-none hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                      onClick={() =>
                        void navigate({ to: "/chat/$chatId", params: { chatId: forkSource.id } })
                      }
                    >
                      {forkSourceLabel}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate">{forkSourceLabel}</span>
                  )}
                </span>
              ) : null}
              {startedByLabel ? (
                <span className="flex min-w-0 items-center gap-1 text-small font-normal text-secondary">
                  <AppWindow aria-hidden="true" className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">{startedByLabel}</span>
                </span>
              ) : null}
            </span>
          ) : (
            chatTitleMenu
          )
        }
        titleAccessory={
          effectiveWorkspace || chat.data?.ephemeral === true ? (
            <div className="no-drag flex min-w-0 items-center gap-1.5">
              {effectiveWorkspace && !(chat.data?.ephemeral === true && isNoWorkspace(effectiveWorkspace)) ? (
                <WorkspaceChip
                  workspace={effectiveWorkspace}
                  git={effectiveWorkspace.folderPath ? git.data : undefined}
                  canOpenTerminal={Boolean(effectiveWorkspace.folderPath && terminal.canOpen)}
                  onOpenTerminal={() => {
                    if (!terminal.open) terminal.toggle();
                  }}
                  onAttachToWorkspace={
                    canAttachChatToWorkspace ? () => setAttachDialogOpen(true) : undefined
                  }
                  attachDisabledReason={attachWorkspaceBlockedReason}
                />
              ) : null}
              {chat.data?.ephemeral === true ? (
                <div className="workspace-chip flex min-w-0 shrink items-center gap-1 overflow-hidden">
                  <Badge color="warning" className="shrink-0 whitespace-nowrap">
                    Temporary
                  </Badge>
                  {!isNewChat ? (
                    <>
                      <Button
                        variant="bar"
                        size="small"
                        disabled={promotingEphemeral}
                        onClick={() => void promoteEphemeralChat()}
                      >
                        Save
                      </Button>
                      <Button
                        variant="bar"
                        size="small"
                        disabled={Boolean(attachWorkspaceBlockedReason)}
                        aria-label="Attach to workspace"
                        title={attachWorkspaceBlockedReason ?? "Attach to workspace"}
                        onClick={() => setAttachDialogOpen(true)}
                      >
                        Attach…
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null
        }
        actions={
          <WorkspaceToolButtons
            chatId={chatId}
            hasWorkspace={Boolean(effectiveWorkspace)}
            hasFolder={Boolean(effectiveWorkspace?.folderPath)}
            hasFolderAccess={Boolean(
              effectiveWorkspace?.folderPath && effectiveWorkspace.permission !== "none",
            )}
            // A cached repository read must not outlive access being switched off.
            isRepo={git.data?.isRepo === true && effectiveWorkspace?.permission !== "none"}
            leading={
              <>
                <DesignModeToggle chatId={chatId} />
                <DesignPaneSwitch />
              </>
            }
            foldable={[
              {
                key: "quick-view",
                placement: "leading",
                button: <QuickViewToggle />,
                label: environmentPanel.quickViewOpen ? "Hide Quick View" : "Show Quick View",
                icon: QuickViewIcon,
                onSelect: environmentPanel.toggleQuickView,
                disabled: environmentPanel.gitOperationDimmed,
                active: environmentPanel.quickViewOpen,
                // A chat with no workspace has nothing for Quick View to show.
                available: Boolean(effectiveWorkspace),
              },
              {
                key: "terminal",
                button: (
                  <Button
                    iconOnly
                    variant="bar"
                    size="small"
                    onClick={terminal.toggle}
                    aria-label={terminal.open ? "Hide terminal" : "Show terminal"}
                    aria-keyshortcuts={ariaKeyShortcut(terminalShortcutBinding)}
                    aria-pressed={terminal.open}
                    title={`Toggle terminal (${terminalShortcut})`}
                    data-terminal-toggle
                  >
                    <TerminalSquare />
                  </Button>
                ),
                label: terminal.open ? "Hide terminal" : "Show terminal",
                icon: TerminalSquare,
                onSelect: terminal.toggle,
                active: terminal.open,
                // Left out without a folder or with workspace access off (the
                // workspace chip says why), unless a terminal is still open to close.
                available: Boolean(effectiveWorkspace?.folderPath && (terminal.canOpen || terminal.open)),
              },
            ]}
            trailing={
              <OpenInEditorPicker
                workspaceId={effectiveWorkspace?.id}
                folderPath={effectiveWorkspace?.folderPath}
              />
            }
            end={<EnvironmentPanelToggle />}
          />
        }
        autoScrollToBottom
        autoScrollResetKey={chatId}
        autoScrollDeps={[
          messages.length,
          displayedStreamingText,
          displayedStreamingReasoning,
          displayedGenerationTimeline,
          agentActivity?.phase,
          worktreeSend?.view.status,
          worktreeSend?.view.progress.phase,
          approvals.length,
          questionnaire?.promptId,
          displayedStreamingArtifacts.length,
        ]}
        showScrollToBottomButton
        streaming={displayedStreamingText !== null}
        {...composerFloatingRowOffsets(floatingChromeVisible, floatingRowHeight)}
        footer={
          <ScrollAreaFooterStack>
            <EventPresence
              present={Boolean(pending) || approvalStatus.status !== null}
              className="aiden-dock-inset chat-content-column flex min-h-0 flex-col pb-2"
            >
              {pending ? (
                <ChatApprovalCard
                  pending={pending}
                  deciding={decidingApprovalId === pending.approvalId}
                  onDecide={(decision, options) => void decideApproval(pending, decision, options)}
                  cardRef={approvalCardRef}
                  denyRef={approvalDenyRef}
                  pendingCount={approvals.length}
                  keyboardShortcuts={!helperChatExpanded}
                  liveVoice={pendingLiveVoice}
                  {...repeatNudge}
                />
              ) : approvalStatus.status ? (
                <ApprovalStatusLine status={approvalStatus.status} />
              ) : null}
            </EventPresence>
            <EventPresence
              present={showComputerUseContinue}
              className="aiden-dock-inset chat-content-column pb-2"
            >
              {showComputerUseContinue ? (
                <ComputerUseContinueCallout
                  onContinue={continueComputerUse}
                  onDismiss={dismissComputerUseContinue}
                  continueDisabledReason={
                    ready ? undefined : (readinessMessage ?? "This chat can’t send right now.")
                  }
                />
              ) : null}
            </EventPresence>
            <ComposerFloatingRow
              onHeightChange={setFloatingRowHeight}
              onCoveredBottomChange={setSubagentGroupBottomInset}
            >
              <TodoPanel snapshot={todoSnapshot} floating={false} />
              {subagentPill.model && subagentPillShown ? (
                <SubagentComposerPill
                  className="agent-event-in"
                  model={subagentPill.model}
                  open={subagentTrayOpen}
                  onOpenChange={setSubagentTrayOpen}
                  stopPendingRunIds={environmentPanel.subagentStopPendingRunIds}
                  stopErrors={environmentPanel.subagentStopErrorsByRunId}
                  onOpenRun={environmentPanel.openSubagent}
                  onOpenPanel={(returnTarget) => environmentPanel.showTools("subagents", returnTarget)}
                  onStop={environmentPanel.stopSubagent}
                  onShowInChat={showSubagentsInChat}
                  shortcut={subagentTrayShortcut}
                  onDismiss={() => {
                    setSubagentTrayOpen(false);
                    subagentPill.dismiss();
                  }}
                  returnFocus={() =>
                    // Stepping aside for its card hands focus to that card.
                    onScreenSubagentGroupElement(subagentPillGenerations)?.querySelector<HTMLElement>(
                      "[data-subagent-chip-group-toggle]",
                    ) ?? composerRef.current
                  }
                />
              ) : null}
            </ComposerFloatingRow>
            {draft ? null : (
              <ChatGoalBar
                chatId={chatId}
                className="aiden-dock-inset chat-content-column pb-2"
                onStartProposal={startProposedGoal}
              />
            )}
            {spending.status ? (
              <SpendingLimitNotice
                status={spending.status}
                allowing={spending.allowing}
                onAllowMore={() => void spending.allowMore()}
                className="aiden-dock-inset chat-content-column pb-2"
              />
            ) : null}
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
            {lateQuestionnaireAnswer && !questionnaire ? (
              <AskUserQuestionExpiryNotice
                state="late-answer"
                sending={lateAnswerSending}
                queued={isGenerating || isStartingGeneration}
                onDiscard={() => setLateQuestionnaireAnswer(null)}
                onSend={() => void sendLateQuestionnaireAnswer()}
              />
            ) : null}
            {questionnaireExpired ? <AskUserQuestionExpiryNotice state="expired" /> : null}
            {questionnaire?.expiresAt && !questionnaireExpired ? (
              <AskUserQuestionCountdown
                key={`countdown:${questionnaire.promptId}`}
                expiresAt={questionnaire.expiresAt}
              />
            ) : null}
            {recoveredQuestion ? <AskUserQuestionExpiryNotice state="restarted" /> : null}
            {designModeConsent && !questionnaire ? (
              <DesignModeConsentCard key={designModeConsent.requestId} request={designModeConsent} />
            ) : null}
            {missingWorkspaceFolder && !questionnaire ? (
              <WorkspaceFolderMissingNotice
                workspaceName={missingWorkspaceFolder.name}
                folder={missingWorkspaceFolder.folder}
                {...(missingWorkspaceFolder.worktree ? { worktree: missingWorkspaceFolder.worktree } : {})}
                checking={folderPresenceQuery.isFetching}
                restoring={restoringWorktree}
                continuing={continuingInNewChat}
                continueChoices={continueChoices}
                onContinueIn={(workspaceId) => void continueInNewChat(workspaceId)}
                onCheckAgain={() => void folderPresenceQuery.refetch()}
                onRestore={() => void restoreDeletedWorktree(missingWorkspaceFolder.id)}
                onNewChatInMain={newChatActions ? () => {
                  const mainWorkspaceId = missingWorkspaceFolder.worktree?.mainWorkspaceId;
                  if (mainWorkspaceId) newChatInMainCheckout(mainWorkspaceId);
                } : undefined}
              />
            ) : null}
            {questionnaire ? (
              <AskUserQuestionComposer
                key={questionnaire.promptId}
                prompt={questionnaire}
                submitting={questionnaireSubmitting}
                onRespond={answerQuestionnaire}
              />
            ) : recoveredQuestion ? (
              <AskUserQuestionComposer
                key={recoveredQuestion.promptId}
                prompt={recoveredQuestion}
                submitting={recoveredAnswerSending}
                onRespond={answerRecoveredQuestion}
              />
            ) : (
              <Composer
                // Keyed so the draft and attachments stay scoped to one chat. The
                // route no longer remounts the pane, and Composer owns that text
                // without a chatId reset of its own.
                key={chatId}
                ready={ready && !imageArtifactRecoveryPending && !imageArtifactRecoveryUnavailable}
                readinessSettingsSection={!chatReadinessMessage && modelReadinessMessage ? "providers" : undefined}
                readinessMessage={
                  imageArtifactRecoveryUnavailable
                    ? "Visual artifact staging is unavailable. Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair."
                    : imageArtifactRecoveryPending
                      ? "A visual artifact could not be recovered. Delete this chat to discard it before sending another message."
                      : readinessMessage
                }
                hasMessages={hasMessages}
                chatId={chatId}
                initialText={draft?.initialText}
                placeholder={
                  deniedApprovalChatId === chatId && approvals.length === 0
                    ? DENIED_APPROVAL_COMPOSER_PLACEHOLDER
                    : undefined
                }
                onSend={(...args) => {
                  setDeniedApprovalChatId(null);
                  approvalStatus.clear();
                  return handleSend(...args);
                }}
                freezeWhileSending={Boolean(draft)}
                firstMessageSaving={draft?.sending === true}
                firstSendStatus={
                  worktreeSend?.view.status === "failed"
                    ? "Choose how to continue above."
                    : undefined
                }
                onQueue={
                  draft
                    ? undefined
                    : (...args) => {
                        setDeniedApprovalChatId(null);
                        return queueMessage(...args);
                      }
                }
                onSteer={
                  draft || observedRunVisible
                    ? undefined
                    : (text, attachments, skillInvocation, options) => {
                        setDeniedApprovalChatId(null);
                        return steerMessage(text, attachments, skillInvocation, options);
                      }
                }
                hasQueuedMessages={queuedState.messages.length > 0}
                offerLive={liveChatReachable(chat.data)}
                compactionHeld={queuedState.holdReason === "compaction"}
                forkSummaryHold={
                  forkSummary?.state === "pending" || forkSummary?.state === "failed"
                    ? forkSummary.state
                    : undefined
                }
                queuedMessages={
                  <QueuedMessages
                    key={chatId}
                    queue={messageQueue}
                    canSteer={canSteerQueued}
                    onSteer={steerQueued}
                    returnFocus={() => composerRef.current}
                  />
                }
                onStop={() => {
                  // Stop ends this response only. Queued follow-ups stay
                  // visible, paused, so the user can resume or delete them.
                  messageQueue.pause();
                  if (handleStop()) stopRequestedRef.current = true;
                }}
                isGenerating={isGenerating || isStartingGeneration || Boolean(visibleDetachedProjection)}
                canStopGeneration={(canStopGeneration || Boolean(visibleDetachedProjection)) && !isStoppingGeneration}
                stoppingGeneration={isStoppingGeneration}
                configurationBusy={thinkingSaving}
                inputRef={composerRef}
                workspace={effectiveWorkspace}
                gitBranch={git.data?.isRepo ? git.data.branch : undefined}
                gitDetached={git.data?.detached}
                gitUnborn={git.data?.unborn}
                gitStatus={git.data?.isRepo ? git.data : undefined}
                onOpenFolder={openFolder}
                onChangeApprovals={changeApprovals}
                workspacePickerEnabled={isNewChat}
                machinePicker={
                  // A new chat may run on a paired Mac instead.
                  isNewChat && newChatMachines.length > 0 ? (
                    <RemoteMachinePicker
                      machines={newChatMachines}
                      selected="local"
                      // Only a Git project can be cloned. A No workspace chat, a scratch
                      // folder or any other folder outside a repository has none to offer.
                      onAddProject={
                        effectiveWorkspace?.folderPath && !isNoWorkspace(effectiveWorkspace) && git.data?.isRepo === true
                          ? () => setCloningProject(true)
                          : undefined
                      }
                      disabled={isGenerating || isStartingGeneration}
                      onSelect={(machine) => {
                        if (machine !== "local") void navigate({ to: "/host/$hostId/new", params: { hostId: machine } });
                      }}
                    />
                  ) : undefined
                }
                workspaces={workspaces}
                onSelectWorkspace={moveNewChatToWorkspace}
                onCreateScratchWorkspace={createScratchWorkspace}
                onChooseNoWorkspace={chooseNoWorkspace}
                onOpenFolderAsWorkspace={openFolderForDraft}
                workspaceMenuRequest={workspaceMenuRequest}
                onCreateGitWorktree={createGitWorktree}
                draftGit={draftGit}
                onDraftNewWorktree={draftGit ? selectDraftNewWorktree : undefined}
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
                sessionChat={draft ? undefined : (chat.data ?? undefined)}
                authenticatedProviders={authenticatedProviders}
                onCloneChat={() => copyChat()}
                onForkChat={(messageId, position) => forkFromMessage(messageId, position)}
                onForkWithSummary={(messageId, position) =>
                  setForkSummaryRequest({ messageId, position })
                }
                onExportChat={exportChat}
                onCompactChat={draft ? undefined : compactChat}
                onCancelCompact={draft ? undefined : () => chatsApi.cancelCompact(chatId)}
                onLogoutProvider={logoutProvider}
                thinkingControl={
                  stopSetsEffort && !localReasoningVisibilitySupported ? undefined : stopSetsEffort ? (
                    <ReasoningVisibilityControl
                      visible={showLocalModelReasoning}
                      disabled={thinkingSaving || isStartingGeneration || isGenerating}
                      onChange={(visible) => void changeLocalReasoningVisibility(visible)}
                    />
                  ) : googleThinkingSupported ? (
                    <ThinkingControl
                      level={ownLevelIn(googleThinkingLevels) ?? googleThinkingLevel}
                      levels={googleThinkingLevels}
                      canDisable={thinkingMetadata?.thinkingCanDisable !== false}
                      disabled={thinkingSaving || isStartingGeneration || isGenerating}
                      disabledReason={thinkingDisabledReason}
                      onChange={(level) => void changeGoogleThinking(level)}
                    />
                  ) : codexThinkingSupported ? (
                    <ThinkingControl
                      providerLabel="Codex"
                      level={ownLevelIn(codexThinkingLevels) ?? codexThinkingLevel}
                      levels={codexThinkingLevels}
                      disabled={thinkingSaving || isStartingGeneration || isGenerating}
                      disabledReason={thinkingDisabledReason}
                      onChange={(level) => void changeCodexThinking(level)}
                    />
                  ) : anthropicThinkingSupported ? (
                    <ThinkingControl
                      providerLabel="Claude"
                      level={ownLevelIn(anthropicThinkingLevels) ?? anthropicThinkingLevel}
                      levels={anthropicThinkingLevels}
                      canDisable={thinkingMetadata?.thinkingCanDisable !== false}
                      disabled={thinkingSaving || isStartingGeneration || isGenerating}
                      disabledReason={thinkingDisabledReason}
                      onChange={(level) => void changeAnthropicThinking(level)}
                    />
                  ) : providerThinkingSupported ? (
                    <ThinkingControl
                      providerLabel={selectedProvider?.label ?? "Model"}
                      level={ownLevelIn(providerThinkingLevels) ?? providerThinkingLevel}
                      levels={providerThinkingLevels}
                      canDisable={selectedProvider?.kind === "openai" && customModelThinkingLevels(thinkingMetadata?.overrides)
                        ? providerThinkingLevels.includes("off") : thinkingMetadata?.thinkingCanDisable !== false}
                      disabled={thinkingSaving || isStartingGeneration || isGenerating}
                      disabledReason={thinkingDisabledReason}
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
                contextMeter={
                  draft || !showComposerContextUsage ? undefined : (
                    <ContextMeter
                      onViewDetails={() => environmentPanel.showTools("context")}
                      pressure={contextPressure}
                      compacting={
                        contextCompactPending ||
                        (displayedGenerationTimeline?.steps.some(
                          (step) =>
                            isToolStep(step) &&
                            step.toolName === "compact_context" &&
                            (step.status === "pending" || step.status === "running"),
                        ) ?? false)
                      }
                      recentlyCompacted={contextCompactedFlash}
                    />
                  )
                }
                onDraftChange={onDraftContextChange}
                contextHistoryPressure={
                  draft ? undefined : contextHistory.chatId === chatId ? contextHistory.pressure : null
                }
                modelPicker={
                  chat.data?.botId ? (
                    // A Bot's chat keeps the plain list: its model is the Bot's, not a slider stop.
                    <ModelPicker
                      providers={pickerProviders}
                      providerId={providerId}
                      model={model}
                      onChange={(nextProviderId, nextModel) => {
                        if (!getChatDraft(chatId)?.sending) select(nextProviderId, nextModel);
                      }}
                      disabled={modelChangeBlocked}
                      hiddenModelsByProvider={settings.data?.hiddenModelsByProvider}
                    />
                  ) : (
                    <AgentModelPopover
                      providers={pickerProviders}
                      providerId={providerId}
                      model={model}
                      thinkingLevel={selectionThinkingLevel}
                      slider={agentSlider}
                      settingsLoaded={settings.data !== undefined}
                      seedThinkingLevel={turnThinkingLevel(selectionThinkingLevel, {
                        google: { supported: googleThinkingSupported, level: googleThinkingLevel },
                        codex: { supported: codexThinkingSupported, level: codexThinkingLevel },
                        anthropic: { supported: anthropicThinkingSupported, level: anthropicThinkingLevel },
                        provider: { supported: providerThinkingSupported, level: providerThinkingLevel },
                      })}
                      onChange={(nextProviderId, nextModel) => {
                        if (!getChatDraft(chatId)?.sending) select(nextProviderId, nextModel);
                      }}
                      onSelectStop={(nextProviderId, nextModel, level) => {
                        if (!getChatDraft(chatId)?.sending) select(nextProviderId, nextModel, level ?? null);
                      }}
                      disabled={modelChangeBlocked}
                      settingsBlockedReason={settingsBlockedReason}
                      hiddenModelsByProvider={settings.data?.hiddenModelsByProvider}
                    />
                  )
                }
              />
            )}
          </ScrollAreaFooterStack>
        }
      >
        {chat.isLoading || providers.isLoading ? (
          <div role="status" className="flex min-h-full items-center justify-center">
            <Text variant="small" color="secondary">
              Loading conversation…
            </Text>
          </div>
        ) : chat.isError && messages.length === 0 ? (
          <div className="flex min-h-full items-center justify-center">
            <EmptyState
              role="alert"
              title="This chat couldn’t be loaded"
              description="Your messages are still saved. Try loading the chat again."
              action={
                <Button
                  variant="filled"
                  size="small"
                  onClick={() => void persistedChat.refetch()}
                >
                  Try again
                </Button>
              }
            />
          </div>
        ) : messages.length === 0 && displayedStreamingText === null && !worktreeSend ? (
          <div className="flex min-h-full items-center justify-center">
            {(providers.data ?? []).some(
              (p) => p.models.length > 0 && (p.hasKey || !p.needsKey),
            ) ? (
              <EmptyState
                title={newChatHeadline}
                description={
                  draftGitMode === "worktree" ? (
                    <span data-draft-worktree-hint>{draftWorktreeHint(draftWorktreeBase)}</span>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                title={newChatHeadline}
                description={`${CONNECT_PROVIDER_ACTION} in ${PROVIDER_SETTINGS_LABEL} to start.`}
                action={
                  <Button
                    variant="filled"
                    size="small"
                    onClick={() =>
                      void navigate({ to: "/settings", search: { section: "providers" } })
                    }
                  >
                    {CONNECT_PROVIDER_ACTION}
                  </Button>
                }
              />
            )}
          </div>
        ) : (
          <KeepVisualChatContext.Provider value={keepVisualChatId}>
            {/* A side panel floating over the conversation closes any link
                preview, helper card or tooltip left open there, so none draws
                over the panel. The strip it leaves visible still shows them. */}
            <DismissHoverSurfaces when={transcriptUnderFloatingPanel}>
              <MessageList
                key={chatId}
                chatId={chatId}
                {...(leadChatMessageLabel ? { leadChatLabel: leadChatMessageLabel } : {})}
                messages={messages}
                draftWorktreeSend={worktreeSend}
                draftWorktreeGrabbedElements={getActiveWorktreeGrabbedElements(chatId)}
                streamingText={displayedStreamingText}
                streamingReasoning={displayedStreamingReasoning}
                streamingArtifacts={displayedStreamingArtifacts}
                streamingArtifactPlacements={streamingArtifactPlacements}
                streamingWideVisuals={streamingWideVisuals}
                onVisualPrompt={handleVisualPrompt}
                visualFollowUpBusy={visualPromptBusy}
                streamingVisualDrafts={visualDrafts}
                streamingUiVisuals={displayedStreamingUiVisuals}
                streamingUiDrafts={uiDrafts}
                streamComplete={streamComplete || detachedProjectionStreamComplete(visibleDetachedProjection)}
                persistedHandoffMessageId={persistedHandoffMessageId}
                onStreamHandoffComplete={() => streamHandoffRef.current?.()}
                timeline={displayedGenerationTimeline}
                liveSubagents={shownLiveSubagents}
                subagentsEnabled={environmentPanel.subagentsEnabled}
                onOpenSubagent={environmentPanel.openSubagent}
                agentActivity={visibleAgentActivity}
                onRetryUsageLimit={() => void retryUsageLimitNow("chat", chatId)}
                readAloudMessageId={readAloudCandidateId}
                failureActions={failureActions}
                interruptedReply={interruptedReply}
                readAloud={readAloudProps}
                onFork={forkFromTranscript}
                forkDisabledReason={forkDisabledReason}
                onForkWithSummary={(messageId, position) =>
                  setForkSummaryRequest({ messageId, position })
                }
                forkSummary={
                  forkSummary
                    ? {
                        afterMessageId: forkSummary.afterMessageId,
                        node: (
                          <ForkSummaryCard
                            key={`${forkSummary.state}:${forkSummary.afterMessageId}`}
                            summary={forkSummary}
                            busy={forkSummaryBusy}
                            onCancel={() => void runForkSummaryAction("cancel")}
                            onRetry={() => void runForkSummaryAction("retry")}
                            onSkip={() => void runForkSummaryAction("skip")}
                          />
                        ),
                      }
                    : undefined
                }
                error={
                  error ??
                  (imageArtifactRecoveryUnavailable
                    ? "Visual artifact staging is unavailable. Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair."
                    : imageArtifactRecoveryPending
                      ? "A visual artifact could not be recovered. Delete this chat to discard it before continuing."
                      : null)
                }
              />
            </DismissHoverSurfaces>
          </KeepVisualChatContext.Provider>
        )}
      </ScrollArea>
      {cloningProject && isNewChat && effectiveWorkspace ? <PeerProjectCloneDialog workspaceId={effectiveWorkspace.id} onClose={() => setCloningProject(false)} onCreated={(hostId, workspace) => {
        const key = remoteNewChatDraftKey(hostId);
        if (!loadComposerDraft(key).text) {
          saveComposerDraftText(key, cloneDraftRef.current.text);
          seedComposerAttachments(key, cloneDraftRef.current.attachments);
        } else if (cloneDraftRef.current.text || cloneDraftRef.current.attachments.length) {
          toast.info(`The paired computer already has a draft. Your current prompt remains saved on this ${localComputerNoun(capabilities.platform)}.`);
        }
        qc.setQueryData<import("../shared/peer-host").PeerHostFeedSnapshot | null>(hostQueryKeys.feed(hostId), current => current ? { ...current, workspaces: [...current.workspaces.filter(row => row.id !== workspace.id), workspace] } : current);
        void navigate({ to: "/host/$hostId/new", params: { hostId }, search: { workspaceId: workspace.id } });
      }} /> : null}
      <ForkSummaryDialog
        open={forkSummaryRequest !== null}
        kind={forkSummaryRequest?.position === "before" ? "edit" : "fork"}
        onOpenChange={(open) => {
          if (!open) setForkSummaryRequest(null);
        }}
        onConfirm={forkWithSummary}
      />
      <AttachWorkspaceDialog
        open={attachDialogOpen}
        onOpenChange={setAttachDialogOpen}
        chatId={chatId}
        workspaces={workspaces}
        beforeAttach={() => {
          if (attachWorkspaceBlockedReason) throw new Error(attachWorkspaceBlockedReason);
        }}
        onWorkspaceCreated={(created) => {
          qc.setQueryData<Workspace[]>(queryKeys.workspaces, (current) => {
            const list = current ?? [];
            return list.some((item) => item.id === created.id) ? list : [...list, created];
          });
        }}
        onAttached={async (result, targetWorkspace) => {
          effectiveWorkspaceIdRef.current = targetWorkspace.id;
          await qc.cancelQueries({ queryKey: queryKeys.chat(chatId), exact: true });
          qc.setQueryData(queryKeys.chat(chatId), result.chat);
          selectWorkspace(targetWorkspace.id);
          await Promise.all([
            qc.invalidateQueries({ queryKey: queryKeys.chats }),
            qc.invalidateQueries({ queryKey: queryKeys.workspaces }),
            qc.invalidateQueries({ queryKey: queryKeys.git(targetWorkspace.id) }),
            qc.invalidateQueries({ queryKey: queryKeys.gitReview(targetWorkspace.id) }),
            qc.invalidateQueries({ queryKey: queryKeys.gitBranches(targetWorkspace.id) }),
            qc.invalidateQueries({ queryKey: queryKeys.gitPushCapability(targetWorkspace.id) }),
            qc.invalidateQueries({ queryKey: queryKeys.skillCatalog(targetWorkspace.id) }),
            qc.invalidateQueries({ queryKey: queryKeys.workspaceFileIndex(targetWorkspace.id) }),
            qc.invalidateQueries({ queryKey: queryKeys.workspaceFolderPresence(targetWorkspace.id) }),
          ]);
          const suffix =
            result.copiedPaths.length > 0
              ? ` (${result.copiedPaths.length} file${result.copiedPaths.length === 1 ? "" : "s"} copied)`
              : "";
          toast.success(`Attached to ${targetWorkspace.name}${suffix}`);
        }}
      />
    </>
  );
}
