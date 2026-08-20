// Shared backend/renderer data types for the AI chat client.

import type { AppearanceConfig } from "../../renderer/shared/appearance.js";
import type { AnthropicThinkingLevel } from "../../renderer/shared/anthropic-thinking.js";
import type { CodexThinkingLevel } from "../../renderer/shared/codex-thinking.js";
import type { GenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import type { GenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import type { GoogleThinkingLevel } from "../../renderer/shared/google-thinking.js";
import type { KeybindingOverridesV1 } from "../../renderer/shared/keybindings.js";
import type { SubagentMessageReferenceV1 } from "../../renderer/shared/subagent-runs.js";
import type { SkillProvenanceV1 } from "../../renderer/shared/slash-commands.js";
import type { ProviderFailureV1 } from "../../renderer/shared/provider-failure.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProviderArtwork } from "../../renderer/shared/provider-artwork.js";

export type ProviderKind = "openai" | "anthropic";

export type ProviderDeployment = "local" | "hosted";

export type ProviderModelType = "llm" | "embedding";

/** Metadata reported by the configured provider during explicit model discovery. */
export interface ProviderModelMetadata {
  source: "lmstudio" | "ollama" | "provider";
  name?: string;
  type?: ProviderModelType;
  vision?: boolean;
  toolCall?: boolean;
  reasoning?: boolean;
  /** Distinct Aiden thinking choices supported by this native model. */
  thinkingLevels?: GenerationThinkingLevel[];
  /** False when Google's minimum thinking can only be hidden, not disabled. */
  thinkingCanDisable?: boolean;
  contextLength?: number;
  parameterCount?: string;
  format?: string;
}

/** A configured connection to an LLM backend (hosted or local). */
export interface StoredProvider {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Optional normalized artwork for custom providers. Never contains a filesystem path. */
  artwork?: ProviderArtwork;
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Suggested / cached model ids for the picker. */
  models: string[];
  /** Provider-reported metadata captured alongside the last explicit discovery. */
  modelMetadata?: Record<string, ProviderModelMetadata>;
  defaultModel?: string;
  /** Whether this provider requires an API key (local backends often don't). */
  needsKey: boolean;
  /**
   * Where inference runs. When unset, Aiden infers from the base URL (loopback =
   * local). Custom / Tailscale servers can override so loading UX and usage
   * treat them as local even off localhost.
   */
  deployment?: ProviderDeployment;
  /** Legacy marker retained only for persisted custom-connection migration. */
  isPreset?: boolean;
  /**
   * A provider supplied by Pi itself. Its endpoint, models, authentication,
   * and stream transport are Pi-owned rather than renderer-configurable.
   */
  isBuiltin?: boolean;
}

/** Provider as exposed to the renderer — `hasKey` is derived, the key itself never leaves the backend. */
export interface Provider extends StoredProvider {
  hasKey: boolean;
  /** True only when Aiden owns a stored credential it can remove. */
  canLogout?: boolean;
  /** Former custom IDs remapped during a safe provider-identity migration. */
  legacyIds?: string[];
  /** Pi-owned setup options. No credentials or provider environment values cross IPC. */
  authMethods?: Array<{
    type: "api_key" | "oauth";
    label: string;
    canLogin: boolean;
  }>;
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
  /** Stable Git administrative identity; survives worktree moves and branch changes. */
  worktreeGitDir?: string;
  /** Aiden marker persisted inside the original Git administrative directory. */
  ownershipToken?: string;
  /** Filesystem identity of the original checkout root, used to reject path replacements. */
  worktreeDevice?: number;
  worktreeInode?: number;
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
  /** Deliberately exposed provider reasoning retained on an assistant message. */
  reasoning?: string;
  /** Canonical Pi assistant protocol payload; raw errors and diagnostics are excluded. */
  pi?: Omit<AssistantMessage, "diagnostics" | "errorMessage">;
  /** Closed, renderer-safe terminal provider outcome. */
  providerFailure?: ProviderFailureV1;
  /** Files attached to a user message. */
  attachments?: Attachment[];
  /** Safe display-only provenance for an explicitly invoked skill. */
  skill?: SkillProvenanceV1;
  /** Renderer-safe tool milestones associated with this assistant response. */
  timeline?: GenerationTimeline;
  /** Bounded references to separately persisted renderer-safe child run records. */
  subagents?: SubagentMessageReferenceV1;
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

export type ScheduledTaskMode = "llm" | "script";
export type ScheduledTaskPermission = "read-only" | "full";
export type ScheduledTaskExecutionProfile = "assistant";
export type ScheduledRunResult = "success" | "error" | "silent" | "blocked";

export interface ScheduledMcpServerBinding {
  id: string;
  fingerprint: string;
}

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
  /** Main-owned provider-connection fingerprint. Renderer mutations cannot set this field. */
  providerFingerprint?: string;
  prompt?: string;
  script?: string;
  permission: ScheduledTaskPermission;
  /**
   * Exact configured MCP server identities approved for unattended use.
   * Undefined is retained only for legacy non-Assistant Full tasks that
   * historically inherited every enabled MCP server.
   */
  mcpServerIds?: string[];
  /** Main-owned immutable connection fingerprints for Assistant-approved MCP scope. */
  mcpServerBindings?: ScheduledMcpServerBinding[];
  /** Main-owned runtime profile. Renderer task mutations cannot set this field. */
  executionProfile?: ScheduledTaskExecutionProfile;
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
  /** Main-owned provider-connection fingerprint. Renderer mutations cannot set this field. */
  providerFingerprint?: string;
  prompt?: string;
  script?: string;
  permission?: ScheduledTaskPermission;
  /** Exact configured MCP servers this task may invoke unattended. */
  mcpServerIds?: string[];
  /** Main-owned immutable connection fingerprints. Renderer mutations cannot set this field. */
  mcpServerBindings?: ScheduledMcpServerBinding[];
  /** Main-owned runtime profile. Renderer task mutations cannot set this field. */
  executionProfile?: ScheduledTaskExecutionProfile;
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
  /** Set when this record came from the built-in preset catalog (see mcp-presets.ts). */
  presetId?: string;
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

/** An Agent Skill discovered on disk from a skill folder (read-only). */
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

/** How much the Aiden assistant may do with app settings through its tools. */
export type AssistantSettingsPermission = "full" | "ask" | "none";

/** Aiden assistant window, hotkey, and proactive-watching settings. */
export interface AssistantConfig {
  /** Proactivity master switch. Off by default — nudging is opt-in. */
  enabled: boolean;
  hotkeyEnabled: boolean;
  hotkeyAccelerator: string;
  /**
   * Required pin for proactivity. An unattended loop must never inherit
   * whichever model the user happens to have selected, so the ticker refuses to
   * run until both of these are set. Interactive Aiden chat still follows
   * lastProviderId/lastModel.
   */
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

/** Authoritative Assistant settings plus the current global-hotkey runtime state. */
export interface AssistantConfigSnapshot {
  config: AssistantConfig;
  hotkeyActive: boolean;
}

/** Persisted lightweight app settings. */
export interface AppSettings {
  lastProviderId?: string;
  lastModel?: string;
  /** Presentation-only chat models hidden from Mac and paired mobile selection UI. */
  hiddenModelsByProvider?: Record<string, string[]>;
  exaEnabled?: boolean;
  voiceProvider?: VoiceProvider;
  voiceModel?: string;
  /** Selected on-device Whisper model id (see local-models catalog). */
  localVoiceModel?: string;
  shortcutEnabled?: boolean;
  shortcutAccelerator?: string;
  /** Global hotkey that toggles dictation into the focused app (pill + auto-paste). */
  dictationEnabled?: boolean;
  dictationAccelerator?: string;
  /** Versioned command overrides. Legacy global fields remain migration fallbacks. */
  keybindings?: KeybindingOverridesV1;
  /** Background chat-title generation policy. Defaults to automatic. */
  chatTitleProviderId?: ChatTitleProviderId;
  /** Paired light/dark palettes and global appearance preferences. */
  appearance?: AppearanceConfig;
  /** Last explicit native-Google thinking level, keyed by exact model id. */
  googleThinkingByModel?: Record<string, GoogleThinkingLevel>;
  /** Last explicit ChatGPT/Codex reasoning effort, keyed by exact model id. */
  codexThinkingByModel?: Record<string, CodexThinkingLevel>;
  /** Last explicit Anthropic/Claude thinking effort, keyed by exact model id. */
  anthropicThinkingByModel?: Record<string, AnthropicThinkingLevel>;
  /** Presentation-only Pi thinking visibility for models running on a local deployment. */
  showLocalModelReasoning?: boolean;
  /** Global opt-in for the external cua-driver Computer Use beta. */
  computerUseEnabled?: boolean;
  /** Global scheduler gate. Turning it off pauses jobs without deleting them. */
  scheduledTasksEnabled?: boolean;
  scheduledDefaultMode?: ScheduledTaskMode;
  scheduledDefaultPermission?: ScheduledTaskPermission;
  scheduledDefaultMcpEnabled?: boolean;
  scheduledDefaultNotify?: boolean;
  scheduledDefaultTimezone?: string;
  /** Aiden assistant window, hotkey, and proactivity settings. */
  assistant?: AssistantConfig;
  /** Device-local display name used by the private usage profile. */
  profileName?: string;
  /** Telegram remote-control enable flag; gates long-poll polling. */
  telegramEnabled?: boolean;
  /** Paired Telegram owner chat id; undefined until first /start pairs. */
  telegramAllowedUserId?: number;
  /** Provider for Telegram turns; falls back to lastProviderId when unset. */
  telegramProviderId?: string;
  /** Model for Telegram turns; falls back to provider default when unset. */
  telegramModel?: string;
  /** Explicit reasoning effort for Telegram-originated turns. */
  telegramThinkingLevel?: GenerationThinkingLevel;
  /** Stream bounded answer previews into one edited Telegram message. */
  telegramDraftPreviews?: boolean;
  /** Technical activity projected into Telegram during a turn. */
  telegramActivity?: "quiet" | "thinking" | "tools" | "verbose";
  /** Native Rich Markdown or legacy HTML assistant answer delivery. */
  telegramRendering?: "rich" | "html";
  /** Automatic voice reply policy; explicit telegram_voice actions remain available. */
  telegramVoiceMode?: "hidden" | "mirror" | "always";
  /**
   * Explicit folder workspace authorized for Telegram project automation.
   * Omitted keeps Telegram turns assistant-only.
   */
  telegramWorkspaceId?: string;
  /** Named Telegram bot profiles; the legacy root fields remain profiles.default. */
  telegramProfiles?: Record<string, TelegramProfileSettings>;
  /** Profile currently edited by Settings and used as the default direct-delivery target. */
  telegramActiveProfile?: string;
  /** Provision and route private-chat topics to explicit Aiden workspace targets. */
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

/** Date windows available in the private, device-local usage profile. */
export type UsageDateRange = "7d" | "30d" | "90d" | "1y" | "all";

/** Token counts reported by a model provider. Reasoning is a subset of output. */
export interface UsageTokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Anthropic's one-hour cache writes, already included in cacheWrite. */
  cacheWrite1h?: number;
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
  /**
   * Selects the system prompt and tool set. Absent means the normal workspace
   * chat. The unattended Assistant modes are main-only: parseParams never
   * produces them, so a renderer cannot request background capabilities or the
   * [SILENT] prompt.
   */
  mode?: "assistant" | "assistant-unattended" | "assistant-automation";
  /** Small main-validated enum; provider/model support is enforced at runtime. */
  thinkingLevel?: GenerationThinkingLevel;
  messages: Array<{
    role: ChatRole;
    content: string;
    attachments?: Attachment[];
  }>;
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
export interface ChatReasoningDelta {
  streamId: string;
  delta: string;
}
export interface ChatDone {
  streamId: string;
  content: string;
  reasoning?: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
}
export interface ChatError {
  streamId: string;
  message: string;
  /** Streamed text retained when a provider fails after beginning a response. */
  content?: string;
  /** Deliberately exposed provider reasoning retained alongside a partial response. */
  reasoning?: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
}
export const MAX_CONFIG_ID_LENGTH = 256;
export const MAX_PROVIDER_BASE_URL_LENGTH = 4_096;
export const MAX_PROVIDER_KEY_LENGTH = 1_048_576;
