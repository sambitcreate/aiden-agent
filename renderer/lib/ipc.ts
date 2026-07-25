// Thin, typed wrappers over Aiden Agent's Electron IPC bridge plus the chat streaming helper.

import type {
  AppSettings,
  ArtificialAnalysisActionResult,
  ArtificialAnalysisStatus,
  ApprovalDecision,
  Attachment,
  Chat,
  ChatMeta,
  ChatMessage,
  ChatTitleRenameResult,
  ChatStartParams,
  ComputerUseStatus,
  DiscoveredSkill,
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
import type { AnthropicThinkingLevel } from "../shared/anthropic-thinking";
import type { GoogleThinkingLevel } from "../shared/google-thinking";
import type { CodexThinkingLevel } from "../shared/codex-thinking";
import type {
  ChatTimelineNotification,
  GenerationTimeline,
} from "../shared/generation-timeline";

function bridge() {
  return window.aidenAPI.ipc;
}

export interface AppInfo {
  name: string;
  version: string;
  environment: string;
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
  setCloseGuard: (guard: {
    dirty: boolean;
    gitBusy: boolean;
    path?: string;
    saving: boolean;
  }) => invoke<boolean>("app:setCloseGuard", guard),
  setDockIcon: (preference: "aiden" | "monochrome") =>
    invoke<boolean>("app:setDockIcon", preference),
};

// ── Providers & settings ──────────────────────────────────────────────
export const providersApi = {
  list: () => invoke<Provider[]>("providers:list"),
  save: (provider: Omit<Provider, "hasKey">, keyOverride?: string) =>
    invoke<Provider>("providers:save", provider, keyOverride),
  remove: (id: string) => invoke<void>("providers:remove", id),
  setKey: (id: string, key: string) =>
    invoke<{ hasKey: boolean; provider: Provider | null }>(
      "providers:setKey",
      id,
      key,
    ),
  test: (provider: Omit<Provider, "hasKey">, keyOverride?: string) =>
    invoke<{
      ok: true;
      modelCount: number;
      models: string[];
      modelMetadata: Record<string, ProviderModelMetadata>;
    }>("providers:test", provider, keyOverride),
  listModels: (provider: Omit<Provider, "hasKey">, keyOverride?: string) =>
    invoke<string[]>("providers:listModels", provider, keyOverride),
  authStatus: (providerId: "openai-codex") =>
    invoke<CodexProviderSnapshot>("providers:auth:status", providerId),
  authStart: (request: { flowId: string; providerId: "openai-codex" }) =>
    invoke<{ started: true }>("providers:auth:start", request),
  authRespond: (request: {
    flowId: string;
    providerId: "openai-codex";
    promptId: string;
    value: string;
  }) => invoke<{ accepted: true }>("providers:auth:respond", request),
  authCancel: (request: { flowId: string; providerId: "openai-codex" }) =>
    invoke<{ cancelled: true } | { cancelled: false; reason: "finishing" }>(
      "providers:auth:cancel",
      request,
    ),
  logout: (providerId: "openai-codex") =>
    invoke<CodexProviderSnapshot>("providers:logout", providerId),
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
  set: (patch: Partial<AppSettings>) =>
    invoke<AppSettings>("settings:set", patch),
  setGoogleThinking: (modelId: string, level: GoogleThinkingLevel) =>
    invoke<AppSettings>("settings:setGoogleThinking", modelId, level),
  setCodexThinking: (modelId: string, level: CodexThinkingLevel) =>
    invoke<AppSettings>("settings:setCodexThinking", modelId, level),
  setAnthropicThinking: (
    modelId: string,
    level: AnthropicThinkingLevel,
  ) => invoke<AppSettings>("settings:setAnthropicThinking", modelId, level),
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
  /** Read-only skills discovered from `.agents` folders (workspace + global). */
  discovered: (folderPath?: string) =>
    invoke<DiscoveredSkill[]>("skills:discovered", folderPath),
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
  apply: () => invoke<void>("shortcut:apply"),
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

/** Native multi-file picker for composer attachments. Returns [] if cancelled. */
export async function pickFiles(): Promise<string[]> {
  const res = await window.aidenAPI.dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
  });
  if (res.canceled || !res.filePaths?.length) return [];
  return res.filePaths;
}

// ── Attachments & model catalog ───────────────────────────────────────
export const attachmentsApi = {
  read: (paths: string[]) => invoke<Attachment[]>("attachments:read", paths),
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
export const chatsApi = {
  list: (workspaceId?: string) => invoke<ChatMeta[]>("chats:list", workspaceId),
  get: (id: string) => invoke<Chat | null>("chats:get", id),
  create: (input: {
    title?: string;
    workspaceId?: string;
    providerId?: string;
    model?: string;
  }) => invoke<Chat>("chats:create", input),
  rename: (id: string, title: string) =>
    invoke<void>("chats:rename", id, title),
  renameWithFoundationModels: (id: string) =>
    invoke<ChatTitleRenameResult>("chats:renameWithFoundationModels", id),
  moveEmptyToWorkspace: (id: string, workspaceId: string) =>
    invoke<Chat>("chats:moveEmptyToWorkspace", id, workspaceId),
  setComputerUse: (id: string, enabled: boolean) =>
    invoke<Chat>("chats:setComputerUse", id, enabled),
  remove: (id: string) => invoke<void>("chats:remove", id),
  appendMessage: (
    id: string,
    message: {
      role: ChatMessage["role"];
      content: string;
      model?: string;
      attachments?: Attachment[];
    },
    meta?: { providerId?: string; model?: string; autoTitle?: boolean },
  ) => invoke<Chat>("chats:appendMessage", id, message, meta),
  approve: (approvalId: string, decision: ApprovalDecision) =>
    invoke<void>("chat:approve", approvalId, decision),
};

// ── Streaming generation ──────────────────────────────────────────────
interface ChatDelta {
  streamId: string;
  delta: string;
}
interface ChatReasoningDelta {
  streamId: string;
  delta: string;
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
}
interface ChatApproval extends ApprovalPrompt {
  streamId: string;
}

export interface GenerationHandle {
  streamId: string;
  cancel: (origin: "lifecycle" | "user_stop") => void;
}

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
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
  onTool?: (phase: ToolPhase, toolName: string) => void;
  onApproval?: (prompt: ApprovalPrompt) => void;
}

function makeStreamId(): string {
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
): GenerationHandle {
  const streamId = makeStreamId();
  const unsubs: Array<() => void> = [];
  const dispose = () => {
    for (const u of unsubs) u();
    unsubs.length = 0;
  };

  unsubs.push(
    onNotification<ChatDelta>("chat:delta", (p) => {
      if (p.streamId === streamId) callbacks.onDelta(p.delta);
    }),
  );
  unsubs.push(
    onNotification<ChatReasoningDelta>("chat:reasoning-delta", (p) => {
      if (p.streamId === streamId) callbacks.onReasoningDelta?.(p.delta);
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
        });
    }),
  );

  void invoke<{ streamId: string }>("chat:start", streamId, params).catch(
    (error: unknown) => {
      callbacks.onError(error instanceof Error ? error.message : String(error));
      dispose();
    },
  );

  return {
    streamId,
    cancel: (origin) => {
      void invoke("chat:cancel", streamId, origin);
    },
  };
}
