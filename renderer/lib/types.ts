// Renderer-side mirror of the backend data shapes (types only; no runtime import
// across the process boundary).

export type ProviderKind = "openai" | "anthropic";

export interface Provider {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel?: string;
  needsKey: boolean;
  isPreset?: boolean;
  hasKey: boolean;
}

export type WorkspacePermission = "full" | "ask" | "none";

export interface ManagedWorktree {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
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

export interface ModelInfo {
  id: string;
  name?: string;
  vision: boolean;
  toolCall: boolean;
  reasoning: boolean;
  openWeights: boolean;
  contextLength?: number;
  outputLimit?: number;
  inputModalities?: string[];
  knowledge?: string;
  releaseDate?: string;
  matched: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  model?: string;
  attachments?: Attachment[];
}

export interface ChatMeta {
  id: string;
  title: string;
  workspaceId?: string;
  providerId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Chat extends ChatMeta {
  messages: ChatMessage[];
}

export interface ChatMetadataUpdated {
  chatId: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
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
  enabled: boolean;
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

export interface AppSettings {
  lastProviderId?: string;
  lastModel?: string;
  exaEnabled?: boolean;
  voiceProvider?: VoiceProvider;
  voiceModel?: string;
  localVoiceModel?: string;
  shortcutEnabled?: boolean;
  shortcutAccelerator?: string;
  dictationEnabled?: boolean;
  dictationAccelerator?: string;
  chatTitleProviderId?: ChatTitleProviderId;
  profileName?: string;
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
  messages: Array<{ role: ChatRole; content: string; attachments?: Attachment[] }>;
}

export interface ApprovalRequest {
  streamId: string;
  approvalId: string;
  toolName: string;
  summary: string;
}

export type ApprovalDecision = "allow" | "deny";
