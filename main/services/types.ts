// Shared backend/renderer data types for the AI chat client.

export type ProviderKind = "openai" | "anthropic";

/** A configured connection to an LLM backend (hosted or local). */
export interface StoredProvider {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Suggested / cached model ids for the picker. */
  models: string[];
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

/** A named working context: an optional folder + a permission level for its chats. */
export interface Workspace {
  id: string;
  name: string;
  /** Absolute path to the folder Pi operates in (undefined = no folder bound yet). */
  folderPath?: string;
  permission: WorkspacePermission;
  createdAt: number;
  updatedAt: number;
}

/** Result of inspecting a folder for git status. */
export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  /** Number of uncommitted (staged + unstaged + untracked) entries. */
  uncommitted?: number;
}

/** Branch list for the composer's branch picker. */
export interface GitBranches {
  isRepo: boolean;
  current?: string;
  branches: string[];
  /** Uncommitted entry count on the current branch. */
  uncommitted: number;
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
}

/** Normalized capability info for a model, sourced from models.dev. */
export interface ModelInfo {
  id: string;
  name?: string;
  /** Accepts image input (vision). */
  vision: boolean;
  /** Supports tool/function calling. */
  toolCall: boolean;
  /** Exposes reasoning / thinking. */
  reasoning: boolean;
  /** Open-weight / open-source model. */
  openWeights: boolean;
  contextLength?: number;
  outputLimit?: number;
  inputModalities?: string[];
  /** Training knowledge cutoff (e.g. "2025-05"). */
  knowledge?: string;
  releaseDate?: string;
  /** True when the model was found in the models.dev catalog. */
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

/** Persisted lightweight app settings (theme is handled natively). */
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
}
export interface ChatError {
  streamId: string;
  message: string;
}
