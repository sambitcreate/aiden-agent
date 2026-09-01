// Renderer-side mirror of the backend data shapes (types only; no runtime import
// across the process boundary).

import type { AppearanceConfig } from "../shared/appearance";
import type { KeybindingOverridesV1 } from "../shared/keybindings";
import type { AnthropicThinkingLevel } from "../shared/anthropic-thinking";
import type { CodexThinkingLevel } from "../shared/codex-thinking";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";
import type { GenerationTimeline } from "../shared/generation-timeline";
import type { GoogleThinkingLevel } from "../shared/google-thinking";
import type { SubagentMessageReferenceV1 } from "../shared/subagent-runs";
import type { SkillProvenanceV1 } from "../shared/slash-commands";
import type { ProviderFailureV1 } from "../shared/provider-failure";
import type { ProviderArtwork } from "../shared/provider-artwork";
import type {
  BoundedNonSecretProviderConfig,
  WebSearchProviderId,
  WebSearchProviderRendererMetadata,
  WebSearchRendererSnapshot,
  WebSearchRouteEntry,
  WebSearchSelection,
  WebSearchSettingsV2,
} from "../../main/services/web-search-provider-registry-core";
import type {
  WebSearchExistingAuthConsentRequest,
  WebSearchExistingAuthRendererOption,
  WebSearchExistingAuthRendererSnapshot,
  WebSearchExistingAuthRendererStatus,
} from "../../main/services/web-search-auth-reuse-core";
export type {
  BoundedNonSecretProviderConfig,
  WebSearchProviderId,
  WebSearchProviderRendererMetadata,
  WebSearchRendererSnapshot,
  WebSearchRouteEntry,
  WebSearchSelection,
  WebSearchSettingsV2,
};
export type {
  WebSearchExistingAuthConsentRequest,
  WebSearchExistingAuthRendererOption,
  WebSearchExistingAuthRendererSnapshot,
  WebSearchExistingAuthRendererStatus,
};
import type { HiddenModelsByProvider } from "../shared/model-visibility";
export type { BotDefinition } from "../shared/bots";

export type ProviderKind = "openai" | "anthropic";

export type ProviderDeployment = "local" | "hosted";

export type ProviderModelType = "llm" | "embedding" | "reranker" | "image" | "audio" | "video";

export interface ProviderModelMetadata {
  source: "lmstudio" | "ollama" | "provider";
  name?: string;
  type?: ProviderModelType;
  vision?: boolean;
  toolCall?: boolean;
  reasoning?: boolean;
  thinkingLevels?: GenerationThinkingLevel[];
  thinkingCanDisable?: boolean;
  contextLength?: number;
  parameterCount?: string;
  format?: string;
}

export interface Provider {
  id: string;
  kind: ProviderKind;
  label: string;
  artwork?: ProviderArtwork;
  baseUrl: string;
  models: string[];
  modelMetadata?: Record<string, ProviderModelMetadata>;
  defaultModel?: string;
  needsKey: boolean;
  /** Explicit local vs hosted; when unset, inferred from loopback base URL. */
  deployment?: ProviderDeployment;
  isPreset?: boolean;
  /** Pi owns this provider's endpoint, models, auth, and transport. */
  isBuiltin?: boolean;
  hasKey: boolean;
  /** True only when Aiden owns a stored credential it can remove. */
  canLogout?: boolean;
  /** Former custom IDs remapped during a safe provider-identity migration. */
  legacyIds?: string[];
  /** Pi-owned setup options. Credential payloads never leave Electron main. */
  authMethods?: Array<{
    type: "api_key" | "oauth";
    label: string;
    canLogin: boolean;
  }>;
}

export interface ProviderCatalogRefreshResult {
  providers: Provider[];
  errors: Array<{ providerId: string; message: string }>;
}

export interface ModelsDevCatalogStatus {
  source: "bundled" | "device-cache";
  fetchedAt: string | null;
}

export interface ProviderCatalogUpdateResult {
  providers: Provider[];
  inventoryErrors: Array<{ providerId: string; message: string }>;
  modelsDev: {
    ok: boolean;
    status: ModelsDevCatalogStatus;
    message?: string;
  };
}

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex" as const;

export interface CodexModelSummary {
  id: string;
  name: string;
  api: "openai-codex-responses";
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingLevels: CodexThinkingLevel[];
}

export interface CodexProviderSnapshot {
  id: typeof OPENAI_CODEX_PROVIDER_ID;
  name: string;
  authName: string;
  configured: boolean;
  needsAttention: boolean;
  models: CodexModelSummary[];
}

export interface CodexProviderStatusChanged {
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  needsAttention: boolean;
}

export interface ProviderAuthSelectOption {
  id: string;
  label: string;
  description?: string;
}

export interface ProviderAuthPrompt {
  flowId: string;
  providerId: string;
  promptId: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: ProviderAuthSelectOption[];
}

export type ProviderAuthEvent =
  | {
      flowId: string;
      providerId: string;
      type: "info";
      message: string;
      links?: Array<{ url: string; label?: string }>;
    }
  | {
      flowId: string;
      providerId: string;
      type: "auth_url";
      url: string;
      instructions?: string;
    }
  | {
      flowId: string;
      providerId: string;
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | {
      flowId: string;
      providerId: string;
      type: "browser_open_failed";
      url: string;
      message: string;
    }
  | {
      flowId: string;
      providerId: string;
      type: "progress";
      message: string;
    };

export interface ProviderAuthDone {
  flowId: string;
  providerId: string;
  cancelled: boolean;
  warning?: string;
}

export interface OnboardingProviderValidationResult {
  provider: Provider;
  catalogWarning?: string;
}

export interface ProviderAuthError {
  flowId: string;
  providerId: string;
  code: "port_busy" | "rate_limited" | "timed_out" | "verification_failed" | "sign_in_failed";
  message: string;
}

export type WorkspacePermission = "full" | "ask" | "none";

export interface ManagedWorktree {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  worktreeGitDir?: string;
  ownershipToken?: string;
  worktreeDevice?: number;
  worktreeInode?: number;
  createdFromHead: string;
}

export interface Workspace {
  id: string;
  name: string;
  folderPath?: string;
  permission: WorkspacePermission;
  managedWorktree?: ManagedWorktree;
  createdAt: number;
  updatedAt: number;
}

export interface ExternalEditor {
  id: string;
  label: string;
  iconDataUrl: string;
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  detached?: boolean;
  unborn?: boolean;
  uncommitted?: number;
  upstream?: string;
  ahead?: number;
  behind?: number;
  defaultBranch?: string;
  hasRemote?: boolean;
  remoteState?: "local-ref";
}

export interface GitBranches {
  isRepo: boolean;
  current?: string;
  branches: string[];
  remoteBranches: string[];
  uncommitted: number;
  detached?: boolean;
  unborn?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  defaultBranch?: string;
  hasRemote?: boolean;
  remoteState?: "local-ref";
}

export interface GitWorktree {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  current: boolean;
}

export type GitReviewFileStatus =
  | "added"
  | "conflicted"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "untracked";

export interface GitReviewFile {
  path: string;
  previousPath?: string;
  status: GitReviewFileStatus;
  staged: boolean;
  unstaged: boolean;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitReviewSummary {
  fileCount: number;
  additions: number;
  deletions: number;
  unavailableStats: number;
  stagedFiles: number;
  unstagedFiles: number;
  conflictedFiles: number;
}

export interface GitCommitCapability {
  allowed: boolean;
  reason?: string;
  snapshot?: string;
  snapshotComplete: boolean;
  repositoryRoot: boolean;
}

export interface GitReview {
  isRepo: boolean;
  branch?: string;
  files: GitReviewFile[];
  summary: GitReviewSummary;
  commit: GitCommitCapability;
}

export interface GitDiffInput {
  expectedSnapshot: string;
  path: string;
}

export type GitCommitMode = "staged" | "all";

export interface GitCommitInput {
  expectedSnapshot: string;
  message: string;
  mode: GitCommitMode;
}

export interface GitCommitResult {
  commit: string;
  branch: string;
  remainingChanges?: number;
  subject: string;
  warning?: string;
}

export interface GitPushCapability {
  allowed: boolean;
  reason?: string;
  branch?: string;
  expectedHead?: string;
  remotes: string[];
  remoteIdentities: Record<string, string>;
  suggestedRemote?: string;
  destinationBranch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  repositoryRoot: boolean;
  remoteState: "local-ref";
}

export interface GitPushInput {
  destinationBranch: string;
  expectedBranch: string;
  expectedHead: string;
  expectedRemoteIdentity: string;
  remote: string;
  setUpstream: boolean;
}

export interface GitPushResult {
  branch: string;
  commit: string;
  destinationBranch: string;
  remote: string;
  upstreamSet: boolean;
  warning?: string;
}

export interface GitComparison {
  currentBranch?: string;
  expectedHead: string;
  expectedTarget: string;
  targetRef: string;
  targetLabel: string;
  mergeBase: string;
  ahead: number;
  behind: number;
  files: GitReviewFile[];
  summary: GitReviewSummary;
  snapshot: string;
  remoteState: "local-ref";
}

export interface GitComparisonDiffInput {
  expectedHead: string;
  expectedTarget: string;
  mergeBase: string;
  path: string;
  targetRef: string;
}

export interface GitFileDiff {
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}

export type WorkspaceFileKind = "directory" | "file" | "symlink";

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  parentPath: string;
  depth: number;
  kind: WorkspaceFileKind;
  symbolic?: boolean;
  size?: number;
  modifiedAt?: number;
}

export interface WorkspaceFileIndex {
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  skippedDirectories: number;
}

export interface WorkspaceFileDocument {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  version: string;
  warning?: string;
}

export type WorkspaceFileWriteResult =
  | { ok: true; document: WorkspaceFileDocument }
  | { ok: false; code: "changed_on_disk" | "io_error"; message: string };

export type ChatRole = "user" | "assistant" | "system";

export type AttachmentKind = "image" | "text";

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  /** base64 (no data: prefix) for image attachments. */
  data?: string;
  /** UTF-8 contents for text/code attachments (truncated). */
  text?: string;
}

export interface ModelRanking {
  capabilityPercentile: number;
  responseTimePercentile: number;
  source: string;
  sourceUrl?: string;
  measuredAt?: string;
}

export type ModelBenchmarkMetric = "intelligence" | "coding" | "agentic";

export interface ModelBenchmarkScores {
  source: "openrouter";
  datasetSource: "artificial-analysis";
  sourceLabel: "Artificial Analysis via OpenRouter";
  sourceUrl: string;
  citation: string;
  asOf: string;
  license: "CC BY 4.0";
  intelligence?: number;
  coding?: number;
  agentic?: number;
}

export type ModelMetadataSource =
  | "local"
  | "provider"
  | "artificial-analysis"
  | "models-dev"
  | "fallback";

export interface ModelInfo {
  id: string;
  name?: string;
  vision?: boolean;
  toolCall?: boolean;
  reasoning?: boolean;
  openWeights?: boolean;
  /** Normalized capability classification; every value except `llm` is non-chat. */
  modelType?: ProviderModelType;
  parameterCount?: string;
  format?: string;
  contextLength?: number;
  outputLimit?: number;
  inputModalities?: string[];
  knowledge?: string;
  releaseDate?: string;
  ranking?: ModelRanking;
  benchmark?: ModelBenchmarkScores;
  metadataSource: ModelMetadataSource;
  matched: boolean;
}

export interface ModelInsightsStatus {
  hasKey: boolean;
  ready: boolean;
  cachedModelCount: number;
  fetchedAt?: string;
  asOf?: string;
  citation?: string;
  license?: "CC BY 4.0";
}

export type ModelInsightsActionErrorCode =
  | "not_connected"
  | "invalid_key"
  | "rate_limited"
  | "service_unavailable"
  | "network_error"
  | "invalid_response"
  | "local_error";

export type ModelInsightsActionResult =
  | { ok: true; status: ModelInsightsStatus }
  | { ok: false; code: ModelInsightsActionErrorCode; message: string };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  model?: string;
  reasoning?: string;
  providerFailure?: ProviderFailureV1;
  attachments?: Attachment[];
  htmlArtifacts?: import("../shared/chat-artifacts").ChatHtmlArtifactV1[];
  skill?: SkillProvenanceV1;
  timeline?: GenerationTimeline;
  subagents?: SubagentMessageReferenceV1;
}

export interface ChatMeta {
  id: string;
  title: string;
  workspaceId?: string;
  botId?: string;
  providerId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Chat extends ChatMeta {
  computerUseEnabled?: boolean;
  /** Main-owned crash stage exists and must be recovered before another chat mutation. */
  imageArtifactRecoveryPending?: boolean;
  /** Main-owned image staging could not be opened or quarantined automatically. */
  imageArtifactRecoveryUnavailable?: boolean;
  messages: ChatMessage[];
}

/**
 * Main-process chat reads may be intentionally provisional when a generation
 * owned by a replaced renderer has not crossed its durability barrier yet.
 */
export interface ChatReadResponse {
  chat: Chat | null;
  imageArtifactRecoveryPending: boolean;
  imageArtifactRecoveryUnavailable: boolean;
  reconciliation: {
    chatId: string;
    workspaceId: string;
  } | null;
}

export type ScheduledTaskMode = "llm" | "script";
export type ScheduledTaskPermission = "read-only" | "full";
export type ScheduledTaskExecutionProfile = "assistant";
export type ScheduledRunResult = "success" | "error" | "silent" | "blocked";

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  mode: ScheduledTaskMode;
  cron: string;
  timezone: string;
  nextRunAt?: number;
  lastRunAt?: number;
  workspaceId?: string;
  providerId?: string;
  model?: string;
  prompt?: string;
  script?: string;
  permission: ScheduledTaskPermission;
  /** Exact configured MCP servers approved for unattended use. */
  mcpServerIds?: string[];
  /** Main-owned runtime profile, exposed read-only for truthful capability display. */
  executionProfile?: ScheduledTaskExecutionProfile;
  /** Explicit Web Search authority; omitted legacy values are closed. */
  webSearchEnabled?: boolean;
  chatId?: string;
  notify: boolean;
  lastResult?: ScheduledRunResult;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  startedAt: number;
  finishedAt: number;
  result: ScheduledRunResult;
  output: string;
  error?: string;
  chatId?: string;
}

export interface ScheduledTaskInput {
  id?: string;
  name: string;
  enabled?: boolean;
  mode: ScheduledTaskMode;
  cron: string;
  timezone?: string;
  workspaceId?: string;
  providerId?: string;
  model?: string;
  prompt?: string;
  script?: string;
  permission?: ScheduledTaskPermission;
  /** Exact configured MCP servers this task may invoke unattended. */
  mcpServerIds?: string[];
  /** Explicit Web Search authority. New tasks default to false. */
  webSearchEnabled?: boolean;
  notify?: boolean;
}

export interface ScheduledTaskSettings {
  enabled: boolean;
  defaultMode: ScheduledTaskMode;
  defaultPermission: ScheduledTaskPermission;
  defaultMcpEnabled: boolean;
  defaultNotify: boolean;
  defaultTimezone: string;
}

export interface ChatMetadataUpdated {
  chatId: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
}

export interface ChatTitleRenameResult extends ChatMetadataUpdated {
  changed: boolean;
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: boolean;
  /** Set when this record came from the built-in preset catalog. */
  presetId?: string;
  enabled: boolean;
}

export type McpPresetAuth =
  | { kind: "apiKey"; headerName: string; keyLabel: string; keyHelpUrl: string }
  | { kind: "oauth" };

/** A built-in MCP provider definition from the main-process catalog. */
export interface McpPreset {
  id: string;
  name: string;
  tagline: string;
  vendor: string;
  category: string;
  transport: "http";
  url: string;
  auth: McpPresetAuth;
  docsUrl: string;
}

/** Catalog entry plus the user's connection state for it. */
export interface McpPresetState {
  preset: McpPreset;
  serverId: string;
  configured: boolean;
  enabled: boolean;
  /** API key stored (apiKey presets) or OAuth tokens present (oauth presets). */
  ready: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

/** An Agent Skill discovered on disk from a `.agents` folder (read-only). */
export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  source: "workspace" | "global";
  path: string;
}

export type VoiceProvider = "openai" | "gemini" | "local";
export type GeminiUsageScope = "transcription_only" | "models_and_transcription";

export type ChatTitleProviderId = "automatic" | "apple-foundation-models" | "chat-model";

export type FoundationModelsConnectionState =
  | "ready"
  | "unsupported_os"
  | "device_not_eligible"
  | "apple_intelligence_disabled"
  | "model_preparing"
  | "helper_unavailable"
  | "unavailable"
  | "error";

export interface FoundationModelsConnectionStatus {
  id: "apple-foundation-models";
  label: "Apple Foundation Models";
  state: FoundationModelsConnectionState;
  detail: string;
  local: true;
  titleOnly: true;
  retryable: boolean;
}

/** How much the Aiden assistant may do with app settings through its tools. */
export type AssistantSettingsPermission = "full" | "ask" | "none";

/** Aiden assistant window, hotkey, and proactive-watching settings. */
export interface AssistantConfig {
  /** Proactivity master switch. Off by default — nudging is opt-in. */
  enabled: boolean;
  hotkeyEnabled: boolean;
  hotkeyAccelerator: string;
  /** Required pin before proactivity may run. See main/services/types.ts. */
  providerId?: string;
  model?: string;
  watchUncommitted: boolean;
  watchUntouchedProjects: boolean;
  watchConfigChanges: boolean;
  pollIntervalMinutes: number;
  untouchedThresholdDays: number;
  quietHoursEnabled: boolean;
  /** "HH:MM" local time. */
  quietHoursStart: string;
  quietHoursEnd: string;
  maxNudgesPerDay: number;
  urgencyThreshold: number;
  settingsPermission: AssistantSettingsPermission;
}

export interface AssistantConfigSnapshot {
  config: AssistantConfig;
  hotkeyActive: boolean;
}

export interface AppSettings {
  lastProviderId?: string;
  lastModel?: string;
  hiddenModelsByProvider?: HiddenModelsByProvider;
  exaEnabled?: boolean;
  /** Versioned Web Search routing/preferences; credentials stay main-owned. */
  webSearch?: WebSearchSettingsV2;
  voiceProvider?: VoiceProvider;
  voiceModel?: string;
  geminiUsageScope?: GeminiUsageScope;
  localVoiceModel?: string;
  shortcutEnabled?: boolean;
  shortcutAccelerator?: string;
  dictationEnabled?: boolean;
  dictationAccelerator?: string;
  dictationHoldToTalk?: boolean;
  dictationSilenceStop?: boolean;
  dictationCleanup?: boolean;
  dictationSounds?: boolean;
  keybindings?: KeybindingOverridesV1;
  chatTitleProviderId?: ChatTitleProviderId;
  appearance?: AppearanceConfig;
  googleThinkingByModel?: Record<string, GoogleThinkingLevel>;
  codexThinkingByModel?: Record<string, CodexThinkingLevel>;
  anthropicThinkingByModel?: Record<string, AnthropicThinkingLevel>;
  providerThinkingByModel?: Record<string, Record<string, GenerationThinkingLevel>>;
  showLocalModelReasoning?: boolean;
  computerUseEnabled?: boolean;
  scheduledTasksEnabled?: boolean;
  scheduledDefaultMode?: ScheduledTaskMode;
  scheduledDefaultPermission?: ScheduledTaskPermission;
  scheduledDefaultMcpEnabled?: boolean;
  scheduledDefaultNotify?: boolean;
  scheduledDefaultTimezone?: string;
  assistant?: AssistantConfig;
  profileName?: string;
  onboarding?: import("../shared/onboarding.js").OnboardingState;
  telegramEnabled?: boolean;
  telegramAllowedUserId?: number;
  telegramProviderId?: string;
  telegramModel?: string;
  telegramThinkingLevel?: GenerationThinkingLevel;
  telegramDraftPreviews?: boolean;
  telegramActivity?: "quiet" | "thinking" | "tools" | "verbose";
  telegramRendering?: "rich" | "html";
  telegramVoiceMode?: "hidden" | "mirror" | "always";
  telegramWorkspaceId?: string;
  telegramProfiles?: Record<string, TelegramProfileSettings>;
  telegramActiveProfile?: string;
  telegramThreadedMode?: boolean;
}

export interface TelegramProfileSettings {
  enabled?: boolean;
  allowedUserId?: number;
  providerId?: string;
  model?: string;
  thinkingLevel?: GenerationThinkingLevel;
  draftPreviews?: boolean;
  activity?: "quiet" | "thinking" | "tools" | "verbose";
  rendering?: "rich" | "html";
  voiceMode?: "hidden" | "mirror" | "always";
  workspaceId?: string;
  threadedMode?: boolean;
}

export type ComputerUseStatusState =
  | "disabled"
  | "ready"
  | "permission_required"
  | "production_build_required"
  | "unsupported"
  | "unavailable"
  | "incompatible"
  | "error";

export interface ComputerUseStatus {
  enabled: boolean;
  beta: true;
  state: ComputerUseStatusState;
  detail: string;
  ready: boolean;
  available: boolean;
  retryable: boolean;
  canRequestPermissions: boolean;
  driverVersion?: string;
  permissions: {
    accessibility: boolean | null;
    screenRecording: boolean | null;
  };
}

export interface Profile {
  name: string;
}

export type UsageDateRange = "7d" | "30d" | "90d" | "1y" | "all";

export interface UsageTokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface UsageDaySummary {
  date: string;
  requests: number;
  reportedTokenRequests: number;
  unmeteredRequests: number;
  tokens: UsageTokenBreakdown;
  hostedCostUsd: number;
}

export interface UsageModelSummary {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  local: boolean;
  requests: number;
  reportedTokenRequests: number;
  unmeteredRequests: number;
  tokens: UsageTokenBreakdown;
  hostedCostUsd: number;
}

export interface UsageSummary {
  range: UsageDateRange;
  startDate: string;
  endDate: string;
  totals: {
    requests: number;
    completedRequests: number;
    failedRequests: number;
    cancelledRequests: number;
    reportedTokenRequests: number;
    unmeteredRequests: number;
    localRequests: number;
    costedRequests: number;
    unpricedHostedRequests: number;
    hostedCostUsd: number;
    activeDays: number;
    currentStreak: number;
    longestStreak: number;
    tokens: UsageTokenBreakdown;
  };
  days: UsageDaySummary[];
  models: UsageModelSummary[];
}

/** On-device Parakeet model in the download catalog. */
export interface LocalVoiceModel {
  id: string;
  name: string;
  description: string;
  sizeLabel: string;
  quant: string;
  languagesLabel: string;
  accuracy: number; // 0..1
  speed: number; // 0..1
  recommended: boolean;
  installed: boolean;
}

/** State of the bundled on-device (sherpa-onnx) engine. */
export interface EngineStatus {
  ready: boolean;
  error: string | null;
}

export interface McpStatus {
  connected: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
  /** For OAuth servers: whether valid tokens are stored. */
  authorized?: boolean;
}

export interface ChatStartParams {
  chatId: string;
  workspaceId?: string;
  providerId: string;
  model: string;
  /** Renderers may only request the attended Aiden mode. */
  mode?: "assistant";
  thinkingLevel?: GenerationThinkingLevel;
  /** Host-owned /visualize instruction for this turn. */
  visualize?: boolean;
}

export interface ApprovalRequest {
  streamId: string;
  approvalId: string;
  toolName: string;
  summary: string;
}

export type ApprovalDecision = "allow" | "deny";
