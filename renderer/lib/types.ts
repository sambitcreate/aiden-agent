// Renderer-side mirror of the backend data shapes (types only; no runtime import
// across the process boundary).

import type { AppearanceConfig } from "../shared/appearance";

export type ProviderKind = "openai" | "anthropic";

export type ProviderModelType = "llm" | "embedding";

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

export interface Provider {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  models: string[];
  modelMetadata?: Record<string, ProviderModelMetadata>;
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

export type ModelMetadataSource = "local" | "artificial-analysis" | "models-dev" | "fallback";

export interface ModelInfo {
  id: string;
  name?: string;
  vision?: boolean;
  toolCall?: boolean;
  reasoning?: boolean;
  openWeights?: boolean;
  modelType?: ProviderModelType;
  parameterCount?: string;
  format?: string;
  contextLength?: number;
  outputLimit?: number;
  inputModalities?: string[];
  knowledge?: string;
  releaseDate?: string;
  ranking?: ModelRanking;
  metadataSource: ModelMetadataSource;
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
  appearance?: AppearanceConfig;
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
