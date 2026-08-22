// Thin, typed wrappers over Aiden Agent's Electron IPC bridge plus the chat streaming helper.

import type {
  AppSettings,
  AssistantConfig,
  AssistantConfigSnapshot,
  ArtificialAnalysisActionResult,
  ArtificialAnalysisStatus,
  ApprovalDecision,
  Attachment,
  Chat,
  ChatMeta,
  ChatMessage,
  ChatReadResponse,
  ChatTitleRenameResult,
  ChatStartParams,
  ComputerUseStatus,
  EngineStatus,
  ExternalEditor,
  GitBranches,
  GitCommitInput,
  GitCommitResult,
  GitComparison,
  GitComparisonDiffInput,
  GitDiffInput,
  GitFileDiff,
  GitInfo,
  GitPushCapability,
  GitPushInput,
  GitPushResult,
  GitReview,
  GitWorktree,
  LocalVoiceModel,
  McpServer,
  McpPresetState,
  McpStatus,
  ModelInfo,
  FoundationModelsConnectionStatus,
  Profile,
  Provider,
  ProviderCatalogRefreshResult,
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
} from "./types";
import type { OnboardingOutcome, OnboardingSnapshot } from "../shared/onboarding";
import type { SkillInvocationV1 } from "../shared/slash-commands";
import type { AnthropicThinkingLevel } from "../shared/anthropic-thinking";
import type { GoogleThinkingLevel } from "../shared/google-thinking";
import type { CodexThinkingLevel } from "../shared/codex-thinking";
import type {
  ChatTimelineNotification,
  GenerationTimeline,
} from "../shared/generation-timeline";
import type { ToolApprovalDetails } from "../shared/assistant";
import {
  parseSubagentHistoryDetailV1,
  parseSubagentRunSnapshot,
  type SubagentHistoryDetailV1,
  type SubagentRunSnapshot,
} from "../shared/subagent-runs";
import {
  parseSubagentManagementResultV2,
  type SubagentManagementRequestV2,
  type SubagentManagementResultV2,
} from "../shared/subagent-management-v2";
import type {
  KeybindingMutation,
  KeybindingSnapshot,
} from "../shared/keybindings";
import {
  parseAppUpdateSnapshot,
  type AppUpdateCheckResult,
  type AppUpdateRestartResult,
  type AppUpdateSnapshot,
} from "../shared/app-update";
import {
  fallbackDetachedLifecycleStream,
  parseChatReadResponse,
  rememberChatReadReconciliation,
  rememberDetachedLifecycleStream,
} from "./chat-terminal-sync";
import type { AppCapabilities } from "./app-capabilities";
import type {
  AppearanceConfig,
  AppearancePreviewSnapshot,
} from "../shared/appearance";
import {
  parseSkillCatalog,
  type SkillCatalogEntry,
} from "../shared/slash-commands";
import { rememberAppendReconciliationFailure } from "./append-reconciliation";
import type {
  AidenRemoteConnectionMode,
  AidenRemotePairingBootstrapView,
  AidenRemoteSettingsSnapshot,
} from "../shared/aiden-remote";

function bridge() {
  return window.aidenAPI.ipc;
}

export interface AppInfo {
  name: string;
  version: string;
  environment: string;
  capabilities: AppCapabilities;
}

export function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return bridge().invoke(channel, ...args) as Promise<T>;
}

export function onNotification<T>(
  method: string,
  handler: (payload: T) => void,
): () => void {
  return bridge().onNotification(method, handler as (params: unknown) => void);
}

export const appApi = {
  getInfo: () => invoke<AppInfo>("app:getInfo"),
  resetOnboarding: () => invoke<boolean>("app:resetOnboarding"),
  getOnboardingState: (legacyComplete: boolean) =>
    invoke<OnboardingSnapshot>("app:getOnboardingState", legacyComplete),
  setOnboardingOutcome: (
    outcome: Exclude<OnboardingOutcome, "deferred">,
    selectedProviderId?: string,
  ) => invoke<OnboardingSnapshot>("app:setOnboardingOutcome", outcome, selectedProviderId),
  setOnboardingProgress: (step: "profile" | "provider", selectedProviderId?: string) =>
    invoke<OnboardingSnapshot>("app:setOnboardingProgress", step, selectedProviderId),
  rendererReady: () => invoke<boolean>("app:renderer-ready"),
  setCloseGuard: (guard: {
    dirty: boolean;
    gitBusy: boolean;
    path?: string;
    saving: boolean;
  }) => invoke<boolean>("app:setCloseGuard", guard),
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
    invoke<{ hasKey: boolean; provider: Provider | null }>(
      "providers:setKey",
      id,
      key,
    ),
  refresh: (providerId?: string) =>
    invoke<ProviderCatalogRefreshResult>("providers:refresh", providerId),
  refreshIfStale: () =>
    invoke<ProviderCatalogRefreshResult>("providers:refreshIfStale"),
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
  authStart: (request: {
    flowId: string;
    providerId: string;
    authType?: "api_key" | "oauth";
  }) => invoke<{ started: true }>("providers:auth:start", request),
  authRespond: (request: {
    flowId: string;
    providerId: string;
    promptId: string;
    value: string;
  }) => invoke<{ accepted: true }>("providers:auth:respond", request),
  authCancel: (request: { flowId: string; providerId: string }) =>
    invoke<{ cancelled: true } | { cancelled: false; reason: "finishing" }>(
      "providers:auth:cancel",
      request,
    ),
  logout: (providerId: string) =>
    invoke<unknown>("providers:logout", providerId),
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

export const settingsApi = {
  get: () => invoke<AppSettings>("settings:get"),
  getAppearance: () => invoke<AppearanceConfig>("settings:getAppearance"),
  getAppearanceState: () =>
    invoke<AppearancePreviewSnapshot>("settings:getAppearanceState"),
  previewAppearance: (appearance: AppearanceConfig) =>
    invoke<AppearanceConfig>("settings:previewAppearance", appearance),
  set: (patch: Partial<AppSettings>) =>
    invoke<AppSettings>("settings:set", patch),
  setGoogleThinking: (modelId: string, level: GoogleThinkingLevel) =>
    invoke<AppSettings>("settings:setGoogleThinking", modelId, level),
  setCodexThinking: (modelId: string, level: CodexThinkingLevel) =>
    invoke<AppSettings>("settings:setCodexThinking", modelId, level),
  setAnthropicThinking: (modelId: string, level: AnthropicThinkingLevel) =>
    invoke<AppSettings>("settings:setAnthropicThinking", modelId, level),
  setProviderThinking: (
    providerId: string,
    modelId: string,
    level: import("../shared/generation-thinking").GenerationThinkingLevel,
  ) => invoke<AppSettings>("settings:setProviderThinking", providerId, modelId, level),
  setModelVisibility: (providerId: string, modelId: string, hidden: boolean) =>
    invoke<AppSettings>("settings:setModelVisibility", providerId, modelId, hidden),
  showAllProviderModels: (providerId: string) =>
    invoke<AppSettings>("settings:showAllProviderModels", providerId),
};

export const assistantApi = {
  config: () => invoke<AssistantConfigSnapshot>("assistant:get-config"),
  setConfig: (patch: Partial<AssistantConfig>) =>
    invoke<AssistantConfigSnapshot>("assistant:set-config", patch),
};

export const artificialAnalysisApi = {
  status: () => invoke<ArtificialAnalysisStatus>("artificialAnalysis:status"),
  connect: (apiKey: string) =>
    invoke<ArtificialAnalysisActionResult>(
      "artificialAnalysis:connect",
      apiKey,
    ),
  refresh: () =>
    invoke<ArtificialAnalysisActionResult>("artificialAnalysis:refresh"),
  disconnect: () =>
    invoke<ArtificialAnalysisActionResult>("artificialAnalysis:disconnect"),
};

export const computerUseApi = {
  status: (force = false) =>
    invoke<ComputerUseStatus>("computerUse:status", force),
  setEnabled: (enabled: boolean) =>
    invoke<ComputerUseStatus>("computerUse:setEnabled", enabled),
  requestPermissions: () =>
    invoke<ComputerUseStatus>("computerUse:requestPermissions"),
};

export const titleProvidersApi = {
  status: () =>
    invoke<FoundationModelsConnectionStatus | null>("titleProviders:status"),
  refresh: () =>
    invoke<FoundationModelsConnectionStatus | null>("titleProviders:refresh"),
};

export const usageApi = {
  summary: (range: UsageDateRange = "1y") =>
    invoke<UsageSummary>("usage:summary", range),
};

export const scheduleApi = {
  list: () => invoke<ScheduledTask[]>("schedule:list"),
  save: (task: ScheduledTaskInput) =>
    invoke<ScheduledTask>("schedule:save", task),
  remove: (id: string) => invoke<void>("schedule:remove", id),
  pause: (id: string) => invoke<ScheduledTask>("schedule:pause", id),
  resume: (id: string) => invoke<ScheduledTask>("schedule:resume", id),
  runNow: (id: string) => invoke<ScheduledRun>("schedule:runNow", id),
  runs: (id: string) => invoke<ScheduledRun[]>("schedule:runs", id),
  preview: (cron: string, timezone: string, count = 3) =>
    invoke<number[]>("schedule:preview", cron, timezone, count),
  scripts: (workspaceId?: string) =>
    invoke<string[]>("schedule:scripts", workspaceId),
  settings: (patch?: Partial<ScheduledTaskSettings>) =>
    invoke<ScheduledTaskSettings>("schedule:settings", patch),
};

export const profileApi = {
  get: () => invoke<Profile>("profile:get"),
  setName: (name: string) => invoke<Profile>("profile:setName", name),
  shareImage: (dataUrl: string) => invoke<void>("profile:shareImage", dataUrl),
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
  save: (server: McpServer) => invoke<McpServer>("mcp:save", server),
  remove: (id: string) => invoke<void>("mcp:remove", id),
  status: (server: McpServer) => invoke<McpStatus>("mcp:status", server),
  /** Browser OAuth sign-in for a remote server. Resolves once tokens are stored. */
  authorize: (server: McpServer) =>
    invoke<{ authorized: boolean }>("mcp:authorize", server),
  oauthStatus: (id: string) =>
    invoke<{ authorized: boolean }>("mcp:oauthStatus", id),
  /** Drop cached connections so the next message reconnects with current config. */
  reconnect: () => invoke<void>("mcp:reconnect"),
};

// ── Dev log (renderer error forwarding, dev builds only) ─────────────
export const devlogApi = {
  write: (level: "info" | "warn" | "error", message: string) =>
    invoke<void>("devlog:write", level, message),
};

// ── Exa web search ────────────────────────────────────────────────────
export const exaApi = {
  get: () => invoke<{ enabled: boolean; hasKey: boolean }>("exa:get"),
  setKey: (key: string) => invoke<{ hasKey: boolean }>("exa:setKey", key),
  setEnabled: (enabled: boolean) =>
    invoke<AppSettings>("exa:setEnabled", enabled),
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
  recentDiagnostics: Array<{ at: number; level: "info" | "warning" | "error" | "recovery"; message: string }>;
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
  selectProfile: (profile: string) => invoke<{ profile: string }>("telegram:selectProfile", profile),
  createProfile: (profile: string) => invoke<{ profile: string }>("telegram:createProfile", profile),
  deleteProfile: (profile: string) => invoke<{ deleted: boolean }>("telegram:deleteProfile", profile),
  onModelSelectionChanged: (handler: (selection: { providerId: string; model: string }) => void) =>
    onNotification("telegram:model-selection-changed", handler),
};

export const aidenRemoteApi = {
  get: () => invoke<AidenRemoteSettingsSnapshot>("remote:get"),
  setEnabled: (enabled: boolean) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:setEnabled", enabled),
  setConnectionMode: (mode: AidenRemoteConnectionMode) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:setConnectionMode", mode),
  setDisplayName: (displayName: string) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:setDisplayName", displayName),
  connectTailscale: () =>
    invoke<AidenRemoteSettingsSnapshot>("remote:tailscaleConnect"),
  disconnectTailscale: () =>
    invoke<AidenRemoteSettingsSnapshot>("remote:tailscaleDisconnect"),
  reconcileTailscale: () =>
    invoke<AidenRemoteSettingsSnapshot>("remote:tailscaleReconcile"),
  reviewTailscaleTakeover: () =>
    invoke<import("../shared/aiden-remote").AidenRemoteTailscaleTakeoverReviewView>("remote:tailscaleReviewTakeover"),
  takeOverTailscale: (token: string) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:tailscaleTakeOver", token),
  beginPairing: (transport: "lan" | "tailscale") =>
    invoke<AidenRemotePairingBootstrapView>("remote:beginPairing", transport),
  closePairing: (pairingSessionId: string) =>
    invoke<{ closed: boolean }>("remote:closePairing", pairingSessionId),
  revokeDevice: (deviceId: string) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:revokeDevice", deviceId),
  addApprovedRoot: () =>
    invoke<AidenRemoteSettingsSnapshot>("remote:addApprovedRoot"),
  removeApprovedRoot: (rootId: string) =>
    invoke<AidenRemoteSettingsSnapshot>("remote:removeApprovedRoot", rootId),
  onChanged: (handler: () => void) =>
    onNotification("remote:changed", handler),
};

// ── Voice + shortcut ──────────────────────────────────────────────────
export const voiceApi = {
  transcribe: (audioBase64: string, mimeType: string) =>
    invoke<string>("voice:transcribe", audioBase64, mimeType),
  /** On-device transcription: base64 raw 16 kHz mono Float32 PCM + downloaded model id. */
  transcribeLocal: (pcmBase64: string, modelId: string) =>
    invoke<string>("voice:transcribeLocal", pcmBase64, modelId),
};

/** On-device (sherpa-onnx / Parakeet) engine + model management. */
export const localVoiceApi = {
  status: () => invoke<EngineStatus>("localVoice:status"),
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
  phase: "download" | "extract";
}

export const shortcutApi = {
  get: () => invoke<KeybindingSnapshot>("shortcut:get"),
  setRecording: (recording: boolean) =>
    invoke<KeybindingSnapshot>("shortcut:set-recording", recording),
  set: (mutation: KeybindingMutation) =>
    invoke<KeybindingSnapshot>("shortcut:set", mutation),
  onChanged: (handler: (snapshot: KeybindingSnapshot) => void) =>
    onNotification("shortcut:changed", handler),
};

// ── Global dictation (pill + auto-paste) ──────────────────────────────
export const dictationApi = {
  /** Pill reports the finished transcript to the main-process coordinator. */
  reportResult: (text: string) => invoke<void>("dictation:result", text),
  /** Pill reports a capture/transcription failure. */
  reportError: (message: string) => invoke<void>("dictation:error", message),
  /** Pill cancel button: discard the in-flight recording/transcription. */
  cancel: () => invoke<void>("dictation:cancel"),
  /** Pill renderer is mounted and subscribed to dictation state broadcasts. */
  ready: () => invoke<void>("dictation:ready"),
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
  pickAndRead: (
    remainingSlots: number,
    includeImages: boolean,
    remainingInlineBytes: number,
  ) =>
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
    window.aidenAPI.attachments.readClipboardImages(
      images,
      remainingSlots,
      remainingInlineBytes,
    ),
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
  createFromFolder: () =>
    invoke<Workspace | null>("workspaces:createFromFolder"),
  createScratch: () => invoke<Workspace>("workspaces:createScratch"),
  update: (
    id: string,
    patch: { name?: string; permission?: WorkspacePermission },
  ) => invoke<Workspace>("workspaces:update", id, patch),
  remove: (id: string) => invoke<void>("workspaces:remove", id),
  gitInfo: (workspaceId: string) =>
    invoke<GitInfo>("workspaces:gitInfo", workspaceId),
  openFolder: (workspaceId: string) =>
    invoke<void>("workspaces:openFolder", workspaceId),
  externalEditors: (forceRefresh = false) =>
    invoke<ExternalEditor[]>("workspaces:externalEditors", forceRefresh),
  openInEditor: (workspaceId: string, editorId: string) =>
    invoke<void>("workspaces:openInEditor", workspaceId, editorId),
  files: (workspaceId: string) =>
    invoke<WorkspaceFileIndex>("workspaces:files", workspaceId),
  readFile: (workspaceId: string, path: string) =>
    invoke<WorkspaceFileDocument>("workspaces:readFile", workspaceId, path),
  writeFile: (
    workspaceId: string,
    path: string,
    content: string,
    expectedVersion: string,
  ) =>
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

export const terminalApi = {
  create: (workspaceId: string) =>
    invoke<TerminalSession>("terminal:create", workspaceId),
  snapshot: (sessionId: string) =>
    invoke<TerminalSnapshot>("terminal:snapshot", sessionId),
  write: (sessionId: string, data: string) =>
    invoke<void>("terminal:write", sessionId, data),
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
  branches: (workspaceId: string) =>
    invoke<GitBranches>("git:branches", workspaceId),
  checkout: (workspaceId: string, name: string) =>
    invoke<void>("git:checkout", workspaceId, name),
  createBranch: (workspaceId: string, name: string) =>
    invoke<void>("git:createBranch", workspaceId, name),
  worktrees: (workspaceId: string) =>
    invoke<GitWorktree[]>("git:worktrees", workspaceId),
  createWorktree: (workspaceId: string, name: string) =>
    invoke<Workspace>("git:createWorktree", workspaceId, name),
  deleteManagedWorktree: (workspaceId: string) =>
    invoke<{ branchDeleted: boolean }>(
      "git:deleteManagedWorktree",
      workspaceId,
    ),
};

// ── Chats ─────────────────────────────────────────────────────────────
async function invokeChatMutation<T>(
  channel: string,
  ...args: unknown[]
): Promise<T> {
  try {
    return await invoke<T>(channel, ...args);
  } catch (error) {
    rememberAppendReconciliationFailure(error);
    throw error;
  }
}

export const chatsApi = {
  activitySnapshot: () => invoke<unknown>("chats:activitySnapshot"),
  list: (workspaceId?: string) => invoke<ChatMeta[]>("chats:list", workspaceId),
  get: async (id: string) => {
    const response = parseChatReadResponse(
      await invoke<ChatReadResponse>("chats:get", id),
    );
    if (!response) throw new Error("The chat read response was invalid.");
    if (response.reconciliation) {
      rememberChatReadReconciliation(response.reconciliation);
    }
    return response.chat;
  },
  waitUntilIdle: (id: string) => invoke<boolean>("chats:waitUntilIdle", id),
  create: (input: {
    title?: string;
    workspaceId: string;
    providerId?: string;
    model?: string;
  }) => invokeChatMutation<Chat>("chats:create", input),
  createAssistant: (input: { providerId?: string; model?: string }) =>
    invokeChatMutation<Chat>("chats:createAssistant", input),
  rename: (id: string, title: string) =>
    invoke<void>("chats:rename", id, title),
  renameWithFoundationModels: (id: string) =>
    invoke<ChatTitleRenameResult>("chats:renameWithFoundationModels", id),
  copyVisibleHistory: (chatId: string, throughMessageId?: string) =>
    invokeChatMutation<Chat>("chats:copyVisibleHistory", {
      chatId,
      ...(throughMessageId ? { throughMessageId } : {}),
    }),
  export: (chatId: string) =>
    invoke<{ status: "saved" | "cancelled" }>("chats:export", { chatId }),
  moveEmptyToWorkspace: (id: string, workspaceId: string) =>
    invoke<Chat>("chats:moveEmptyToWorkspace", id, workspaceId),
  setComputerUse: (id: string, enabled: boolean) =>
    invoke<Chat>("chats:setComputerUse", id, enabled),
  remove: (id: string) => invoke<void>("chats:remove", id),
  abandonTurn: (id: string, turnId: string) =>
    invoke<boolean>("chats:abandonTurn", id, turnId),
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
  approve: (approvalId: string, decision: ApprovalDecision) =>
    invoke<void>("chat:approve", approvalId, decision),
};

export const subagentsApi = {
  get: async (
    chatId: string,
    runId: string,
  ): Promise<SubagentHistoryDetailV1 | null> =>
    parseSubagentHistoryDetailV1(
      await invoke<unknown>("subagents:get", chatId, runId),
    ) ?? null,
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
interface ChatDelta {
  streamId: string;
  delta: string;
  /** Discard deltas from a failed overflow attempt before its retry starts. */
  reset?: boolean;
}
interface ChatReasoningDelta {
  streamId: string;
  delta: string;
}
export type ChatStatusPhase = "model_loading" | "model_ready";
interface ChatStatus {
  streamId: string;
  phase: ChatStatusPhase;
}
interface ChatDone {
  streamId: string;
  content: string;
  reasoning?: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
}
interface ChatError {
  streamId: string;
  message: string;
  content?: string;
  reasoning?: string;
  timeline?: GenerationTimeline;
  chat?: Chat;
}

export type ToolPhase = "call" | "result" | "error" | "blocked";
interface ChatTool {
  streamId: string;
  phase: ToolPhase;
  toolName: string;
}

export interface ApprovalPrompt {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  details?: ToolApprovalDetails;
}
interface ChatApproval extends ApprovalPrompt {
  streamId: string;
}
interface ChatSubagents {
  streamId: string;
  snapshot: unknown;
}

export interface GenerationHandle {
  streamId: string;
  started: Promise<GenerationStartResult>;
  cancel: (origin: "lifecycle" | "user_stop") => void;
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
  onSubagents?: (snapshot: SubagentRunSnapshot) => void;
  onTool?: (phase: ToolPhase, toolName: string) => void;
  onApproval?: (prompt: ApprovalPrompt) => void;
  onStatus?: (phase: ChatStatusPhase) => void;
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
  const unsubs: Array<() => void> = [];
  const dispose = () => {
    for (const u of unsubs) u();
    unsubs.length = 0;
  };

  unsubs.push(
    onNotification<ChatDelta>("chat:delta", (p) => {
      if (p.streamId !== streamId) return;
      if (p.reset) callbacks.onReset?.();
      else callbacks.onDelta(p.delta);
    }),
  );
  unsubs.push(
    onNotification<ChatReasoningDelta>("chat:reasoning-delta", (p) => {
      if (p.streamId === streamId) callbacks.onReasoningDelta?.(p.delta);
    }),
  );
  unsubs.push(
    onNotification<ChatStatus>("chat:status", (p) => {
      if (p.streamId === streamId) callbacks.onStatus?.(p.phase);
    }),
  );
  unsubs.push(
    onNotification<ChatDone>("chat:done", (p) => {
      if (p.streamId !== streamId) return;
      void Promise.resolve(
        callbacks.onDone(p.content, p.timeline, p.chat, p.reasoning),
      )
        .catch((error: unknown) =>
          callbacks.onError(
            error instanceof Error ? error.message : String(error),
          ),
        )
        .finally(dispose);
    }),
  );
  unsubs.push(
    onNotification<ChatError>("chat:error", (p) => {
      if (p.streamId !== streamId) return;
      callbacks.onError(p.message, p.content, p.timeline, p.chat, p.reasoning);
      dispose();
    }),
  );
  unsubs.push(
    onNotification<ChatTimelineNotification>("chat:timeline", (p) => {
      if (p.streamId === streamId) callbacks.onTimeline?.(p.timeline);
    }),
  );
  if (callbacks.onSubagents) {
    unsubs.push(
      onNotification<ChatSubagents>("chat:subagents", (p) => {
        if (p.streamId !== streamId) return;
        const snapshot = parseSubagentRunSnapshot(p.snapshot);
        if (snapshot?.generationId === streamId)
          callbacks.onSubagents?.(snapshot);
      }),
    );
  }
  unsubs.push(
    onNotification<ChatTool>("chat:tool", (p) => {
      if (p.streamId === streamId) callbacks.onTool?.(p.phase, p.toolName);
    }),
  );
  unsubs.push(
    onNotification<ChatApproval>("chat:approval", (p) => {
      if (p.streamId === streamId)
        callbacks.onApproval?.({
          approvalId: p.approvalId,
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          summary: p.summary,
          details: p.details,
        });
    }),
  );

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
        error: new Error(
          "Generation was rejected before it accepted this message.",
        ),
      };
    },
    (error: unknown) => {
      const resolved =
        error instanceof Error ? error : new Error(String(error));
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
        rememberDetachedLifecycleStream({
          streamId,
          chatId: params.chatId,
          workspaceId: params.workspaceId ?? "default",
        });
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
          callbacks.onError(
            error instanceof Error ? error.message : String(error),
          );
          dispose();
        }
      });
    },
  };
}
