// Electron-free renderer-safe wire contracts for chats, model metadata,
// scheduled tasks, streaming generation parameters, and tool approvals.

import type { AgentNoticeV1 } from "./agent-notices.js";
import type { ChatUiVisualV1 } from "./aiden-ui/types.js";
import type { AppControlPanel } from "./app-controls.js";
import type { InlineVisualsMode } from "./appearance.js";
import type { AssistantTurnStatsV1 } from "./assistant-turn-stats.js";
import type { GrabbedElementContextV1 } from "./browser-element-grab.js";
import type {
  ChatHtmlArtifactV1,
  ChatImagePlacementV1,
  HtmlArtifactPlacementV1,
} from "./chat-artifacts.js";
import type { ChatForkLineageV1 } from "./chat-copy-contract.js";
import type { ChatInputSourceV1 } from "./chat-input-source.js";
import type { ChatStartedByV1 } from "./chat-started-by.js";
import type { ChatOwnerV1 } from "./chat-visibility.js";
import type { CustomModelOptions } from "./custom-model-options.js";
import type { DesignViewState } from "./design-canvas/canvas-summary.js";
import type { GenerationThinkingLevel } from "./generation-thinking.js";
import type { GenerationTimeline } from "./generation-timeline.js";
import type { ProviderModelType } from "./ipc-provider-contracts.js";
import type { ProviderFailureV1 } from "./provider-failure.js";
import type { ScheduledTaskTrigger } from "./scheduled-task-trigger.js";
import type { SkillProvenanceV1 } from "./slash-commands.js";
import type { SubagentMessageReferenceV1 } from "./subagent-runs.js";
import type { VisualSnapshotRefV1 } from "./visual-snapshots.js";

export type ChatRole = "user" | "assistant" | "system";

export type AttachmentKind = "image" | "text";

/**
 * A durable file attached to a chat message. Text files carry inlined `text`.
 * An image carries base64 `data`, a `sha256` naming its file in the chat image
 * store, or both: chat files on disk keep only the hash, and the chat store
 * fills `data` back in for main-process readers.
 */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  /** base64 (no data: prefix) for image attachments. */
  data?: string;
  /** SHA-256 (lowercase hex) of a stored image's bytes. */
  sha256?: string;
  /** Pixel size of a stored image, so a transcript reserves its box before the bytes load. */
  width?: number;
  height?: number;
  /** Renderer only: private `aiden-attachment:` link to a stored image's bytes. */
  url?: string;
  /** UTF-8 contents for text/code attachments (truncated). */
  text?: string;
}

/** The display-only record that a hook stopped this user message. */
export interface HookBlockedPromptV1 {
  reason: string;
}

/** Renderer-safe visible chat message; raw Pi protocol payloads (`pi`) stay in main. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** Model that produced an assistant message. */
  model?: string;
  /** Deliberately exposed provider reasoning retained on an assistant message. */
  reasoning?: string;
  /** Closed, renderer-safe terminal provider outcome. */
  providerFailure?: ProviderFailureV1;
  /** Files presented with this user or assistant message. */
  attachments?: Attachment[];
  /** Interactive HTML artifacts; bytes remain in the generative-ui store. */
  appPanels?: AppControlPanel[];
  htmlArtifacts?: ChatHtmlArtifactV1[];
  /** Producing tool call per HTML artifact, so it renders at that point in the reply. */
  htmlArtifactPlacements?: HtmlArtifactPlacementV1[];
  /** Producing call (generate_image, display_image or share_image) per image attachment. */
  imagePlacements?: ChatImagePlacementV1[];
  /** Native (render_ui) visuals, drawn from Aiden's component catalog. */
  uiVisuals?: ChatUiVisualV1[];
  /** Snapshot image (a reserved attachment) per visual, for clients that cannot draw it. */
  visualSnapshots?: VisualSnapshotRefV1[];
  /** Browser elements grabbed from Aiden Browser for this user message; linked thumbnails live in `attachments`. */
  grabbedElements?: GrabbedElementContextV1[];
  /** Safe display-only provenance for an explicitly invoked skill. */
  skill?: SkillProvenanceV1;
  /** A user-role follow-up notice (job ended, pull request news, check result), drawn as a card. */
  notice?: AgentNoticeV1;
  /** User messages Aiden Live sent for the person ("By voice"); display-only. */
  inputSource?: ChatInputSourceV1;
  /** Sent by the chat that started this one (desktop label "From “<lead>”"). */
  fromLeadChat?: true;
  /** Set when a UserPromptSubmit hook blocked this user message; it never reaches a model. */
  hookBlocked?: HookBlockedPromptV1;
  /** Renderer-safe tool milestones associated with this assistant response. */
  timeline?: GenerationTimeline;
  /** Content-free turn duration and provider-reported token totals for the footer. */
  turnStats?: AssistantTurnStatsV1;
  /** Bounded references to separately persisted renderer-safe child run records. */
  subagents?: SubagentMessageReferenceV1;
}

/** models.dev list price in USD per 1M tokens; only finite, non-negative fields are kept. */
export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type ModelMetadataSource =
  | "local"
  | "provider"
  | "models-dev"
  | "fallback";

/** Normalized model metadata after applying local and bundled-source precedence. */
export interface ModelInfo {
  detectedCapabilities?: CustomModelOptions;
  maxImages?: number;
  video?: boolean;
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
  /** Normalized capability classification; every value except `llm` is non-chat. */
  modelType?: ProviderModelType;
  parameterCount?: string;
  format?: string;
  contextLength?: number;
  outputLimit?: number;
  inputModalities?: string[];
  /** Training knowledge cutoff (e.g. "2025-05"). */
  knowledge?: string;
  releaseDate?: string;
  /** models.dev list price in USD per 1M tokens. Display-only; never affects limits or routing. */
  cost?: ModelCost;
  /** models.dev canonical model id for the matched row. Display-only. */
  canonicalModelId?: string;
  metadataSource: ModelMetadataSource;
  /** True when any trusted metadata source identified the model. */
  matched: boolean;
}

/** Renderer-safe chat metadata; list-projection `preview` and `summaryRevision` stay in main. */
export interface ChatMeta {
  id: string;
  title: string;
  /** Workspace this chat belongs to. */
  workspaceId?: string;
  /** Main-owned reusable bot identity; absent for ordinary and Assistant chats. */
  botId?: string;
  providerId?: string;
  model?: string;
  /**
   * This chat's own reasoning effort for its model, set by an Agent Slider
   * stop. Absent: the per-model saved level applies. Cleared when the model
   * changes without a level. Never sent to Aiden Remote.
   */
  thinkingLevel?: GenerationThinkingLevel;
  /**
   * createdAt of the newest persisted assistant message with visible output.
   * Drives honest unread markers; absent on legacy rows until their next write.
   */
  lastAssistantAt?: number;
  lastAssistantSequence?: number;
  lastAssistantMessageId?: string;
  /**
   * The message at `lastAssistantAt` ended its turn in failure, so an unread
   * row says Failed instead of showing a new-reply dot. Absent when false.
   */
  lastAssistantFailed?: boolean;
  /** Main-owned provenance for chats created by Fork; absent for ordinary chats and copies. */
  forkedFrom?: ChatForkLineageV1;
  /** Main-owned: the chat that started this one through `child_chats`; absent otherwise. */
  startedBy?: ChatStartedByV1;
  /** Main-owned feature owner; owned chats never appear in chat listings or Remote. */
  owner?: ChatOwnerV1;
  /** Temporary floating chat hidden from sidebar, Inbox, Memory, and Remote until saved or attached. */
  ephemeral?: true;
  /** This chat opens in design mode (narrow chat beside the canvas); absent when off. */
  designMode?: true;
  createdAt: number;
  updatedAt: number;
}

/** Shared chat body fields parameterized by message type; main and renderer extend separately. */
export interface ChatCore<TMessage = ChatMessage> extends ChatMeta {
  /**
   * The user granted Computer Use for this chat ("Allow for this chat" on the
   * access card). The global Computer Use beta setting remains authoritative.
   */
  computerUseAllowed?: boolean;
  /**
   * Set while a Computer Use access request waits on missing macOS
   * permissions, so the chat can offer Continue after the user restarts Aiden.
   */
  computerUsePendingContinue?: boolean;
  messages: TMessage[];
}

/** Renderer-projected chat; omits main-only `firstMessageCommit` and adds image recovery flags. */
export interface Chat extends ChatCore<ChatMessage> {
  /** Main-owned crash stage exists and must be recovered before another chat mutation. */
  imageArtifactRecoveryPending?: boolean;
  /** Main-owned image staging could not be opened or quarantined automatically. */
  imageArtifactRecoveryUnavailable?: boolean;
}

export type ScheduledTaskMode = "llm" | "script";
export type ScheduledTaskPermission = "read-only" | "full";
export type ScheduledTaskExecutionProfile = "assistant";
export type ScheduledRunResult = "success" | "error" | "silent" | "blocked" | "skipped";

/** Renderer-safe scheduled task wire projection; Bot routine and fingerprint state stay in main. */
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
  /** Main-owned, read-only: the chat this task was made in, where its runs post. */
  originChatId?: string;
  /** What starts the task instead of its schedule; `cron` is empty when set. */
  trigger?: ScheduledTaskTrigger;
  notify: boolean;
  lastResult?: ScheduledRunResult;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** Renderer-safe scheduled run wire projection; Bot routine timing, skip reasons, and fingerprints stay in main. */
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

/** Renderer-safe scheduled task mutation input; main-owned bindings and Bot fields are excluded. */
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
  /** What starts the task instead of `cron`; `null` turns a trigger task back into a scheduled one. */
  trigger?: ScheduledTaskTrigger | null;
  notify?: boolean;
}

export interface ScheduledTaskSettings {
  enabled: boolean;
  defaultMode: ScheduledTaskMode;
  defaultPermission: ScheduledTaskPermission;
  defaultMcpEnabled: boolean;
  defaultNotify: boolean;
  defaultTimezone: string;
  /** "Let chats check back later": a workspace chat's agent may set check-backs. */
  chatCheckBacks: boolean;
  /** Keep this computer awake while Aiden works (on by default). Desktop-only; not sent to phones. */
  keepAwakeWhileWorking: boolean;
}

/** Shared generation-start parameters; main adds `messages` and unattended Assistant modes. */
export interface ChatStartParamsBase<TMode extends string = "assistant"> {
  chatId: string;
  workspaceId?: string;
  providerId: string;
  model: string;
  /** Renderers may only request the attended Aiden mode. */
  mode?: TMode;
  /** Small main-validated enum; provider/model support is enforced at runtime. */
  thinkingLevel?: GenerationThinkingLevel;
  /** Host-owned /visualize instruction for this attended turn. */
  visualize?: boolean;
  /** Settings → Appearance → Inline visuals; automatic when absent. */
  inlineVisuals?: InlineVisualsMode;
  /**
   * A desktop design-mode message: the frames the person had selected and the
   * canvas region's size on their screen. Absent from phones and other turns.
   */
  designView?: DesignViewState;
}

export interface ChatStartParams extends ChatStartParamsBase<"assistant"> {}

/** A pending request for the user to approve a mutating tool call ("ask" mode). */
export interface ApprovalRequest {
  streamId: string;
  approvalId: string;
  toolName: string;
  /** Human-readable summary of what Pi wants to do, e.g. "Run: npm test". */
  summary: string;
}

export type ApprovalDecision = "allow" | "deny";
