// Shared backend/renderer data types for the AI chat client.

import type { AppearanceConfig } from "../../renderer/shared/appearance.js";
import type { GenerationTimeline } from "../../renderer/shared/generation-timeline.js";

export type ProviderKind = "openai" | "anthropic";

export type ProviderModelType = "llm" | "embedding";

/** Metadata reported by the configured provider during explicit model discovery. */
export interface ProviderModelMetadata {
  source: "lmstudio" | "ollama" | "provider";
  name?: string;
  type?: ProviderModelType;
  vision?: boolean;
  toolCall?: boolean;
  reasoning?: boolean;
  contextLength?: number;
  parameterCount?: string;
  format?: string;
}

/** A configured connection to an LLM backend (hosted or local). */
export interface StoredProvider {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Suggested / cached model ids for the picker. */
  models: string[];
  /** Provider-reported metadata captured alongside the last explicit discovery. */
  modelMetadata?: Record<string, ProviderModelMetadata>;
  defaultModel?: string;
  /** Whether this provider requires an API key (local backends often don't). */
  needsKey: boolean;
  /** True for the built-in seeded presets (base URL/label locked, still editable). */
  isPreset?: boolean;
}

/** Provider as exposed to the renderer — `hasKey` is derived, the key itself never leaves the backend. */
export interface Provider extends StoredProvider {
  hasKey: boolean;
}

/**
 * How much the Pi agent is allowed to do inside a workspace folder.
 * - "full": file/shell tools run without prompting.
 * - "ask":  read-only tools run; writes and shell commands require approval.
 * - "none": file/shell tools are withheld entirely (chat + web/skills/MCP only).
 */
export type WorkspacePermission = "full" | "ask" | "none";

export interface ManagedWorktree {
  /** Canonical repository root used to create the worktree. */
  repositoryPath: string;
  /** Canonical checkout root; the workspace may point at a nested path inside it. */
  worktreePath: string;
  branch: string;
  /** HEAD the branch pointed to when Aiden created it; used for safe cleanup. */
  createdFromHead: string;
}

/** A named working context: an optional folder + a permission level for its chats. */
export interface Workspace {
  id: string;
  name: string;
  /** Absolute path to the folder Pi operates in (undefined = no folder bound yet). */
  folderPath?: string;
  permission: WorkspacePermission;
  /** Present only for worktrees created and owned by Aiden. */
  managedWorktree?: ManagedWorktree;
  createdAt: number;
  updatedAt: number;
}

/** Result of inspecting a folder for git status. */
export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  /** True when HEAD points directly to a commit rather than a local branch. */
  detached?: boolean;
  /** True when the repository has no first commit yet. */
  unborn?: boolean;
  /** Number of uncommitted (staged + unstaged + untracked) entries. */
  uncommitted?: number;
  upstream?: string;
  ahead?: number;
  behind?: number;
  defaultBranch?: string;
  hasRemote?: boolean;
  /** Ahead/behind compare local tracking refs; Aiden never fetches implicitly. */
  remoteState?: "local-ref";
}

/** Branch list for the composer's branch picker. */
export interface GitBranches {
  isRepo: boolean;
  current?: string;
  branches: string[];
  remoteBranches: string[];
  /** Uncommitted entry count on the current branch. */
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

/** One checkout reported by `git worktree list --porcelain -z`. */
export interface GitWorktree {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  current: boolean;
}

export type ChatRole = "user" | "assistant" | "system";

export type AttachmentKind = "image" | "text";

/** A file attached to a user message. Images carry base64 `data`; text files carry inlined `text`. */
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

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** Model that produced an assistant message. */
  model?: string;
  /** Files attached to a user message. */
  attachments?: Attachment[];
  /** Renderer-safe tool milestones associated with this assistant response. */
  timeline?: GenerationTimeline;
}

export interface ModelRanking {
  /** Fixed-snapshot percentile, where 1 is the most capable model. */
  capabilityPercentile: number;
  /** Fixed-snapshot percentile, where 1 is the slowest response profile. */
  responseTimePercentile: number;
  source: string;
  sourceUrl?: string;
  measuredAt?: string;
}

export type ModelMetadataSource =
  | "local"
  | "provider"
  | "artificial-analysis"
  | "models-dev"
  | "fallback";

/** Normalized model metadata after applying local and bundled-source precedence. */
export interface ModelInfo {
  id: string;
  name?: string;
  /** Accepts image input (vision). */
  vision?: boolean;
  /** Supports tool/function calling. */
  toolCall?: boolean;
  /** Exposes reasoning / thinking. */
  reasoning?: boolean;
  /** Open-weight / open-source model. */
  openWeights?: boolean;
  modelType?: ProviderModelType;
  parameterCount?: string;
  format?: string;
  contextLength?: number;
  outputLimit?: number;
  inputModalities?: string[];
  /** Training knowledge cutoff (e.g. "2025-05"). */
  knowledge?: string;
  releaseDate?: string;
  ranking?: ModelRanking;
  metadataSource: ModelMetadataSource;
  /** True when any trusted metadata source identified the model. */
  matched: boolean;
}

export interface ChatMeta {
  id: string;
  title: string;
  /** Workspace this chat belongs to. */
  workspaceId?: string;
  providerId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Chat extends ChatMeta {
  /** Per-chat opt-in. The global Computer Use beta setting remains authoritative. */
  computerUseEnabled?: boolean;
  messages: ChatMessage[];
}

export type McpTransport = "stdio" | "http" | "sse";

/** A user-configured MCP server connection. */
export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http / sse */
  url?: string;
  headers?: Record<string, string>;
  /** Remote servers only: authenticate with OAuth (browser sign-in) instead of / in addition to headers. */
  oauth?: boolean;
  enabled: boolean;
}

/** An Agent Skill — instructions exposed to the model as a callable tool. */
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
  /** Where it was found. */
  source: "workspace" | "global";
  /** Absolute path to the SKILL.md file. */
  path: string;
}

export type VoiceProvider = "openai" | "gemini" | "local";

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

/** Persisted lightweight app settings. */
export interface AppSettings {
  lastProviderId?: string;
  lastModel?: string;
  exaEnabled?: boolean;
  voiceProvider?: VoiceProvider;
  voiceModel?: string;
  /** Selected on-device Whisper model id (see local-models catalog). */
  localVoiceModel?: string;
  shortcutEnabled?: boolean;
  shortcutAccelerator?: string;
  /** Global hotkey that toggles on-device dictation into the composer. */
  dictationEnabled?: boolean;
  dictationAccelerator?: string;
  /** Background chat-title generation policy. Defaults to automatic. */
  chatTitleProviderId?: ChatTitleProviderId;
  /** Paired light/dark palettes and global appearance preferences. */
  appearance?: AppearanceConfig;
  /** Global opt-in for the external cua-driver Computer Use beta. */
  computerUseEnabled?: boolean;
  /** Device-local display name used by the private usage profile. */
  profileName?: string;
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

/** Date windows available in the private, device-local usage profile. */
export type UsageDateRange = "7d" | "30d" | "90d" | "1y" | "all";

/** Token counts reported by a model provider. Reasoning is a subset of output. */
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

/** Privacy-safe aggregate returned to the renderer. No chat or workspace content is persisted. */
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

/** Params for a streaming generation request. */
export interface ChatStartParams {
  chatId: string;
  workspaceId?: string;
  providerId: string;
  model: string;
  messages: Array<{ role: ChatRole; content: string; attachments?: Attachment[] }>;
}

/** A pending request for the user to approve a mutating tool call ("ask" mode). */
export interface ApprovalRequest {
  streamId: string;
  approvalId: string;
  toolName: string;
  /** Human-readable summary of what Pi wants to do, e.g. "Run: npm test". */
  summary: string;
}

export type ApprovalDecision = "allow" | "deny";

/** Notification payloads pushed from backend during generation. */
export interface ChatDelta {
  streamId: string;
  delta: string;
}
export interface ChatDone {
  streamId: string;
  content: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
}
export interface ChatError {
  streamId: string;
  message: string;
  /** Streamed text retained when a provider fails after beginning a response. */
  content?: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
}
