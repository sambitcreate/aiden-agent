import type { AppControlSnapshot, AppControlOperation, AppControlReceipt } from "../shared/app-controls";
import type { SavedChatIntent } from "../shared/chat-intent";
import type { CompactionEngine } from "../shared/compaction";
import type { ModelPaceSummary } from "../shared/model-pace";
import type {
  WorkspaceClonePreview,
  WorkspaceCloneProgress,
  WorkspaceCloneResult,
  WorkspaceOpenPathResult,
  WorkspacePathInspection,
} from "../shared/workspace-intake";
import type {
  FirstMessageWorktreeProgress,
  FirstMessageWorktreeRequest,
  FirstMessageWorktreeResult,
} from "../shared/worktree-on-send";
import { ACP_HARNESS_STATUS_CHANNEL, parseAcpHarnessStatus, type AcpHarnessStatus } from "../shared/acp-harness.js";
import {
  BOT_COMPUTER_CHANNELS,
  BOT_COMPUTERS_CHANGED_CHANNEL,
  parseBotComputerPointer,
  parseBotComputerStatus,
  parseBotComputersStatus,
  parseBotComputerViewerGrant,
  type BotComputerPointer,
  type BotComputersSettings,
  type BotComputersStatus,
  type BotComputerStatus,
  type BotComputerViewerGrant,
} from "../shared/bot-computers.js";
import type { AgentsInstructionNotice } from "../shared/agents-instructions-notice";
import type { ChatForkPosition } from "../shared/chat-copy-contract";
import type {
  TtsJobSnapshot,
  TtsSafeError,
  TtsServiceEvent,
  TtsSettingsV1,
  TtsSourceRef,
} from "../shared/tts";

type TtsSettings = TtsSettingsV1;// Thin, typed wrappers over Aiden Agent's Electron IPC bridge plus the chat streaming helper.

import type {
  AppSettings,
  AssistantConfig,
  AssistantConfigSnapshot,
  ApprovalDecision,
  Attachment,
  Chat,
  ChatMeta,
  ChatMessage,
  ChatReadResponse,
  ChatTitleRenameResult,
  ChatStartParams,
  ComputerUseStatus,
  FormFillArtifactStatus,
  FormFillSettingsView,
  EngineStatus,
  ExternalEditor,
  GitBranches,
  GitCommitInput,
  GitCommitResult,
  GitComparison,
  GitComparisonDiffInput,
  GitDiffInput,
  GitFileDiff,
  GitHubPullRequestStatus,
  GitInfo,
  GitPushCapability,
  GitPushInput,
  GitPushResult,
  GitReview,
  GitWorktree,
  LocalVoiceModel,
  McpServer,
  McpLiveStatus,
  McpPresetState,
  McpServerDependents,
  McpStatus,
  McpToolSummary,
  McpPendingLaunchApproval,
  ModelInfo,
  ModelInsightsActionResult,
  ModelInsightsStatus,
  FoundationModelsConnectionStatus,
  Profile,
  Provider,
  ProviderCatalogRefreshResult,
  ProviderCatalogUpdateResult,
  ModelsDevCatalogStatus,
  OnboardingProviderValidationResult,
  ProviderModelMetadata,
  CodexProviderSnapshot,
  CodexProviderStatusChanged,
  ProviderAuthDone,
  ProviderAuthError,
  ProviderAuthEvent,
  ProviderAuthPrompt,
  Skill,
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskSettings,
  UsageDateRange,
  UsageSummary,
  Workspace,
  WorkspaceFileDocument,
  WorkspaceFileIndex,
  WorkspaceFileWriteResult,
  WorkspacePermission,
  BoundedNonSecretProviderConfig,
  WebSearchProviderId,
  WebSearchRendererSnapshot,
  WebSearchRouteEntry,
  WebSearchSelection,
  WebSearchExistingAuthConsentRequest,
  WebSearchExistingAuthRendererSnapshot,
} from "./types";
import type { OnboardingOutcome, OnboardingSnapshot } from "../shared/onboarding";
import type { SkillInvocationV1 } from "../shared/slash-commands";
import type { WebFetchRendererSnapshot } from "../shared/web-fetch-settings";
import type {
  WebKeyPoolId,
  WebSearchKeyPoolRendererState,
  WebSearchKeyPoolStrategy,
} from "../shared/web-search-key-pool";
import {
  type AskUserQuestionAnswerStatus,
  type AskUserQuestionPromptV1,
  type AskUserQuestionResponseV1,
} from "../shared/ask-user-question";
import type {
  DiagnosticSupportStatusView,
  RendererDiagnosticPolicy,
  RendererDiagnosticReport,
} from "../shared/diagnostics";
import type { BotSessionState } from "../../main/services/bot-runtime/bot-session-service";
import type {
  BotCreateInput,
  BotDefinition,
  BotRendererCanonicalPhoto,
  BotUpdateInput,
} from "../shared/bots";
import type {
  BotAccessUpdate,
  BotAccessView,
  BotCapabilityCatalog,
  BotNoticeAcknowledgement,
  BotNoticeStatus,
} from "../shared/bot-capabilities";

/** Bot access plus its current model selection, mirrored from the bot detail. */
export interface BotAccessState {
  access: BotAccessView;
  modelSelection?: { providerId: string; modelId: string };
  visionModelSelection?: { providerId: string; modelId: string };
  /** Full Access Web Search grant; always false for Custom access. */
  webSearchEnabled?: boolean;
}
import type { GenerationTimeline } from "../shared/generation-timeline";
import type {
  ChatRunInputAdmissionResult,
  ChatRunInputMode,
} from "../shared/chat-run-input";
import type { ToolApprovalDetails } from "../shared/assistant";
import type { ToolApprovalRuleView, ToolApprovalScope } from "../shared/tool-approval-scope";
import {
  parseSubagentHistoryDetailV1,
  type SubagentHistoryDetailV1,
  type SubagentRunSnapshot,
} from "../shared/subagent-runs";
import {
  parseSubagentManagementResultV2,
  type SubagentManagementRequestV2,
  type SubagentManagementResultV2,
} from "../shared/subagent-management-v2";
import type { KeybindingMutation, KeybindingSnapshot } from "../shared/keybindings";
import {
  parseAppUpdateSnapshot,
  type AppUpdateCheckResult,
  type AppUpdateRestartResult,
  type AppUpdateSnapshot,
} from "../shared/app-update";
import type {
  AssistantLiveRendererEvent,
  AssistantLiveSnapshot,
  AssistantLiveStartIntent,
} from "../shared/assistant-live";
import {
  fallbackDetachedLifecycleStream,
  parseChatReadResponse,
  rememberChatReadReconciliation,
  rememberDetachedLifecycleStream,
  rememberOwnGenerationStream,
} from "./chat-terminal-sync";
import type { AppCapabilities } from "./app-capabilities";
import { parseSkillCatalog, type SkillCatalogEntry } from "../shared/slash-commands";
import { rememberAppendReconciliationFailure } from "./append-reconciliation";
import type {
  AidenRemoteConnectionMode,
  AidenRemoteBeginPairingResult,
  AidenRemoteSettingsSnapshot,
} from "../shared/aiden-remote";
import type { ChatArtifactEventV1 } from "../shared/chat-artifacts";
import type {
  ImageGenerationActionResult,
  ImageGenerationAddCustomModelRequest,
  ImageGenerationProviderId,
  ImageGenerationState,
  ImageModelRef,
  ImageGenerationSetModelEnabledRequest,
} from "../shared/image-generation/types";
import { subscribeGenerationStream } from "./generation-stream";
import { parseTodoSnapshotView, type TodoSnapshotViewV1 } from "../shared/todo";
import type {
  ChatPullRequestCandidatesResult,
  ChatPullRequestCreateResult,
  ChatPullRequestDetectResult,
  ChatPullRequestLinkResult,
  ChatPullRequestListResult,
  ChatPullRequestPendingCreate,
  ChatPullRequestRef,
  ChatPullRequestView,
  ChatSidebarPullRequests,
} from "../shared/chat-pull-requests";
import { parseBtwEvent, type BtwEventV1, type BtwStartReceiptV1 } from "../shared/btw";
import { parseChatFollowThrough, type ChatFollowThroughV1 } from "../shared/follow-through";
import type { BackgroundJobOutput } from "../shared/background-jobs";
import {
  parseDeviceHostCheck,
  type DeviceHostCheck,
  type SshDeviceHostConfig,
} from "../shared/device-ssh-hosts";
import {
  parseChatContextPressure,
  parseChatContextPressureNotification,
  type ChatContextPressureV1,
} from "../shared/context-pressure";
import {
  parseDeviceServiceState,
  parseDeviceSettings,
  parseDeviceStreamGrant,
  parseDeviceToolchainState,
  type DeviceActionInput,
  type DeviceConsentKind,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceSettings,
  type DeviceStreamGrant,
  type DeviceToolchainState,
} from "../shared/devices";
import {
  parseDeviceRecordingInfo,
  parseDeviceRecordingList,
  parseDeviceSaveResult,
  type DeviceFeatureTarget,
  type DeviceRecordingInfo,
  type DeviceSaveResult,
} from "../shared/device-features";
import type {
  PeerDiscoveryState,
  PeerHostFeedMessage,
  PeerHostFeedSnapshot,
  PeerHostStatus,
  PeerHostView,
  PeerOperationOutcome,
  PeerPairingProgress,
  PeerPairingResult,
  PeerRepositoryIdentity,
  PeerRunFrameMessage,
  PeerRunSubscription,
  PeerRunTarget,
} from "../shared/peer-host";
import type { PeerOperation } from "../shared/peer-operation";
import type { PeerBotSessionMessage, PeerBotSessionSubscription } from "../shared/peer-bot-session";
import type { LocalRunCursor, LocalRunFrameMessage } from "../shared/local-run-frames";
import type {
  WorkspaceArtifactsChangedEvent,
  WorkspaceArtifactV1,
  WorkspaceArtifactSourceResultV1,
  WorkspaceArtifactView,
} from "../shared/workspace-artifacts";
import { invoke, onNotification } from "./ipc-bridge";

export { invoke, onNotification } from "./ipc-bridge";
export { dictationApi, settingsApi, voiceApi } from "./ipc-voice";

export interface AppInfo {
  name: string;
  version: string;
  environment: string;
  capabilities: AppCapabilities;
}


/**
 * Runs this Mac hosts but this window did not start (a paired phone's turn,
 * another window's). Frames arrive batched, only for this window's own
 * observations.
 */
export const localRunsApi = {
  observe: (chatId: string, cursor?: LocalRunCursor) =>
    invoke<PeerRunSubscription>("runs:observeLocal", chatId, cursor ?? null),
  unobserve: (subscriptionId: string) => invoke<boolean>("runs:unobserveLocal", subscriptionId),
  onFrame: (handler: (message: LocalRunFrameMessage) => void) =>
    onNotification<LocalRunFrameMessage>("runs:local-frame", handler),
  /** Host-authority Stop for a run this window observes; false when it already finished. */
  stop: (runId: string) => invoke<boolean>("runs:stopLocal", runId),
  /** The given runs that have finished for good on this Mac. */
  settled: (runIds: readonly string[]) => invoke<string[]>("runs:settledLocal", [...runIds]),
};

export const peerHostsApi = {
  removeRoute: (hostId: string, routeId: string) => invoke<void>("remote:peerRouteRemove", hostId, routeId),
  restoreRoutes: (hostId: string) => invoke<void>("remote:peerRoutesRestore", hostId),
  pendingIntents: (hostId: string, chatId: string) => invoke<SavedChatIntent[]>("remote:peerIntentsList", hostId, chatId),
  saveIntent: (intent: SavedChatIntent) => invoke<void>("remote:peerIntentsPut", intent),
  removeIntent: (hostId: string, chatId: string, key: string) => invoke<void>("remote:peerIntentsRemove", hostId, chatId, key),
  list: () => invoke<PeerHostView[]>("remote:peersList"),
  pair: (payload: string) => invoke<PeerHostView>("remote:peersPair", payload),
  setEnabled: (id: string, enabled: boolean) => invoke<void>("remote:peersSetEnabled", id, enabled),
  remove: (id: string) => invoke<void>("remote:peersRemove", id),
  /**
   * Retries a host now: one backing off, or one blocked by a version
   * mismatch. A connected host is left alone; an auth or identity block
   * clears only by re-pairing.
   */
  reconnect: (id: string) => invoke<void>("remote:peerReconnect", id),
  operation: (hostId: string, operation: PeerOperation) =>
    invoke<unknown>("remote:peerOperation", hostId, operation),
  onChanged: (handler: () => void) => onNotification("remote:peers-changed", handler),
  /** Like `operation`, but failures come back as typed outcomes instead of throwing. */
  call: (hostId: string, operation: PeerOperation, admission?: { savedIntent: boolean }) =>
    invoke<PeerOperationOutcome>("remote:peerCall", hostId, operation, admission),
  statuses: () => invoke<PeerHostStatus[]>("remote:peerHostStatuses"),
  /** Last-known rows; null when the host is disabled or unknown. */
  feed: (hostId: string) => invoke<PeerHostFeedSnapshot | null>("remote:peerHostFeed", hostId),
  runSubscribe: (hostId: string, target: PeerRunTarget, afterSequence = 0) =>
    invoke<PeerRunSubscription>("remote:peerRunSubscribe", hostId, target, afterSequence),
  runUnsubscribe: (subscriptionId: string) =>
    invoke<boolean>("remote:peerRunUnsubscribe", subscriptionId),
  /** Follow a host Bot's durable conversation; frames arrive on `onBotSession`. */
  botSessionSubscribe: (hostId: string, botId: string) =>
    invoke<PeerBotSessionSubscription>("remote:peerBotSessionSubscribe", hostId, botId),
  botSessionUnsubscribe: (subscriptionId: string) =>
    invoke<boolean>("remote:peerBotSessionUnsubscribe", subscriptionId),
  onBotSession: (handler: (message: PeerBotSessionMessage) => void) =>
    onNotification<PeerBotSessionMessage>("remote:peer-bot-session", handler),
  onHostFeed: (handler: (message: PeerHostFeedMessage) => void) =>
    onNotification<PeerHostFeedMessage>("remote:host-feed", handler),
  onRunFrame: (handler: (message: PeerRunFrameMessage) => void) =>
    onNotification<PeerRunFrameMessage>("remote:peer-run-frame", handler),
  onHostState: (handler: (status: PeerHostStatus) => void) =>
    onNotification<PeerHostStatus>("remote:peer-host-state", handler),
  rename: (id: string, name: string) => invoke<PeerHostView>("remote:peersRename", id, name),
  /** Search for other desktops while the Add device sheet is open. */
  discoveryStart: () => invoke<PeerDiscoveryState>("remote:peerDiscoveryStart"),
  discoveryRefresh: () => invoke<PeerDiscoveryState>("remote:peerDiscoveryRefresh"),
  discoveryStop: () => invoke<void>("remote:peerDiscoveryStop"),
  onDiscovery: (handler: (state: PeerDiscoveryState) => void) =>
    onNotification<PeerDiscoveryState>("remote:peer-discovery", handler),
  pairRequest: (attemptId: string, deviceId: string, replaceHostId?: string) =>
    invoke<PeerPairingResult>("remote:peerPairRequest", attemptId, deviceId, replaceHostId),
  pairSetupCode: (
    attemptId: string,
    input: { deviceId: string; code: string } | { address: string; code: string },
    replaceHostId?: string,
  ) => invoke<PeerPairingResult>("remote:peerPairSetupCode", attemptId, input, replaceHostId),
  pairLink: (attemptId: string, link: string, replaceHostId?: string) =>
    invoke<PeerPairingResult>("remote:peerPairLink", attemptId, link, replaceHostId),
  pairCancel: (attemptId: string) => invoke<boolean>("remote:peerPairCancel", attemptId),
  onPairingProgress: (handler: (progress: PeerPairingProgress) => void) =>
    onNotification<PeerPairingProgress>("remote:peer-pairing-progress", handler),
};

export const appApi = {
  getInfo: () => invoke<AppInfo>("app:getInfo"),
  resetOnboarding: () => invoke<boolean>("app:resetOnboarding"),
  getOnboardingState: (legacyComplete: boolean) =>
    invoke<OnboardingSnapshot>("app:getOnboardingState", legacyComplete),
  setOnboardingOutcome: (outcome: OnboardingOutcome, selectedProviderId?: string) =>
    invoke<OnboardingSnapshot>("app:setOnboardingOutcome", outcome, selectedProviderId),
  setOnboardingProgress: (step: "profile" | "provider" | "bots", selectedProviderId?: string) =>
    invoke<OnboardingSnapshot>("app:setOnboardingProgress", step, selectedProviderId),
  rendererReady: () => invoke<boolean>("app:renderer-ready"),
  setCloseGuard: (guard: { dirty: boolean; gitBusy: boolean; path?: string; saving: boolean }) =>
    invoke<boolean>("app:setCloseGuard", guard),
  setDockIcon: (preference: "aiden" | "monochrome") =>
    invoke<boolean>("app:setDockIcon", preference),
};

export const appUpdatesApi = {
  state: async (): Promise<AppUpdateSnapshot> =>
    parseAppUpdateSnapshot(await invoke<unknown>("app:getUpdateState")),
  check: () => invoke<AppUpdateCheckResult>("app:checkForUpdates"),
  restart: () => invoke<AppUpdateRestartResult>("app:restartToUpdate"),
  onStateChanged: (handler: (snapshot: AppUpdateSnapshot) => void) =>
    onNotification<unknown>("app:update-state", (payload) =>
      handler(parseAppUpdateSnapshot(payload)),
    ),
};

// ── Providers & settings ──────────────────────────────────────────────
export const providersApi = {
  list: () => invoke<Provider[]>("providers:list"),
  save: (provider: Omit<Provider, "hasKey">, keyOverride?: string) =>
    invoke<Provider>("providers:save", provider, keyOverride),
  normalizeArtwork: (input: { name: string; dataBase64: string }) =>
    invoke<NonNullable<Provider["artwork"]>>("providers:normalizeArtwork", input),
  remove: (id: string) => invoke<void>("providers:remove", id),
  setKey: (id: string, key: string) =>
    invoke<{ hasKey: boolean; provider: Provider | null }>("providers:setKey", id, key),
  refresh: (providerId?: string) =>
    invoke<ProviderCatalogRefreshResult>("providers:refresh", providerId),
  refreshIfStale: () => invoke<ProviderCatalogRefreshResult>("providers:refreshIfStale"),
  catalogStatus: () => invoke<ModelsDevCatalogStatus>("providers:catalogStatus"),
  updateCatalogs: () => invoke<ProviderCatalogUpdateResult>("providers:updateCatalogs"),
  validateOnboardingApiKey: (providerId: "openai" | "anthropic", key: string) =>
    invoke<OnboardingProviderValidationResult>(
      "providers:validateOnboardingApiKey",
      providerId,
      key,
    ),
  test: (provider: Omit<Provider, "hasKey">, keyOverride?: string) =>
    invoke<{
      ok: true;
      modelCount: number;
      models: string[];
      modelMetadata: Record<string, ProviderModelMetadata>;
      recommendedModel?: string;
    }>("providers:test", provider, keyOverride),
  listModels: (provider: Omit<Provider, "hasKey">, keyOverride?: string) =>
    invoke<string[]>("providers:listModels", provider, keyOverride),
  authStatus: (providerId: "openai-codex") =>
    invoke<CodexProviderSnapshot>("providers:auth:status", providerId),
  authStart: (request: { flowId: string; providerId: string; authType?: "api_key" | "oauth" }) =>
    invoke<{ started: true }>("providers:auth:start", request),
  authRespond: (request: { flowId: string; providerId: string; promptId: string; value: string }) =>
    invoke<{ accepted: true }>("providers:auth:respond", request),
  authCancel: (request: { flowId: string; providerId: string }) =>
    invoke<{ cancelled: true } | { cancelled: false; reason: "finishing" }>(
      "providers:auth:cancel",
      request,
    ),
  logout: (providerId: string) => invoke<unknown>("providers:logout", providerId),
  /** Settings → Providers: let custom connectors use this provider's saved API key. */
  setConnectorKeySharing: (providerId: string, allowed: boolean) =>
    invoke<{ connectorKeySharing: boolean }>("providers:setConnectorKeySharing", providerId, allowed),
  onAuthPrompt: (handler: (prompt: ProviderAuthPrompt) => void) =>
    onNotification("providers:auth:prompt", handler),
  onAuthEvent: (handler: (event: ProviderAuthEvent) => void) =>
    onNotification("providers:auth:event", handler),
  onAuthDone: (handler: (event: ProviderAuthDone) => void) =>
    onNotification("providers:auth:done", handler),
  onAuthError: (handler: (event: ProviderAuthError) => void) =>
    onNotification("providers:auth:error", handler),
  onAuthStatusChanged: (handler: (event: CodexProviderStatusChanged) => void) =>
    onNotification("providers:auth:status-changed", handler),
};

export const appControlsApi = {
  acknowledgeNavigation: (requestId: string, status: "opened" | "blocked") => invoke<boolean>("settings:controls:navigation-ack", requestId, status),
  get: (chatId: string, panelId: string) => invoke<AppControlSnapshot>("settings:controls:get", chatId, panelId),
  apply: (chatId: string, panelId: string, operation: AppControlOperation) => invoke<AppControlReceipt>("settings:controls:apply", chatId, panelId, operation),
  onChanged: (handler: () => void) => onNotification("settings:controls-changed", handler),
};

async function harnessStatus(channel: string, providerId: string): Promise<AcpHarnessStatus> {
  const status = parseAcpHarnessStatus(await invoke<unknown>(channel, providerId));
  if (!status) throw new Error("Aiden returned an invalid runtime status.");
  return status;
}

/** Managed runtimes for agent-backed providers such as Google Antigravity. */
export const harnessApi = {
  status: (providerId: string) => harnessStatus("providers:harness:status", providerId),
  install: (providerId: string) => harnessStatus("providers:harness:install", providerId),
  cancelInstall: (providerId: string) => invoke<void>("providers:harness:cancel", providerId),
  remove: (providerId: string) => harnessStatus("providers:harness:remove", providerId),
  onChanged: (handler: (status: AcpHarnessStatus) => void) =>
    onNotification<unknown>(ACP_HARNESS_STATUS_CHANNEL, (payload) => {
      const status = parseAcpHarnessStatus(payload);
      if (status) handler(status);
    }),
};


export const assistantApi = {
  config: () => invoke<AssistantConfigSnapshot>("assistant:get-config"),
  setConfig: (patch: Partial<AssistantConfig>) =>
    invoke<AssistantConfigSnapshot>("assistant:set-config", patch),
};

export const assistantLiveApi = {
  status: () => invoke<AssistantLiveSnapshot>("assistant-live:status"),
  authorizeComputerUse: () => invoke<string | null>("assistant-live:authorize-computer-use", {}),
  start: (intent: AssistantLiveStartIntent) =>
    invoke<AssistantLiveSnapshot>("assistant-live:start", intent),
  stop: () => invoke<AssistantLiveSnapshot>("assistant-live:stop", {}),
  sendAudio: (sessionId: string, pcm: Uint8Array) =>
    invoke<boolean>("assistant-live:audio", { sessionId, pcm }),
  bindDisplay: () => invoke<string | null>("assistant-live:display-bind", {}),
  releaseDisplay: (bindingId: string) =>
    invoke<boolean>("assistant-live:display-release", { bindingId }),
  sendFrame: (sessionId: string, frame: Uint8Array) =>
    invoke<boolean>("assistant-live:frame", { sessionId, frame }),
  onEvent: (handler: (event: AssistantLiveRendererEvent) => void) =>
    onNotification<AssistantLiveRendererEvent>("assistant-live:event", handler),
};

export const modelInsightsApi = {
  status: () => invoke<ModelInsightsStatus>("modelInsights:status"),
  connect: (apiKey: string) => invoke<ModelInsightsActionResult>("modelInsights:connect", apiKey),
  refresh: () => invoke<ModelInsightsActionResult>("modelInsights:refresh"),
  disconnect: () => invoke<ModelInsightsActionResult>("modelInsights:disconnect"),
};

/** Settings → Image Generation. Keys go in only; state is redacted. */
export const imageGenerationApi = {
  state: () => invoke<ImageGenerationState>("imageGeneration:state"),
  setKey: (provider: ImageGenerationProviderId, key: string) =>
    invoke<ImageGenerationActionResult>("imageGeneration:setKey", { provider, key }),
  removeKey: (provider: ImageGenerationProviderId) =>
    invoke<ImageGenerationActionResult>("imageGeneration:removeKey", { provider }),
  setModelEnabled: (provider: ImageGenerationProviderId, id: string, enabled: boolean) =>
    invoke<ImageGenerationActionResult>("imageGeneration:setModelEnabled", { provider, id, enabled }),
  /** One write for many enable choices (Settings' bulk actions). */
  setModelsEnabled: (changes: ImageGenerationSetModelEnabledRequest[]) =>
    invoke<ImageGenerationActionResult>("imageGeneration:setModelsEnabled", { changes }),
  setDefaultModel: (model: ImageModelRef | null) =>
    invoke<ImageGenerationActionResult>("imageGeneration:setDefaultModel", model),
  addCustomModel: (request: ImageGenerationAddCustomModelRequest) =>
    invoke<ImageGenerationActionResult>("imageGeneration:addCustomModel", request),
  removeCustomModel: (model: ImageModelRef) =>
    invoke<ImageGenerationActionResult>("imageGeneration:removeCustomModel", model),
  /** User-initiated only: the one network path on this page. */
  fetchModels: (provider: ImageGenerationProviderId) =>
    invoke<ImageGenerationActionResult>("imageGeneration:fetchModels", { provider }),
};

/** Device-local measured pace; reads never touch the network. */
export const modelPaceApi = {
  summaries: () => invoke<Record<string, ModelPaceSummary>>("modelPace:summaries"),
  clear: () => invoke<void>("modelPace:clear"),
};

export const computerUseApi = {
  status: (force = false) => invoke<ComputerUseStatus>("computerUse:status", force),
  setEnabled: (enabled: boolean) => invoke<ComputerUseStatus>("computerUse:setEnabled", enabled),
  requestPermissions: () => invoke<ComputerUseStatus>("computerUse:requestPermissions"),
  /** Clear every chat's Computer Use grant and turn off Always allow. */
  resetChatGrants: () => invoke<{ cleared: number }>("computerUse:resetChatGrants"),
};

export const formFillApi = {
  status: () => invoke<FormFillSettingsView>("formFill:status"),
  setEnabled: (enabled: boolean) => invoke<FormFillSettingsView>("formFill:setEnabled", enabled),
  download: () => invoke<FormFillArtifactStatus>("formFill:download"),
  cancel: () => invoke<FormFillArtifactStatus>("formFill:cancel"),
  remove: () => invoke<FormFillArtifactStatus>("formFill:remove"),
  onProgress: (handler: (status: FormFillArtifactStatus) => void) =>
    onNotification<FormFillArtifactStatus>("formFill:progress", handler),
};

export const titleProvidersApi = {
  status: () => invoke<FoundationModelsConnectionStatus | null>("titleProviders:status"),
  refresh: () => invoke<FoundationModelsConnectionStatus | null>("titleProviders:refresh"),
};

export const usageApi = {
  summary: (range: UsageDateRange = "1y") => invoke<UsageSummary>("usage:summary", range),
};

export const scheduleApi = {
  list: () => invoke<ScheduledTask[]>("schedule:list"),
  save: (task: ScheduledTaskInput, expectedUpdatedAt?: number) =>
    invoke<ScheduledTask>("schedule:save", task, expectedUpdatedAt),
  remove: (id: string, expectedUpdatedAt: number) =>
    invoke<void>("schedule:remove", id, expectedUpdatedAt),
  pause: (id: string, expectedUpdatedAt: number) =>
    invoke<ScheduledTask>("schedule:pause", id, expectedUpdatedAt),
  resume: (id: string, expectedUpdatedAt: number) =>
    invoke<ScheduledTask>("schedule:resume", id, expectedUpdatedAt),
  runNow: (id: string, expectedUpdatedAt: number) =>
    invoke<ScheduledRun>("schedule:runNow", id, expectedUpdatedAt),
  runs: (id: string) => invoke<ScheduledRun[]>("schedule:runs", id),
  preview: (cron: string, timezone: string, count = 3) =>
    invoke<number[]>("schedule:preview", cron, timezone, count),
  scripts: (workspaceId?: string) => invoke<string[]>("schedule:scripts", workspaceId),
  settings: (patch?: Partial<ScheduledTaskSettings>) =>
    invoke<ScheduledTaskSettings>("schedule:settings", patch),
};

export const profileApi = {
  get: () => invoke<Profile>("profile:get"),
  setName: (name: string) => invoke<Profile>("profile:setName", name),
  shareImage: (dataUrl: string) => invoke<boolean>("profile:shareImage", dataUrl),
};

// ── Skills ────────────────────────────────────────────────────────────
export const skillsApi = {
  list: () => invoke<Skill[]>("skills:list"),
  save: (skill: Skill) => invoke<Skill>("skills:save", skill),
  remove: (id: string) => invoke<void>("skills:remove", id),
  catalog: async (workspaceId: string): Promise<SkillCatalogEntry[]> =>
    parseSkillCatalog(await invoke<unknown>("skills:catalog", workspaceId)),
  /** @deprecated Compatibility alias for the renderer-safe catalog. */
  discovered: async (workspaceId: string): Promise<SkillCatalogEntry[]> =>
    parseSkillCatalog(await invoke<unknown>("skills:discovered", workspaceId)),
};

// ── MCP servers ───────────────────────────────────────────────────────
export const mcpApi = {
  list: () => invoke<McpServer[]>("mcp:list"),
  /** Built-in provider catalog plus per-preset connection state. */
  presets: () => invoke<McpPresetState[]>("mcp:presets"),
  /** Save (or clear, with an empty string) a preset's API key. Keys never come back. */
  setPresetKey: (serverId: string, key: string) =>
    invoke<{ hasKey: boolean }>("mcp:setPresetKey", serverId, key),
  /** Resolves to the stored record (env/header values replaced by markers). `approveLaunch`: the editor, which shows the command, approves a local server to run. `fromEditor`: an editor save (sign-in and provider consent included), so kept values may follow an address it changed. */
  save: (server: McpServer, options?: { approveLaunch?: boolean; fromEditor?: boolean }) => invoke<McpServer>("mcp:save", server, options),
  /** Local servers not approved to run on this device (added or changed outside Aiden). */
  launchApprovals: () => invoke<McpPendingLaunchApproval[]>("mcp:launchApprovals"),
  approveLaunch: (id: string, fingerprint: string) => invoke<{ approved: true }>("mcp:approveLaunch", id, fingerprint),
  remove: (id: string) => invoke<void>("mcp:remove", id),
  status: (server: McpServer) => invoke<McpStatus>("mcp:status", server),
  /** Browser OAuth sign-in for a remote server. Resolves once tokens are stored. */
  /** `connectionError`: signed in and stored, but the follow-up connection failed for another reason. */
  authorize: (server: McpServer) => invoke<{ authorized: boolean; connectionError?: string }>("mcp:authorize", server),
  /** Stop a sign-in waiting in the browser; frees the loopback port at once. */
  cancelAuthorize: (id: string) => invoke<{ cancelled: boolean }>("mcp:cancelAuthorize", id),
  /** Forget this server's OAuth session and disconnect it. */
  signOut: (id: string) => invoke<{ authorized: false }>("mcp:signOut", id),
  /** Connect to an unsaved draft without persisting it. `apiKey` is a pasted, unsaved preset key. */
  testDraft: (server: McpServer, apiKey?: string) => invoke<McpStatus>("mcp:testDraft", server, apiKey),
  /** Schedules and Bots that rely on this server. */
  dependents: (id: string) => invoke<McpServerDependents>("mcp:dependents", id),
  /** Current per-server live status; changes arrive on `mcp:statusChanged`. */
  liveStatus: () => invoke<McpLiveStatus[]>("mcp:liveStatus"),
  /** The server's tools from its last discovery (never connects); null when none yet. */
  toolList: (id: string) => invoke<McpToolSummary[] | null>("mcp:toolList", id),
  onStatusChanged: (handler: (status: McpLiveStatus) => void) =>
    onNotification<McpLiveStatus>("mcp:statusChanged", handler),
  oauthStatus: (id: string) =>
    invoke<{ authorized: boolean; needsSignIn?: boolean; hasSession?: boolean; providerAuthorized?: boolean }>("mcp:oauthStatus", id),
  providerAuth: (server: McpServer, allowed: boolean) => invoke<{ authorized: boolean }>("mcp:providerAuth", server, allowed),
  /** Drop cached connections so the next message reconnects with current config. */
  reconnect: () => invoke<void>("mcp:reconnect"),
};

// ── Local diagnostics (main-owned policy and support actions) ─────────
export const diagnosticsApi = {
  policy: () => invoke<RendererDiagnosticPolicy>("diagnostics:policy"),
  reportRendererEvent: (report: RendererDiagnosticReport) =>
    invoke<{ accepted: boolean; referenceId: string }>("diagnostics:renderer-event", report),
  status: () => invoke<DiagnosticSupportStatusView>("diagnostics:status"),
  reveal: () => invoke<boolean>("diagnostics:reveal"),
  export: (includeCrashDumps: boolean) =>
    invoke<{ exported: boolean; manifest?: unknown }>("diagnostics:export", includeCrashDumps),
  delete: () => invoke<boolean>("diagnostics:delete"),
  enableMode: () =>
    invoke<{ enabled: boolean; expiresAt: null; disablesOnRestart: true }>(
      "diagnostics:mode-enable",
    ),
};

// ── Exa web search ────────────────────────────────────────────────────
export const exaApi = {
  get: () => invoke<{ enabled: boolean; hasKey: boolean }>("exa:get"),
  setKey: (key: string) => invoke<{ hasKey: boolean }>("exa:setKey", key),
  setEnabled: (enabled: boolean) => invoke<AppSettings>("exa:setEnabled", enabled),
};

// ── Web Search provider registry ─────────────────────────────────────
export const webSearchApi = {
  get: () => invoke<WebSearchRendererSnapshot>("webSearch:get"),
  getExistingAuth: () =>
    invoke<WebSearchExistingAuthRendererSnapshot>("webSearch:existingAuth:get"),
  consentExistingAuth: (request: WebSearchExistingAuthConsentRequest) =>
    invoke<WebSearchRendererSnapshot>("webSearch:existingAuth:consent", request),
  revokeExistingAuth: () => invoke<WebSearchRendererSnapshot>("webSearch:existingAuth:revoke"),
  setEnabled: (enabled: boolean) =>
    invoke<WebSearchRendererSnapshot>("webSearch:setEnabled", enabled),
  setSelection: (selection: WebSearchSelection) =>
    invoke<WebSearchRendererSnapshot>("webSearch:setSelection", selection),
  setAutomaticRoute: (route: WebSearchRouteEntry[]) =>
    invoke<WebSearchRendererSnapshot>("webSearch:setAutomaticRoute", route),
  setProviderConfig: (
    providerId: WebSearchProviderId,
    providerConfig: BoundedNonSecretProviderConfig | null,
  ) => invoke<WebSearchRendererSnapshot>("webSearch:setProviderConfig", providerId, providerConfig),
  setCredential: (providerId: WebSearchProviderId, key: string) =>
    invoke<WebSearchRendererSnapshot>("webSearch:setCredential", providerId, key),
  removeCredential: (providerId: WebSearchProviderId) =>
    invoke<WebSearchRendererSnapshot>("webSearch:removeCredential", providerId),
  keyPool: {
    get: (providerId: WebKeyPoolId) =>
      invoke<WebSearchKeyPoolRendererState>("webSearch:keyPool:get", providerId),
    add: (providerId: WebKeyPoolId, key: string, label?: string) =>
      invoke<WebSearchKeyPoolRendererState>("webSearch:keyPool:add", providerId, key, label),
    remove: (providerId: WebKeyPoolId, entryId: string) =>
      invoke<WebSearchKeyPoolRendererState>("webSearch:keyPool:remove", providerId, entryId),
    reorder: (providerId: WebKeyPoolId, entryIds: string[]) =>
      invoke<WebSearchKeyPoolRendererState>("webSearch:keyPool:reorder", providerId, entryIds),
    setStrategy: (providerId: WebKeyPoolId, strategy: WebSearchKeyPoolStrategy) =>
      invoke<WebSearchKeyPoolRendererState>("webSearch:keyPool:setStrategy", providerId, strategy),
    resetCooldown: (providerId: WebKeyPoolId, entryId: string) =>
      invoke<WebSearchKeyPoolRendererState>("webSearch:keyPool:resetCooldown", providerId, entryId),
  },
};

// ── Web pages (web_fetch) and extract mode ───────────────────────────
export const webFetchApi = {
  get: () => invoke<WebFetchRendererSnapshot>("webSearch:pages:get"),
  setEnabled: (enabled: boolean) =>
    invoke<WebFetchRendererSnapshot>("webSearch:pages:setEnabled", enabled),
  setExtractEnabled: (enabled: boolean) =>
    invoke<WebFetchRendererSnapshot>("webSearch:pages:setExtractEnabled", enabled),
  setExtractAccountId: (accountId: string | null) =>
    invoke<WebFetchRendererSnapshot>("webSearch:pages:setExtractAccountId", accountId),
};

// ── Telegram remote control ──────────────────────────────────────────
export interface TelegramStatus {
  enabled: boolean;
  hasToken: boolean;
  allowedUserId?: number;
  providerId?: string;
  model?: string;
  workspaceId?: string;
  polling: boolean;
  queuedCount: number;
  thinkingLevel?: import("../shared/generation-thinking").GenerationThinkingLevel;
  draftPreviews: boolean;
  activity: "quiet" | "thinking" | "tools" | "verbose";
  lastError?: string;
  rendering: "rich" | "html";
  voiceMode: "hidden" | "mirror" | "always";
  threadedMode: boolean;
  activeProfile: string;
  profiles: Array<{
    name: string;
    hasToken: boolean;
    settings: { enabled?: boolean; allowedUserId?: number };
    status: { status: string; queuedCount: number; lastError?: string };
  }>;
  recentDiagnostics: Array<{
    at: number;
    level: "info" | "warning" | "error" | "recovery";
    message: string;
  }>;
}
export const telegramApi = {
  get: () => invoke<TelegramStatus>("telegram:get"),
  setKey: (key: string) => invoke<{ hasKey: boolean }>("telegram:setKey", key),
  setEnabled: (enabled: boolean) => invoke<boolean>("telegram:setEnabled", enabled),
  connect: () => invoke<{ connected: boolean }>("telegram:connect"),
  disconnect: () => invoke<{ connected: boolean }>("telegram:disconnect"),
  resetPairing: () => invoke<{ reset: boolean }>("telegram:resetPairing"),
  setProvider: (providerId: string, model: string) =>
    invoke<{ providerId: string; model: string }>("telegram:setProvider", providerId, model),
  setWorkspace: (workspaceId?: string) =>
    invoke<{ workspaceId?: string }>("telegram:setWorkspace", workspaceId),
  setExperience: (input: {
    thinkingLevel?: import("../shared/generation-thinking").GenerationThinkingLevel;
    draftPreviews: boolean;
    activity: "quiet" | "thinking" | "tools" | "verbose";
    rendering: "rich" | "html";
    voiceMode: "hidden" | "mirror" | "always";
    threadedMode: boolean;
  }) => invoke("telegram:setExperience", input),
  selectProfile: (profile: string) =>
    invoke<{ profile: string }>("telegram:selectProfile", profile),
  createProfile: (profile: string) =>
    invoke<{ profile: string }>("telegram:createProfile", profile),
  deleteProfile: (profile: string) =>
    invoke<{ deleted: boolean }>("telegram:deleteProfile", profile),
  onModelSelectionChanged: (handler: (selection: { providerId: string; model: string }) => void) =>
    onNotification("telegram:model-selection-changed", handler),
};

export const aidenRemoteApi = {
  setupPairing: (
    transport: "lan" | "tailscale",
    expected: {
      instanceId: string;
      enabled: boolean;
      connectionMode: AidenRemoteConnectionMode;
    },
  ) => invoke<AidenRemoteBeginPairingResult>("remote:setupPairing", transport, expected),
  get: () => invoke<AidenRemoteSettingsSnapshot>("remote:get"),
  setEnabled: (enabled: boolean) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:setEnabled", enabled),
  setConnectionMode: (mode: AidenRemoteConnectionMode) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:setConnectionMode", mode),
  setDisplayName: (displayName: string) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:setDisplayName", displayName),
  moveToAvailablePort: () => invoke<AidenRemoteSettingsSnapshot>("remote:moveToAvailablePort"),
  connectTailscale: () => invoke<AidenRemoteSettingsSnapshot>("remote:tailscaleConnect"),
  disconnectTailscale: () => invoke<AidenRemoteSettingsSnapshot>("remote:tailscaleDisconnect"),
  reconcileTailscale: () => invoke<AidenRemoteSettingsSnapshot>("remote:tailscaleReconcile"),
  reviewTailscaleTakeover: () =>
    invoke<import("../shared/aiden-remote").AidenRemoteTailscaleTakeoverReviewView>(
      "remote:tailscaleReviewTakeover",
    ),
  takeOverTailscale: (token: string) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:tailscaleTakeOver", token),
  beginPairing: (transport: "lan" | "tailscale") =>
    invoke<AidenRemoteBeginPairingResult>("remote:beginPairing", transport),
  closePairing: (pairingSessionId: string) =>
    invoke<{ closed: boolean }>("remote:closePairing", pairingSessionId),
  revokeDevice: (deviceId: string) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:revokeDevice", deviceId),
  addApprovedRoot: () => invoke<AidenRemoteSettingsSnapshot>("remote:addApprovedRoot"),
  removeApprovedRoot: (rootId: string) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:removeApprovedRoot", rootId),
  pendingApproval: (chatId: string) =>
    invoke<RemoteApprovalPrompt | null>("remote:getPendingApproval", chatId),
  pendingQuestion: (chatId: string) =>
    invoke<(AskUserQuestionPromptV1 & { source: "remote" }) | null>("remote:getPendingQuestion", chatId),
  respondQuestion: (chatId: string, promptId: string, response: AskUserQuestionResponseV1) =>
    invoke<{ status: "answered" | "elsewhere" }>("remote:respondQuestionFromHost", chatId, promptId, response),
  respondApproval: (
    chatId: string,
    approvalId: string,
    decision: "allow" | "deny",
    scope?: ToolApprovalScope,
  ) =>
    scope && scope !== "once"
      ? invoke<{ resolved: true }>("remote:respondApprovalFromHost", chatId, approvalId, decision, scope)
      : invoke<{ resolved: true }>("remote:respondApprovalFromHost", chatId, approvalId, decision),
  onChanged: (handler: () => void) => onNotification("remote:changed", handler),
  onApprovalChanged: (handler: (payload: { chatId: string }) => void) =>
    onNotification("remote:approval-changed", handler),
  setAcceptPairingRequests: (accept: boolean) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:setAcceptPairingRequests", accept),
  listPairingRequests: () =>
    invoke<import("../shared/aiden-remote").AidenRemotePairingRequestPrompt[]>(
      "remote:listPairingRequests",
    ),
  respondPairingRequest: (requestId: string, decision: "allow" | "deny") =>
    invoke<import("../shared/aiden-remote").AidenRemotePairingRequestDecisionView>(
      "remote:respondPairingRequest",
      requestId,
      decision,
    ),
  onPairingRequestsChanged: (handler: () => void) =>
    onNotification("remote:pairing-requests-changed", handler),
};

// ── Voice + shortcut ──────────────────────────────────────────────────

/** On-device (sherpa-onnx / Parakeet) engine + model management. */
export const localVoiceApi = {
  status: () => invoke<EngineStatus>("localVoice:status"),
  /** Preload the on-device model so the first transcription starts faster. */
  warm: (modelId: string) => invoke<void>("localVoice:warm", modelId),
  listModels: () => invoke<LocalVoiceModel[]>("localModels:list"),
  downloadModel: (id: string) => invoke<void>("localModels:download", id),
  cancelDownload: (id: string) => invoke<boolean>("localModels:cancel", id),
  deleteModel: (id: string) => invoke<void>("localModels:delete", id),
};

export interface ModelDownloadProgress {
  id: string;
  downloaded: number;
  total: number;
  percentage: number;
  phase: "download" | "verify" | "extract";
}

export const shortcutApi = {
  get: () => invoke<KeybindingSnapshot>("shortcut:get"),
  setRecording: (recording: boolean) =>
    invoke<KeybindingSnapshot>("shortcut:set-recording", recording),
  set: (mutation: KeybindingMutation) => invoke<KeybindingSnapshot>("shortcut:set", mutation),
  onChanged: (handler: (snapshot: KeybindingSnapshot) => void) =>
    onNotification("shortcut:changed", handler),
};


/** Native folder picker (uses the default-exposed dialog bridge). Returns null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  const res = await window.aidenAPI.dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  if (res.canceled || !res.filePaths?.length) return null;
  return res.filePaths[0];
}

// ── Attachments & model catalog ───────────────────────────────────────
export const attachmentsApi = {
  pickAndRead: (remainingSlots: number, includeImages: boolean, remainingInlineBytes: number) =>
    invoke<{ attachments: Attachment[]; skipped: number }>(
      "attachments:pickAndRead",
      remainingSlots,
      includeImages,
      remainingInlineBytes,
    ),
  readDroppedFiles: (
    files: readonly File[],
    remainingSlots: number,
    includeImages: boolean,
    remainingInlineBytes: number,
  ) =>
    window.aidenAPI.attachments.readDroppedFiles(
      files,
      remainingSlots,
      includeImages,
      remainingInlineBytes,
    ),
  readClipboardImages: (
    images: Array<{ mimeType: string; bytes: Uint8Array }>,
    remainingSlots: number,
    remainingInlineBytes: number,
  ) =>
    window.aidenAPI.attachments.readClipboardImages(images, remainingSlots, remainingInlineBytes),
};

export const modelsApi = {
  info: (providerId: string, modelIds: string[]) =>
    invoke<Record<string, ModelInfo>>("models:info", providerId, modelIds),
};

// ── Workspaces ────────────────────────────────────────────────────────
export const workspacesApi = {
  list: () => invoke<Workspace[]>("workspaces:list"),
  get: (id: string) => invoke<Workspace | null>("workspaces:get", id),
  create: (input: { name?: string; permission?: WorkspacePermission }) =>
    invoke<Workspace>("workspaces:create", input),
  createFromFolder: () => invoke<Workspace | null>("workspaces:createFromFolder"),
  createScratch: () => invoke<Workspace>("workspaces:createScratch"),
  /**
   * Read-only check of a typed path (`/…`, `~/…`, or `./…` relative to the
   * given workspace's folder). Never creates anything.
   */
  inspectPath: (input: string, relativeToWorkspaceId?: string) =>
    invoke<WorkspacePathInspection>("workspaces:inspectPath", input, relativeToWorkspaceId),
  /**
   * Register a typed path as a workspace, or return the one already there.
   * With `create`, makes the final folder first when only its parent exists.
   */
  openPath: (input: string, options: { create: boolean; relativeToWorkspaceId?: string }) =>
    invoke<WorkspaceOpenPathResult<Workspace>>("workspaces:openPath", input, options),
  /** Validate a clone URL and suggest `<clone base>/<repo>` as the destination. */
  clonePreview: (url: string) => invoke<WorkspaceClonePreview>("workspaces:clonePreview", url),
  /**
   * Clone a repository (a deliberate network action) and register it.
   * `cloneId` (8–64 of `[A-Za-z0-9_-]`) routes progress and cancellation.
   */
  clone: (input: { cloneId: string; url: string; destination?: string }) =>
    invoke<WorkspaceCloneResult<Workspace>>("workspaces:clone", input),
  cancelClone: (cloneId: string) => invoke<boolean>("workspaces:cloneCancel", cloneId),
  onCloneProgress: (handler: (progress: WorkspaceCloneProgress) => void) =>
    onNotification<WorkspaceCloneProgress>("workspaces:clone-progress", handler),
  update: (
    id: string,
    patch: { name?: string; permission?: WorkspacePermission; memoryEnabled?: boolean },
  ) => invoke<Workspace>("workspaces:update", id, patch),
  remove: (id: string) => invoke<void>("workspaces:remove", id),
  gitInfo: (workspaceId: string) => invoke<GitInfo>("workspaces:gitInfo", workspaceId),
  /** Credential-free repository identity, or null outside a repository with a network remote. */
  repositoryIdentity: (workspaceId: string) =>
    invoke<PeerRepositoryIdentity | null>("workspaces:repositoryIdentity", workspaceId),
  openFolder: (workspaceId: string) => invoke<void>("workspaces:openFolder", workspaceId),
  externalEditors: (forceRefresh = false) =>
    invoke<ExternalEditor[]>("workspaces:externalEditors", forceRefresh),
  openInEditor: (workspaceId: string, editorId: string) =>
    invoke<void>("workspaces:openInEditor", workspaceId, editorId),
  files: (workspaceId: string) => invoke<WorkspaceFileIndex>("workspaces:files", workspaceId),
  readFile: (workspaceId: string, path: string) =>
    invoke<WorkspaceFileDocument>("workspaces:readFile", workspaceId, path),
  writeFile: (workspaceId: string, path: string, content: string, expectedVersion: string) =>
    invoke<WorkspaceFileWriteResult>(
      "workspaces:writeFile",
      workspaceId,
      path,
      content,
      expectedVersion,
    ),
};

// ── Interactive terminal ─────────────────────────────────────────────
export interface TerminalSession {
  id: string;
  workspaceId: string;
  cwd: string;
  /** The shell that actually launched this session (e.g. `/bin/zsh`). */
  resolvedShell: string;
  /** True when the preferred shell was skipped and a fallback launched it. */
  preferredShellSkipped: boolean;
}

export interface TerminalSnapshot {
  buffer: string;
  sequence: number;
}

export const browserApi = {
  getState: (workspaceId: string) =>
    invoke<import("../shared/browser").BrowserState>("browser:get-state", workspaceId),
  command: (workspaceId: string, command: import("../shared/browser").BrowserCommand) =>
    invoke<import("../shared/browser").BrowserCommandResult>(
      "browser:command",
      workspaceId,
      command,
    ),
  onEvent: (callback: (event: import("../shared/browser").BrowserEvent) => void) =>
    onNotification<import("../shared/browser").BrowserEvent>("browser:event", callback),
  linkPreference: () =>
    invoke<import("../shared/browser").BrowserLinkOpening>("browser:link-preference"),
  setLinkPreference: (value: import("../shared/browser").BrowserLinkOpening) =>
    invoke<import("../shared/browser").BrowserLinkOpening>("browser:set-link-preference", value),
  openExternal: (url: string) => invoke<void>("browser:open-external", url),
  openFileExternal: (workspaceId: string, path: string) => invoke<void>("browser:open-file-external", workspaceId, path),
};

async function botComputersStatus(channel: string): Promise<BotComputersStatus> {
  const status = parseBotComputersStatus(await invoke<unknown>(channel));
  if (!status) throw new Error("Aiden returned an invalid Bot computer status.");
  return status;
}

async function botComputer(channel: string, botId: string): Promise<BotComputerStatus> {
  const computer = parseBotComputerStatus(await invoke<unknown>(channel, botId));
  if (!computer) throw new Error("Aiden returned an invalid Bot computer.");
  return computer;
}

/** Settings → Bot computers and the profile's Computer section (Apple silicon only). */
export const botComputersApi = {
  status: () => botComputersStatus(BOT_COMPUTER_CHANNELS.status),
  setUp: () => botComputersStatus(BOT_COMPUTER_CHANNELS.setUp),
  cancelSetUp: () => invoke<void>(BOT_COMPUTER_CHANNELS.cancelSetUp),
  updateBase: () => botComputersStatus(BOT_COMPUTER_CHANNELS.updateBase),
  removeEverything: () => botComputersStatus(BOT_COMPUTER_CHANNELS.removeEverything),
  updateSettings: (patch: Partial<BotComputersSettings>) =>
    invoke<BotComputersSettings>(BOT_COMPUTER_CHANNELS.updateSettings, patch),
  give: (botId: string) => botComputer(BOT_COMPUTER_CHANNELS.give, botId),
  reset: (botId: string) => botComputer(BOT_COMPUTER_CHANNELS.reset, botId),
  remove: (botId: string) => invoke<void>(BOT_COMPUTER_CHANNELS.remove, botId),
  stop: (botId: string) => invoke<void>(BOT_COMPUTER_CHANNELS.stop, botId),
  /** The Computer tab's stream target. `start` boots a stopped computer; only a person's switch to the tab passes it. */
  viewerGrant: async (botId: string, options: { start: boolean }): Promise<BotComputerViewerGrant> => {
    const grant = parseBotComputerViewerGrant(await invoke<unknown>(BOT_COMPUTER_CHANNELS.viewerGrant, botId, options));
    if (!grant) throw new Error("Aiden returned an invalid viewer grant.");
    return grant;
  },
  takeOver: (botId: string) => botComputer(BOT_COMPUTER_CHANNELS.takeOver, botId),
  giveBack: (botId: string) => botComputer(BOT_COMPUTER_CHANNELS.giveBack, botId),
  pointer: async (botId: string): Promise<BotComputerPointer | null> =>
    parseBotComputerPointer(await invoke<unknown>(BOT_COMPUTER_CHANNELS.pointer, botId)),
  /** Element control (the guest driver lane) on a ready base without it; progress arrives as broadcasts. */
  setUpElementControl: () => botComputersStatus(BOT_COMPUTER_CHANNELS.setUpElementControl),
  checkPermissions: () => invoke<void>(BOT_COMPUTER_CHANNELS.checkPermissions),
  skipPermissions: () => invoke<void>(BOT_COMPUTER_CHANNELS.skipPermissions),
  /** The base computer's screen while setup waits for the person's grants. */
  baseViewerGrant: async (): Promise<BotComputerViewerGrant> => {
    const grant = parseBotComputerViewerGrant(await invoke<unknown>(BOT_COMPUTER_CHANNELS.baseViewerGrant));
    if (!grant) throw new Error("Aiden returned an invalid viewer grant.");
    return grant;
  },
  onChanged: (handler: (status: BotComputersStatus) => void) =>
    onNotification<unknown>(BOT_COMPUTERS_CHANGED_CHANNEL, (payload) => {
      const status = parseBotComputersStatus(payload);
      if (status) handler(status);
    }),
};

async function invokeDeviceToolchain(channel: string): Promise<DeviceToolchainState> {
  const toolchain = parseDeviceToolchainState(await invoke<unknown>(channel));
  if (!toolchain) throw new Error("The simulator tool versions were invalid.");
  return toolchain;
}

async function invokeDeviceState(channel: string, ...args: unknown[]): Promise<DeviceServiceState> {
  const state = parseDeviceServiceState(await invoke<unknown>(channel, ...args));
  if (!state) throw new Error("The simulator state response was invalid.");
  return state;
}

async function invokeDeviceSettings(channel: string, ...args: unknown[]): Promise<DeviceSettings> {
  const settings = parseDeviceSettings(await invoke<unknown>(channel, ...args));
  if (!settings) throw new Error("The simulator settings response was invalid.");
  return settings;
}

export const devicesApi = {
  getState: () => invokeDeviceState("devices:get-state"),
  setConsent: (kind: DeviceConsentKind, granted: boolean) =>
    invokeDeviceState("devices:consent", kind, granted),
  /** Refreshes this Mac and paired Macs; `"local"` never contacts paired Macs. */
  refresh: (scope?: "local") =>
    scope ? invokeDeviceState("devices:refresh", scope) : invokeDeviceState("devices:refresh"),
  /** Contacts paired Macs only when the user asks. */
  refreshPeers: () => invokeDeviceState("devices:refresh-peers"),
  open: (input: { chatId: string; deviceId: string; hostId?: string }) =>
    invoke<DeviceSession>("devices:open", input),
  close: (input: { chatId: string; hostId: string; deviceId: string; shutdown?: boolean }) =>
    invoke<void>("devices:close", input),
  action: (input: DeviceActionInput) => invokeDeviceSettings("devices:action", input),
  settings: (input: { hostId: string; deviceId: string }) =>
    invokeDeviceSettings("devices:settings", input),
  screenshot: async (input: { hostId: string; deviceId: string }): Promise<Uint8Array> => {
    const png = await invoke<unknown>("devices:screenshot", input);
    if (!(png instanceof Uint8Array) || png.byteLength === 0) {
      throw new Error("The simulator screenshot was invalid.");
    }
    return png;
  },
  streamGrant: async (): Promise<DeviceStreamGrant> => {
    const grant = parseDeviceStreamGrant(await invoke<unknown>("devices:stream-grant"));
    if (!grant) throw new Error("The simulator stream grant was invalid.");
    return grant;
  },
  /** Installed helper versions, read from disk only. */
  toolchain: () => invokeDeviceToolchain("devices:toolchain"),
  pruneTools: () => invokeDeviceToolchain("devices:prune-tools"),
  /** Turns every simulator permission off and deletes the installed helpers. */
  removeTools: () => invokeDeviceState("devices:remove-tools"),
  /** An explicit Start, Connect, or Retry for one host; approved outdated helpers update here. */
  startHost: (hostId: string) => invokeDeviceState("devices:start-host", hostId),
  /** Installs or updates one pinned helper on a host after the user confirmed it. */
  updateTool: (input: { hostId: string; tool: "hub" | "agent" }) => invokeDeviceState("devices:update-tool", input),
  /** Reads helper versions; contacts SSH hosts but never installs or starts anything. */
  inspectTools: () => invokeDeviceState("devices:inspect-tools"),
  saveSshHost: (config: SshDeviceHostConfig) => invokeDeviceState("devices:ssh-save", config),
  removeSshHost: (hostId: string) => invokeDeviceState("devices:ssh-remove", hostId),
  /** **Test connection**: contacts the host once; never installs or starts anything there. */
  testSshHost: async (config: SshDeviceHostConfig): Promise<DeviceHostCheck> => {
    const check = parseDeviceHostCheck(await invoke<unknown>("devices:ssh-test", config));
    if (!check) throw new Error("The connection check response was invalid.");
    return check;
  },
  onState: (handler: (state: DeviceServiceState) => void) =>
    onNotification<unknown>("devices:state", (payload) => {
      const state = parseDeviceServiceState(payload);
      if (state) handler(state);
    }),
  /** The native trackpad gesture ended (Electron's `gestureScrollEnd`), so a 3D orbit can settle. */
  onTrackpadScrollEnd: (handler: () => void) => onNotification<unknown>("devices:trackpad-scroll-end", () => handler()),
  /** An agent opened a device for this chat; it floats over the chat or its tab comes forward. */
  onReveal: (handler: (chatId: string, target?: { hostId: string; deviceId: string }) => void) =>
    onNotification<unknown>("devices:reveal", (payload) => {
      const value = (payload ?? {}) as { chatId?: unknown; hostId?: unknown; deviceId?: unknown };
      if (typeof value.chatId !== "string" || !value.chatId) return;
      const target =
        typeof value.hostId === "string" && value.hostId && typeof value.deviceId === "string" && value.deviceId
          ? { hostId: value.hostId, deviceId: value.deviceId }
          : undefined;
      handler(value.chatId, target);
    }),
  /** Shuts the device down if it is booted, then erases it. `deviceId` is its id now (an emulator goes back to its AVD name). */
  erase: (target: DeviceFeatureTarget) => invoke<{ wasBooted: boolean; deviceId: string }>("devices:erase", target),
  /** Host clipboard text to the device: the simulator pasteboard (send Cmd+V afterwards), or typed into the emulator. */
  pasteClipboard: (target: DeviceFeatureTarget) => invoke<{ bytes: number }>("devices:clipboard-paste", target),
  /** The simulator's pasteboard text onto the host clipboard. */
  copyClipboard: (target: DeviceFeatureTarget) => invoke<{ bytes: number }>("devices:clipboard-copy", target),
  recordings: async (): Promise<DeviceRecordingInfo[]> => {
    const list = parseDeviceRecordingList(await invoke<unknown>("devices:recordings-list"));
    if (!list) throw new Error("The simulator recordings response was invalid.");
    return list;
  },
  startRecording: async (input: DeviceFeatureTarget & { chatId: string }): Promise<DeviceRecordingInfo> => {
    const info = parseDeviceRecordingInfo(await invoke<unknown>("devices:recording-start", input));
    if (!info) throw new Error("The simulator recording response was invalid.");
    return info;
  },
  stopRecording: async (id: string): Promise<DeviceRecordingInfo> => {
    const info = parseDeviceRecordingInfo(await invoke<unknown>("devices:recording-stop", { id }));
    if (!info) throw new Error("The simulator recording response was invalid.");
    return info;
  },
  /** Shows the save dialog; a cancelled dialog deletes the recording. */
  saveRecording: (id: string) => invokeDeviceSave("devices:recording-save", { id }),
  discardRecording: (id: string) => invoke<void>("devices:recording-discard", { id }),
  saveScreenshot: (input: { hostId: string; deviceId: string }) => invokeDeviceSave("devices:screenshot-save", input),
  /** Saves the 3D view's framed-device PNG through the same save dialog. */
  saveFramedScreenshot: (input: { hostId: string; deviceId: string; png: Uint8Array }) =>
    invokeDeviceSave("devices:framed-screenshot-save", input),
  /** Reveals a file this launch saved from the Simulator tab. */
  revealSaved: (path: string) => invoke<void>("devices:reveal-saved", { path }),
  onRecordings: (handler: (recordings: DeviceRecordingInfo[]) => void) =>
    onNotification<unknown>("devices:recordings", (payload) => {
      const list = parseDeviceRecordingList(payload);
      if (list) handler(list);
    }),
};

async function invokeDeviceSave(channel: string, input: unknown): Promise<DeviceSaveResult> {
  const result = parseDeviceSaveResult(await invoke<unknown>(channel, input));
  if (!result) throw new Error("The save response was invalid.");
  return result;
}

export const terminalApi = {
  create: (workspaceId: string) => invoke<TerminalSession>("terminal:create", workspaceId),
  snapshot: (sessionId: string) => invoke<TerminalSnapshot>("terminal:snapshot", sessionId),
  write: (sessionId: string, data: string) => invoke<void>("terminal:write", sessionId, data),
  resize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("terminal:resize", sessionId, cols, rows),
  close: (sessionId: string) => invoke<void>("terminal:close", sessionId),
};

// ── Git ───────────────────────────────────────────────────────────────
export const gitApi = {
  review: (workspaceId: string) => invoke<GitReview>("git:review", workspaceId),
  diff: (workspaceId: string, input: GitDiffInput) =>
    invoke<GitFileDiff>("git:diff", workspaceId, input),
  commit: (workspaceId: string, input: GitCommitInput) =>
    invoke<GitCommitResult>("git:commit", workspaceId, input),
  pushCapability: (workspaceId: string) =>
    invoke<GitPushCapability>("git:pushCapability", workspaceId),
  push: (workspaceId: string, input: GitPushInput) =>
    invoke<GitPushResult>("git:push", workspaceId, input),
  compare: (workspaceId: string, targetRef: string) =>
    invoke<GitComparison>("git:compare", workspaceId, targetRef),
  comparisonDiff: (workspaceId: string, input: GitComparisonDiffInput) =>
    invoke<GitFileDiff>("git:comparisonDiff", workspaceId, input),
  branches: (workspaceId: string) => invoke<GitBranches>("git:branches", workspaceId),
  checkout: (workspaceId: string, name: string) => invoke<void>("git:checkout", workspaceId, name),
  createBranch: (workspaceId: string, name: string) =>
    invoke<void>("git:createBranch", workspaceId, name),
  pullRequestStatus: (workspaceId: string, options?: { interactive?: boolean }) =>
    invoke<GitHubPullRequestStatus>(
      "git:pullRequestStatus",
      workspaceId,
      options?.interactive === true,
    ),
  worktrees: (workspaceId: string) => invoke<GitWorktree[]>("git:worktrees", workspaceId),
  createWorktree: (workspaceId: string, name: string) =>
    invoke<Workspace>("git:createWorktree", workspaceId, name),
  deleteManagedWorktree: (workspaceId: string, options?: { force?: boolean }) =>
    invoke<{ branchDeleted: boolean }>("git:deleteManagedWorktree", workspaceId, options),
  restoreManagedWorktree: (workspaceId: string, snapshotId: string, name?: string) =>
    invoke<Workspace>("git:restoreManagedWorktree", workspaceId, snapshotId, name),
};

// ── Chat ↔ pull requests ──────────────────────────────────────────────
// A chat durably links many PRs; the relationship is keyed by the canonical
// (host, repository, number) — never by the workspace's current branch.
export const pullRequestsApi = {
  list: (chatId: string) => invoke<ChatPullRequestListResult>("pullRequests:list", chatId),
  current: (chatId: string) =>
    invoke<{ pullRequest: ChatPullRequestView | undefined; reason: string; message?: string; rateLimitedUntil?: number }>(
      "pullRequests:current",
      chatId,
    ),
  /** Cache-only: each listed chat's best linked PR and dismissed refs, for sidebar rows. */
  sidebar: (chatIds: readonly string[]) =>
    invoke<Record<string, ChatSidebarPullRequests>>("pullRequests:sidebar", chatIds),
  candidates: (chatId: string, workspaceId?: string) =>
    invoke<ChatPullRequestCandidatesResult>("pullRequests:candidates", chatId, workspaceId),
  link: (chatId: string, input: { url: string }) =>
    invoke<ChatPullRequestLinkResult>("pullRequests:link", chatId, input),
  linkRef: (chatId: string, ref: ChatPullRequestRef, source?: "manual" | "branch-discovered") =>
    invoke<ChatPullRequestLinkResult>("pullRequests:linkRef", chatId, { ...ref, source }),
  unlink: (chatId: string, ref: ChatPullRequestRef) =>
    invoke<{ ok: boolean }>("pullRequests:unlink", chatId, ref),
  refresh: (chatId: string, ref?: ChatPullRequestRef) =>
    invoke<ChatPullRequestListResult>("pullRequests:refresh", chatId, ref),
  detectAfterPush: (
    chatId: string,
    input: { workspaceId: string; headBranch: string; expectedHeadSha?: string; repository?: string },
  ) => invoke<ChatPullRequestDetectResult>("pullRequests:detectAfterPush", chatId, input),
  create: (
    chatId: string,
    input: {
      workspaceId: string;
      title: string;
      body?: string;
      baseBranch: string;
      headBranch: string;
      expectedHeadSha?: string;
      repository?: string;
      draft?: boolean;
    },
  ) => invoke<ChatPullRequestCreateResult>("pullRequests:create", chatId, input),
  dismissPending: (chatId: string, operationId: string) =>
    invoke<void>("pullRequests:dismissPending", chatId, operationId),
  pending: (chatId: string) =>
    invoke<ChatPullRequestPendingCreate[]>("pullRequests:pending", chatId),
  adopt: (chatId: string, operationId: string, ref: ChatPullRequestRef) =>
    invoke<ChatPullRequestLinkResult>("pullRequests:adopt", chatId, operationId, ref),
};

// ── Workspace artifacts ───────────────────────────────────────────────
// Pages a workspace keeps in the Tools panel's Artifacts tab. Main owns the
// files and runs every source; the renderer only names ids.
export const workspaceArtifactsApi = {
  list: (workspaceId: string) => invoke<WorkspaceArtifactView[]>("workspaces:artifacts:list", workspaceId),
  rename: (workspaceId: string, artifactId: string, title: string) =>
    invoke<WorkspaceArtifactV1>("workspaces:artifacts:rename", workspaceId, artifactId, title),
  delete: (workspaceId: string, artifactId: string) =>
    invoke<{ removed: boolean }>("workspaces:artifacts:delete", workspaceId, artifactId),
  saveState: (workspaceId: string, artifactId: string, state: Record<string, unknown>) =>
    invoke<void>("workspaces:artifacts:saveState", workspaceId, artifactId, state),
  approve: (workspaceId: string, artifactId: string, digest: string) =>
    invoke<WorkspaceArtifactV1>("workspaces:artifacts:approve", workspaceId, artifactId, digest),
  /** Re-reads the page's sources in the workspace folder; every window gets a "refreshed" change. */
  refresh: (workspaceId: string, artifactId: string) =>
    invoke<Record<string, WorkspaceArtifactSourceResultV1>>("workspaces:artifacts:refresh", workspaceId, artifactId),
  /** Runs one of the page's buttons; main fills in the saved command. */
  run: (workspaceId: string, artifactId: string, action: string, args: unknown[], digest: string) =>
    invoke<{ ok: boolean; output: string }>("workspaces:artifacts:run", workspaceId, artifactId, action, args, digest),
  onChanged: (handler: (event: WorkspaceArtifactsChangedEvent) => void) =>
    onNotification<WorkspaceArtifactsChangedEvent>("workspaces:artifacts-changed", handler),
};

// ── Chats ─────────────────────────────────────────────────────────────
async function invokeChatMutation<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await invoke<T>(channel, ...args);
  } catch (error) {
    rememberAppendReconciliationFailure(error);
    throw error;
  }
}

export const chatsApi = {
  activitySnapshot: () => invoke<unknown>("chats:activitySnapshot"),
  readMarkers: () => invoke<unknown>("chats:readMarkers"),
  markRead: (id: string, throughMessageId?: string) =>
    invoke<boolean>("chats:markRead", id, throughMessageId),
  list: (workspaceId?: string) => invoke<ChatMeta[]>("chats:list", workspaceId),
  get: async (id: string) => {
    const response = parseChatReadResponse(await invoke<ChatReadResponse>("chats:get", id));
    if (!response) throw new Error("The chat read response was invalid.");
    if (response.reconciliation) {
      rememberChatReadReconciliation(response.reconciliation);
    }
    return response.chat
      ? {
          ...response.chat,
          imageArtifactRecoveryPending: response.imageArtifactRecoveryPending,
          imageArtifactRecoveryUnavailable: response.imageArtifactRecoveryUnavailable,
        }
      : null;
  },
  waitUntilIdle: (id: string) => invoke<boolean>("chats:waitUntilIdle", id),
  compact: (id: string, engine?: CompactionEngine) =>
    invoke<
      | {
          compacted: true;
          engine?: CompactionEngine;
          durationMs?: number;
          tokensBefore?: number;
          estimatedTokensAfter?: number;
        }
      | {
          compacted: false;
          reason:
            | "already_compact"
            | "busy"
            | "archived"
            | "not_canonical"
            | "provider_unavailable"
            | "context_metadata_invalid"
            | "cancelled"
            | "compaction_failed";
        }
    >("chats:compact", id, engine),
  cancelCompact: (id: string) => invoke<boolean>("chats:cancelCompact", id),
  // Next-request context projection for the composer meter. Pass the visible
  // draft, pending attachments, and the current model selection so the
  // projection matches what would actually be sent.
  contextPressure: async (
    chatId: string,
    draft?: {
      draftText?: string;
      attachments?: Attachment[];
      providerId?: string;
      modelId?: string;
    },
  ): Promise<ChatContextPressureV1 | null> => {
    const value = await invoke<unknown>("chats:contextPressure", {
      chatId,
      draftText: draft?.draftText,
      providerId: draft?.providerId,
      modelId: draft?.modelId,
      attachments: draft?.attachments?.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        textLength: attachment.kind === "text" ? attachment.text?.length : undefined,
      })),
    });
    if (value === null) return null;
    const pressure = parseChatContextPressure(value);
    if (!pressure) throw new Error("The context pressure response was invalid.");
    return pressure;
  },
  // Pushed when the runtime's own projection changes mid-turn or after a
  // compaction that did not come through this renderer's stream.
  onContextPressure: (
    handler: (chatId: string, pressure: ChatContextPressureV1 | null) => void,
  ): (() => void) =>
    onNotification<unknown>("chat:context-pressure", (payload) => {
      const event = parseChatContextPressureNotification(payload);
      if (event) handler(event.chatId, event.pressure);
    }),
  todoSnapshot: async (id: string): Promise<TodoSnapshotViewV1 | null> => {
    const value = await invoke<unknown>("chats:todoSnapshot", id);
    if (value === null) return null;
    const snapshot = parseTodoSnapshotView(value);
    if (!snapshot || snapshot.chatId !== id)
      throw new Error("The todo snapshot response was invalid.");
    return snapshot;
  },
  btwStart: (chatId: string, question: string) =>
    invoke<BtwStartReceiptV1>("chats:btwStart", { chatId, question }),
  btwCancel: (chatId: string, requestId: string) =>
    invoke<boolean>("chats:btwCancel", { chatId, requestId }),
  btwClear: (chatId: string) => invoke<void>("chats:btwClear", { chatId }),
  // Follow-through: background jobs, followed pull requests and the done-when check.
  followThrough: async (chatId: string): Promise<ChatFollowThroughV1> => {
    const value = parseChatFollowThrough(await invoke<unknown>("chats:followThrough", chatId));
    if (!value || value.chatId !== chatId) throw new Error("The follow-through response was invalid.");
    return value;
  },
  backgroundJobOutput: (chatId: string, jobId: string) =>
    invoke<BackgroundJobOutput>("chats:followThroughJobOutput", { chatId, jobId }),
  stopBackgroundJob: (chatId: string, jobId: string) =>
    invoke<void>("chats:followThroughStopJob", { chatId, jobId }),
  followPullRequest: (chatId: string) => invoke<void>("chats:followThroughFollowPullRequest", { chatId }),
  stopFollowingPullRequest: (chatId: string, ref: { host: string; repository: string; number: number }) =>
    invoke<void>("chats:followThroughStopFollow", { chatId, ...ref }),
  setDoneWhenCheck: (chatId: string, command: string) =>
    invoke<void>("chats:followThroughSetCheck", { chatId, command }),
  clearDoneWhenCheck: (chatId: string) => invoke<void>("chats:followThroughClearCheck", { chatId }),
  onBtwEvent: (handler: (event: BtwEventV1) => void) =>
    onNotification<unknown>("chats:btw-event", (payload) => {
      const event = parseBtwEvent(payload);
      if (event) handler(event);
    }),
  create: (input: { title?: string; workspaceId: string; providerId?: string; model?: string }) =>
    invokeChatMutation<Chat>("chats:create", input),
  createWithFirstMessage: (input: {
    draftId: string;
    title?: string;
    /** Ignored by main: a Bot chat always lives in its managed home. */
    workspaceId?: string;
    providerId?: string;
    model?: string;
    turnId: string;
    message: { role: "user"; content: string; attachments?: Attachment[] };
    skillInvocation?: SkillInvocationV1;
  }) => invokeChatMutation<Chat>("chats:createWithFirstMessage", input),
  /**
   * First send with New worktree. Main creates (or, for the same draft,
   * reuses) the managed worktree before saving the chat in it. A worktree
   * failure saves nothing and resolves `{ ok: false, code: "worktree-failed" }`;
   * chat-save failures reject as `createWithFirstMessage` does.
   */
  createWithFirstMessageInWorktree: (input: {
    draftId: string;
    title?: string;
    /** The draft's workspace; must equal `worktree.sourceWorkspaceId`. */
    workspaceId: string;
    providerId?: string;
    model?: string;
    turnId: string;
    message: { role: "user"; content: string; attachments?: Attachment[] };
    skillInvocation?: SkillInvocationV1;
    worktree: FirstMessageWorktreeRequest;
  }) => invokeChatMutation<FirstMessageWorktreeResult<Chat>>("chats:createWithFirstMessage", input),
  /** Progress of the caller's own first-send worktree (fetching → creating → ready). */
  onFirstMessageWorktreeProgress: (handler: (progress: FirstMessageWorktreeProgress) => void) =>
    onNotification<FirstMessageWorktreeProgress>("chats:first-message-worktree-progress", handler),
  createAssistant: (input: { providerId?: string; model?: string }) =>
    invokeChatMutation<Chat>("chats:createAssistant", input),
  rename: (id: string, title: string) => invoke<void>("chats:rename", id, title),
  renameWithFoundationModels: (id: string) =>
    invoke<ChatTitleRenameResult>("chats:renameWithFoundationModels", id),
  /**
   * Clone the whole visible chat, or fork it at `forkAt`. A fork with
   * `summary` also summarizes what the source did after the fork point.
   */
  copyVisibleHistory: (
    chatId: string,
    forkAt?: { messageId: string; position: ChatForkPosition },
    summary?: { instructions?: string },
  ) =>
    invokeChatMutation<Chat>("chats:copyVisibleHistory", {
      chatId,
      ...(forkAt ? { messageId: forkAt.messageId, position: forkAt.position } : {}),
      ...(summary ? { summary } : {}),
    }),
  retryForkSummary: (chatId: string) => invoke<Chat>("chats:retryForkSummary", { chatId }),
  cancelForkSummary: (chatId: string) => invoke<boolean>("chats:cancelForkSummary", { chatId }),
  skipForkSummary: (chatId: string) => invoke<Chat>("chats:skipForkSummary", { chatId }),
  export: (chatId: string) => invoke<{ status: "saved" | "cancelled" }>("chats:export", { chatId }),
  /** Save a stored chat image to Downloads under a new name; returns the saved path. */
  saveImageToDownloads: (chatId: string, attachmentId: string) =>
    invoke<{ path: string }>("chats:saveImageToDownloads", { chatId, attachmentId }),
  copyImage: (chatId: string, attachmentId: string) =>
    invoke<boolean>("chats:copyImage", { chatId, attachmentId }),
  /** Reveal a file saved by saveImageToDownloads in Finder. */
  showSavedImage: (filePath: string) => invoke<boolean>("chats:showSavedImage", filePath),
  moveEmptyToWorkspace: (id: string, workspaceId: string) =>
    invoke<Chat>("chats:moveEmptyToWorkspace", id, workspaceId),
  /** Clear the post-restart "continue Computer Use" callout without resuming. */
  dismissComputerUseContinue: (chatId: string) =>
    invoke<Chat>("chats:dismissComputerUseContinue", chatId),
  remove: (id: string) => invoke<void>("chats:remove", id),
  abandonTurn: (id: string, turnId: string) => invoke<boolean>("chats:abandonTurn", id, turnId),
  htmlArtifactSrcdoc: (
    chatId: string,
    mediaId: string,
    theme?: {
      colorScheme?: "light" | "dark";
      canvas?: string;
      foreground?: string;
      secondary?: string;
      accent?: string;
      /** Allowlisted semantic tokens; main sanitizes them again. */
      vars?: Record<string, string>;
    },
  ) =>
    invoke<{ title: string; src: string } | undefined>("chats:htmlArtifactSrcdoc", {
      chatId,
      mediaId,
      theme,
    }),
  /** Remember a native visual's local state (tabs, filters, sliders) on its message. */
  updateUiVisualState: (chatId: string, messageId: string, visualId: string, state: Record<string, unknown>) =>
    invoke<boolean>("chats:updateUiVisualState", { chatId, messageId, visualId, state }),
  exportHtmlArtifact: (chatId: string, mediaId: string) =>
    invoke<{ saved: boolean; canceled: boolean }>("chats:exportHtmlArtifact", {
      chatId,
      mediaId,
    }),
  appendMessage: (
    id: string,
    message: {
      role: ChatMessage["role"];
      content: string;
      model?: string;
      attachments?: Attachment[];
    },
    meta: {
      providerId?: string;
      model?: string;
      autoTitle?: boolean;
      turnId: string;
      skillInvocation?: SkillInvocationV1;
    },
  ) => invokeChatMutation<Chat>("chats:appendMessage", id, message, meta),
  approve: (
    approvalId: string,
    decision: ApprovalDecision,
    options?: { formFillExcludedOrders?: number[]; scope?: ToolApprovalScope },
  ) => invoke<void>("chat:approve", approvalId, decision, options),
  /** Persisted "always allow" rules, newest first. */
  listApprovalRules: () => invoke<ToolApprovalRuleView[]>("chat:listApprovalRules"),
  revokeApprovalRule: (id: string) =>
    invoke<{ revoked: boolean }>("chat:revokeApprovalRule", id),
  revokeAllApprovalRules: () =>
    invoke<{ revoked: number }>("chat:revokeAllApprovalRules"),
  answerQuestionnaire: (promptId: string, response: AskUserQuestionResponseV1) =>
    invoke<{ status: AskUserQuestionAnswerStatus } | undefined>(
      "chat:answerQuestionnaire",
      promptId,
      response,
    ),
};

export const botsApi = {
  getAccessNotice: () => invoke<BotNoticeStatus>("bots:getAccessNotice"),
  acknowledgeAccessNotice: (acknowledgement: BotNoticeAcknowledgement) =>
    invoke<BotNoticeStatus>("bots:acknowledgeAccessNotice", acknowledgement),
  getTelegramAccessNotice: (profile: string) =>
    invoke<BotNoticeStatus>("bots:getTelegramAccessNotice", profile),
  acknowledgeTelegramAccessNotice: (profile: string, acknowledgement: BotNoticeAcknowledgement) =>
    invoke<BotNoticeStatus>("bots:acknowledgeTelegramAccessNotice", {
      profile,
      acknowledgement,
    }),
  list: (includeArchived = false) => invoke<BotDefinition[]>("bots:list", includeArchived),
  get: (id: string) => invoke<BotDefinition | null>("bots:get", id),
  getCanonicalPhoto: (id: string) =>
    invoke<BotRendererCanonicalPhoto | null>("bots:getCanonicalPhoto", id),
  create: (input: { bot: BotCreateInput; access: BotAccessUpdate }) =>
    invoke<BotDefinition>("bots:create", input),
  update: (input: BotUpdateInput) => invoke<BotDefinition>("bots:update", input),
  getCapabilityCatalog: (botId?: string) =>
    invoke<BotCapabilityCatalog>("bots:getCapabilityCatalog", botId),
  getBotAccess: (id: string) => invoke<BotAccessState | null>("bots:getBotAccess", id),
  updateBotAccess: (input: { botId: string; expectedRevision: string; access: BotAccessUpdate }) =>
    invoke<BotAccessView>("bots:updateBotAccess", input),
  /** Permanently erases the Bot: chat, memory, routines, files, photo, Telegram link. */
  delete: (botId: string) => invoke<void>("bots:delete", botId),
  sessionState: (botId: string) => invoke<BotSessionState>("bots:sessionState", botId),
  /** Send to the Bot's one conversation. `requestId` is a fresh UUID per send, so a retry never doubles it. */
  send: (input: {
    botId: string;
    text: string;
    requestId: string;
    whenBusy?: "steer" | "followUp";
    attachments?: Array<{ type: "image"; mimeType: string; data: string }>;
  }) => invoke<{ submissionId: string; deduped: boolean }>("bots:send", input),
  resume: (botId: string, requestId: string) =>
    invoke<BotSessionState>("bots:resume", { botId, requestId }),
  dismiss: (botId: string, requestId: string) =>
    invoke<BotSessionState>("bots:dismiss", { botId, requestId }),
  /** Stop the reply that is running now. */
  stop: (botId: string) => invoke<BotSessionState>("bots:stop", botId),
  /** Pause the Bot (its turn, routines and replies) until `unpause`; the button reads Resume. */
  pause: (botId: string) => invoke<BotSessionState>("bots:pause", botId),
  /** Clear the pause. An interrupted turn then shows its Resume card again. */
  unpause: (botId: string) => invoke<BotSessionState>("bots:unpause", botId),
  /** Remove a queued message before its turn starts. */
  withdraw: (botId: string, submissionId: string) =>
    invoke<import("../../main/services/bot-runtime/bot-session-service").BotWithdrawResult>("bots:withdraw", {
      botId,
      submissionId,
    }),
  /** Answer a Bot tool approval by its wait id; the first answer wins. */
  approve: (waitId: string, decision: "allow" | "deny") =>
    invoke<{ decided: boolean }>("bots:approve", { waitId, decision }),
  /**
   * Answer the Bot's A–E question by its wait id; `answered` is false once the
   * question is no longer waiting (answered elsewhere or withdrawn).
   */
  answerQuestion: (botId: string, waitId: string, answer: import("../shared/ask-user-question").AskUserQuestionResponseV1) =>
    invoke<{ answered: boolean }>("bots:answerQuestion", { botId, waitId, answer }),
  /**
   * Answer the Bot's hand-off card by its wait id with Done or Skip, and an
   * optional note; `answered` is false once the card is no longer waiting.
   */
  answerHandoff: (
    botId: string,
    waitId: string,
    outcome: import("../shared/bot-handoffs").BotHandoffOutcome,
    note?: string,
  ) =>
    invoke<{ answered: boolean }>("bots:answerHandoff", {
      botId,
      waitId,
      outcome,
      ...(note === undefined ? {} : { note }),
    }),
  /** Open on a hand-off card: its page in the Bot's browser or the system browser. */
  openHandoff: (botId: string, waitId: string) =>
    invoke<{ opened: import("../../main/services/bot-runtime/bot-handoff-open").BotHandoffOpened }>("bots:openHandoff", {
      botId,
      waitId,
    }),
  pendingApprovals: (botId: string) =>
    invoke<import("../../main/services/bot-runtime/bot-approvals").BotApprovalPrompt[]>(
      "bots:pendingApprovals",
      botId,
    ),
  onApproval: (handler: (prompt: import("../../main/services/bot-runtime/bot-approvals").BotApprovalPrompt) => void) =>
    onNotification("bots:approval", handler),
  onApprovalSettled: (handler: (settled: { botId: string; waitId: string; outcome: string }) => void) =>
    onNotification("bots:approval-settled", handler),
  liveSubscribe: (botId: string) =>
    invoke<import("../shared/bot-live").BotLiveSnapshot>("bots:live:subscribe", botId),
  liveUnsubscribe: (botId: string) => invoke<void>("bots:live:unsubscribe", botId),
  liveSummary: (botId: string) =>
    invoke<import("../shared/bot-live").BotLiveSummary>("bots:live:summary", botId),
  onLiveEvent: (handler: (event: import("../shared/bot-live").BotLiveEvent) => void) =>
    onNotification<import("../shared/bot-live").BotLiveEvent>("bots:live:event", handler),
  /** Start Chat on a starter Bot: the same Bot every time; only the first call reports `created`. */
  createFromPreset: (input: { presetId: string; access?: BotAccessUpdate }) =>
    invoke<{ bot: BotDefinition; created: boolean }>("bots:createFromPreset", input),
  /** The one-time self-intro of a Bot made with the create flow. */
  introduce: (botId: string) => invoke<boolean>("bots:introduce", botId),
  /** Read-only Files: the Bot's own folder. */
  files: {
    list: (botId: string) => invoke<import("./types").WorkspaceFileIndex>("bots:files:list", botId),
    read: (botId: string, path: string) =>
      invoke<import("./types").WorkspaceFileDocument>("bots:files:read", botId, path),
  },
  /** Not now on a connect card: this Bot won't suggest that connection again. */
  dismissConnection: (botId: string, pluginId: string) =>
    invoke<void>("bots:connections:dismiss", botId, pluginId),
  setPhoto: (botId: string, photo: { mimeType: "image/png" | "image/jpeg"; data: string }) =>
    invoke<void>("bots:photo:set", botId, photo),
  removePhoto: (botId: string) => invoke<void>("bots:photo:remove", botId),
  routines: {
    list: (botId: string) =>
      invoke<import("../../main/services/scheduled-bot-routines").BotRoutine[]>("bots:routines:list", botId),
    create: (input: import("../../main/services/scheduled-bot-routines").BotRoutineCreateInput) =>
      invoke<import("../../main/services/scheduled-bot-routines").BotRoutine>("bots:routines:create", input),
    update: (input: import("../../main/services/scheduled-bot-routines").BotRoutineUpdateInput) =>
      invoke<import("../../main/services/scheduled-bot-routines").BotRoutine>("bots:routines:update", input),
    delete: (input: import("../../main/services/scheduled-bot-routines").BotRoutineDeleteInput) =>
      invoke<void>("bots:routines:delete", input),
    /** Start one run now (Run now on the "skipped while paused" notice). */
    runNow: (botId: string, routineId: string, expectedUpdatedAt?: number) =>
      invoke<{ runId: string }>("bots:routines:runNow", {
        botId,
        routineId,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      }),
  },
  /** What a Bot remembers (USER.md and MEMORY.md), and the person's edits to it. */
  memory: {
    get: (botId: string) => invoke<import("../shared/bot-memory").BotMemoryView>("bots:memory:get", botId),
    /** A replace, remove or clear; a stale entry id answers `entry_not_found` with the fresh view. */
    edit: (input: import("../shared/bot-memory").BotMemoryEditInput) =>
      invoke<import("../shared/bot-memory").BotMemoryEditResult>("bots:memory:edit", input),
  },
  /** A Bot's rules: what it must ask about first or hand to the person. */
  rules: {
    get: (botId: string) => invoke<import("../shared/bot-rules").BotRulesView>("bots:rules:get", botId),
    /** One change against the view's revision; a refused change answers its reason with the fresh view. */
    update: (input: import("../shared/bot-rules").BotRulesUpdateInput) =>
      invoke<import("../shared/bot-rules").BotRulesUpdateResult>("bots:rules:update", input),
  },
  /** A Bot's own browser: its workspace for the `browser:*` channels, or null when the Bot is gone. */
  browser: {
    workspace: (botId: string) => invoke<{ workspaceId: string } | null>("bots:browser:workspace", botId),
  },
  /** Any write to a Bot's memory: the person's, the Bot's own, a review or a compaction flush. */
  onMemoryChanged: (handler: (event: import("../shared/bot-memory").BotMemoryChangedEvent) => void) =>
    onNotification<import("../shared/bot-memory").BotMemoryChangedEvent>("bots:memory:changed", handler),
  routineProposals: {
    /** Add routine or Not now on a Bot's proposal card; a repeated answer returns the settled status. */
    respond: (input: import("../shared/bot-routine-proposals").BotRoutineProposalRespondInput) =>
      invoke<import("../shared/bot-routine-proposals").BotRoutineProposalRespondResult>(
        "bots:routineProposals:respond",
        input,
      ),
  },
  getTelegramBinding: (id: string) =>
    invoke<import("../shared/bots").TelegramBotBindingView | null>("bots:getTelegramBinding", id),
  listTelegramTargets: () =>
    invoke<import("../shared/bots").TelegramBotTargetOption[]>("bots:listTelegramTargets"),
  bindTelegram: (input: { botId: string; profile: string; threadId?: number }) =>
    invoke<import("../shared/bots").TelegramBotBindingView>("bots:bindTelegram", input),
  unbindTelegram: (id: string) =>
    invoke<import("../shared/bots").TelegramBotBindingView>("bots:unbindTelegram", id),
};

export const subagentsApi = {
  get: async (chatId: string, runId: string): Promise<SubagentHistoryDetailV1 | null> =>
    parseSubagentHistoryDetailV1(await invoke<unknown>("subagents:get", chatId, runId)) ?? null,
  manage: async (
    chatId: string,
    request: SubagentManagementRequestV2,
  ): Promise<SubagentManagementResultV2> => {
    const result = parseSubagentManagementResultV2(
      await invoke<unknown>("subagents:manage", chatId, request),
    );
    if (!result || result.action !== request.action) {
      throw new Error("Aiden returned an invalid subagent control response.");
    }
    return result;
  },
  status: (chatId: string, runId: string) =>
    subagentsApi.manage(chatId, { version: 2, action: "status", runId }),
  wait: (chatId: string, runId: string, timeoutMs: number) =>
    subagentsApi.manage(chatId, {
      version: 2,
      action: "wait",
      runId,
      timeoutMs,
    }),
  stop: (chatId: string, runId: string) =>
    subagentsApi.manage(chatId, { version: 2, action: "stop", runId }),
  retry: (chatId: string, runId: string) =>
    subagentsApi.manage(chatId, { version: 2, action: "retry", runId }),
  steer: (chatId: string, runId: string, instruction: string) =>
    subagentsApi.manage(chatId, {
      version: 2,
      action: "steer",
      runId,
      instruction,
    }),
};

// ── Streaming generation ──────────────────────────────────────────────
export type ChatStatusPhase = "model_loading" | "model_ready";

export type ToolPhase = "call" | "result" | "error" | "blocked";

export interface ApprovalPrompt {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  details?: ToolApprovalDetails;
  canAllow?: boolean;
  /** Allow scopes offered for this call; absent means allow once only. */
  scopes?: ToolApprovalScope[];
  source?: "remote";
}

export interface RemoteApprovalPrompt {
  approvalId: string;
  streamId: string;
  chatId: string;
  summary: string;
  toolCallId: string;
  toolName: string;
  expiresAt: string;
  canAllow: boolean;
  scopes?: ToolApprovalScope[];
  details?: ToolApprovalDetails;
}

export interface GenerationHandle {
  streamId: string;
  started: Promise<GenerationStartResult>;
  cancel: (origin: "lifecycle" | "user_stop") => void;
}

/** Stop a same-document generation after its visible pane has released ownership. */
export function stopDetachedGeneration(streamId: string): Promise<boolean> {
  return invoke<boolean>("chat:cancel", streamId, "user_stop");
}

/**
 * Shared foreground admission for mid-flight input. Same Mac-owned boundary
 * as Remote `POST /streams/{id}/inputs`; the renderer document must own the
 * generation. Desktop Steer (composer and queued rows) uses it; desktop
 * follow-ups keep their local queue UX.
 */
export function admitChatRunInput(
  streamId: string,
  input: { mode: ChatRunInputMode; text: string },
): Promise<ChatRunInputAdmissionResult> {
  return invoke<ChatRunInputAdmissionResult>("chat:admitRunInput", streamId, input);
}

export type GenerationStartResult = { ok: true } | { ok: false; error: Error };

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onReset?: () => void;
  onReasoningDelta?: (delta: string) => void;
  onDone: (
    fullContent: string,
    timeline?: GenerationTimeline,
    chat?: Chat,
    reasoning?: string,
  ) => void | Promise<void>;
  onError: (
    message: string,
    partialContent?: string,
    timeline?: GenerationTimeline,
    chat?: Chat,
    reasoning?: string,
  ) => void;
  onTimeline?: (timeline: GenerationTimeline) => void;
  onArtifactEvent?: (event: ChatArtifactEventV1) => void;
  onSubagents?: (snapshot: SubagentRunSnapshot) => void;
  onTool?: (phase: ToolPhase, toolName: string) => void;
  onApproval?: (prompt: ApprovalPrompt) => void;
  onQuestionnaire?: (prompt: AskUserQuestionPromptV1) => void;
  onTodo?: (snapshot: TodoSnapshotViewV1) => void;
  onStatus?: (phase: ChatStatusPhase) => void;
  /** The AGENTS.md files cut short or skipped for this response (empty: all fit). */
  onAgentsInstructionNotices?: (notices: AgentsInstructionNotice[]) => void;
  onContextPressure?: (pressure: ChatContextPressureV1 | null) => void;
}

export function createChatTurnId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Starts a streaming generation. Subscribes to delta/done/error broadcasts
 * (filtered by a client-generated streamId) BEFORE kicking off the backend, so
 * no opening tokens are missed. Auto-unsubscribes on done/error.
 */
export function startGeneration(
  params: ChatStartParams,
  callbacks: StreamCallbacks,
  messageTurnId: string,
): GenerationHandle {
  const streamId = messageTurnId;
  rememberOwnGenerationStream(streamId);
  const stream = subscribeGenerationStream(
    streamId,
    { chatId: params.chatId, workspaceId: params.workspaceId },
    callbacks,
  );
  const dispose = stream.dispose;

  const started: Promise<GenerationStartResult> = invoke<{
    streamId: string;
    accepted: boolean;
    started: boolean;
    error?: string;
  }>("chat:start", streamId, params, messageTurnId).then(
    (result) => {
      if (result.accepted) {
        if (result.error) {
          callbacks.onError(result.error);
          dispose();
        }
        return { ok: true as const };
      }
      return {
        ok: false as const,
        error: new Error("Generation was rejected before it accepted this message."),
      };
    },
    (error: unknown) => {
      const resolved = error instanceof Error ? error : new Error(String(error));
      if (fallbackDetachedLifecycleStream(streamId)) {
        dispose();
        return { ok: false as const, error: resolved };
      }
      callbacks.onError(resolved.message);
      dispose();
      return { ok: false as const, error: resolved };
    },
  );

  let lifecycleDetached = false;
  let userStopRequested = false;

  return {
    streamId,
    started,
    cancel: (origin) => {
      if (origin === "lifecycle") {
        if (lifecycleDetached) return;
        lifecycleDetached = true;
        rememberDetachedLifecycleStream(
          {
            streamId,
            chatId: params.chatId,
            workspaceId: params.workspaceId ?? "default",
          },
          stream.projection(),
        );
        dispose();
        // Renderer lifecycle only releases this document's subscriptions. The
        // main-owned operation continues and the shell reconciles its durable
        // terminal snapshot. Authority-changing main operations still cancel
        // and drain the generation explicitly.
      } else {
        if (userStopRequested) return;
        userStopRequested = true;
      }
      void invoke("chat:cancel", streamId, origin).catch((error: unknown) => {
        if (origin === "user_stop") {
          callbacks.onError(error instanceof Error ? error.message : String(error));
          dispose();
        }
      });
    },
  };
}

// --- Text to Speech (Read aloud) ---

export interface TtsAudioReadResult {
  bytes: Uint8Array;
  mimeType: "audio/wav" | "audio/l16";
  sampleRate: number;
  channels: number;
  segmentBytes: number;
  nextOffset: number;
  complete: boolean;
}

export const ttsApi = {
  status: (chatId?: string) =>
    invoke<{
      settings: TtsSettings;
      settingsRevision: string;
      credentialReady: boolean;
      credentialSourceLabel: string;
      synthesisReady: boolean;
      latestSource: {
        source: TtsSourceRef | null;
        reason: string;
      };
      job: TtsJobSnapshot | null;
    }>("tts:status", chatId ? { chatId } : {}),
  getSettings: () =>
    invoke<{ settings: TtsSettings; settingsRevision: string }>("tts:settings:get"),
  updateSettings: (expectedRevision: string, patch: unknown) =>
    invoke<{ settings: TtsSettings; settingsRevision: string }>(
      "tts:settings:update",
      { expectedRevision, patch },
    ),
  setDedicatedCredential: (apiKey: string) =>
    invoke<{ ok: true }>("tts:credential:set", { apiKey }),
  clearDedicatedCredential: () => invoke<{ ok: true }>("tts:credential:clear"),
  starterVoices: () =>
    invoke<Array<{ providerVoiceId: string; name: string; kind: "prebuilt" }>>(
      "tts:voices:starter",
    ),
  listVoices: (pageToken?: string) =>
    invoke<{
      voices: Array<{ providerVoiceId: string; name: string; kind: "prebuilt" | "prompted" | "replicated" }>;
      nextPageToken: string | null;
    }>("tts:voices:list", pageToken ? { pageToken } : undefined),
  preview: () =>
    invoke<
      | { ok: true; snapshot: TtsJobSnapshot }
      | { ok: false; error: TtsSafeError }
    >("tts:preview"),
  start: (request: { requestId: string; source: TtsSourceRef; settingsRevision: string }) =>
    invoke<
      | { ok: true; snapshot: TtsJobSnapshot }
      | { ok: false; error: TtsSafeError }
    >("tts:start", request),
  readAudio: (jobId: string, segment: number, offset: number, maxBytes: number) =>
    invoke<TtsAudioReadResult | null>("tts:audio:read", {
      jobId,
      segment,
      offset,
      maxBytes,
    }),
  pause: () => invoke<TtsJobSnapshot | null>("tts:pause"),
  resume: () => invoke<TtsJobSnapshot | null>("tts:resume"),
  stop: () => invoke<{ ok: true }>("tts:stop"),
  clearCache: () => invoke<{ ok: true }>("tts:cache:clear"),
  onEvent: (handler: (event: TtsServiceEvent) => void) =>
    onNotification<TtsServiceEvent>("tts:event", handler),
};
