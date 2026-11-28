// Shared backend data types for the AI chat client. Renderer-safe wire shapes
// live in `renderer/shared/ipc-*-contracts.ts`; main-only protocol, routine,
// and persistence extensions are layered here so private fields never leak.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { BotRoutineFailure } from "../../renderer/shared/bot-routine-failure.js";
import type { BotRoutineSchedule } from "../../renderer/shared/bot-routine-schedule.js";
import type { GrabbedElementContextV1 } from "../../renderer/shared/browser-element-grab.js";
import type { GenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  AttachmentKind,
  ChatCore,
  ChatMessage as SharedChatMessage,
  ChatMeta as SharedChatMeta,
  ChatRole,
  ChatStartParamsBase,
  ModelCost,
  ModelInfo,
  ModelMetadataSource,
  ScheduledRun as SharedScheduledRun,
  ScheduledRunResult,
  ScheduledTask as SharedScheduledTask,
  ScheduledTaskExecutionProfile,
  ScheduledTaskInput as SharedScheduledTaskInput,
  ScheduledTaskMode,
  ScheduledTaskPermission,
  ScheduledTaskSettings,
} from "../../renderer/shared/ipc-chat-schedule-contracts.js";
import type {
  Provider,
  ProviderDeployment,
  ProviderKind,
  ProviderModelMetadata,
  ProviderModelType,
  StoredProvider,
} from "../../renderer/shared/ipc-provider-contracts.js";
import type {
  AppSettings,
  AssistantConfig,
  AssistantSettingsPermission,
  ChatTitleProviderId,
  ComputerUseStatus,
  ComputerUseStatusState,
  DiscoveredSkill,
  FoundationModelsConnectionState,
  FoundationModelsConnectionStatus,
  GeminiUsageScope,
  McpServer,
  McpTransport,
  Profile,
  Skill,
  TelegramProfileSettings,
  UsageDateRange,
  UsageDaySummary,
  UsageModelSummary,
  UsageSummary,
  UsageTokenBreakdown,
  VoiceProvider,
} from "../../renderer/shared/ipc-settings-usage-contracts.js";
import type {
  GitBranches,
  GitHubPullRequestAvailability,
  GitHubPullRequestCheck,
  GitHubPullRequestChecksState,
  GitHubPullRequestCheckStatus,
  GitHubPullRequestReviewDecision,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
  GitInfo,
  GitWorktree,
  ManagedWorktree,
  Workspace,
  WorkspacePermission,
} from "../../renderer/shared/ipc-workspace-git-contracts.js";

export type {
  ProviderKind,
  ProviderDeployment,
  ProviderModelType,
  ProviderModelMetadata,
  StoredProvider,
  Provider,
};

export type {
  WorkspacePermission,
  ManagedWorktree,
  Workspace,
  GitHubPullRequestCheckStatus,
  GitHubPullRequestChecksState,
  GitHubPullRequestAvailability,
  GitHubPullRequestCheck,
  GitHubPullRequestReviewDecision,
  GitHubPullRequestSummary,
  GitHubPullRequestStatus,
  GitInfo,
  GitBranches,
  GitWorktree,
};

export interface GitHubPullRequestListStatus {
  availability: GitHubPullRequestAvailability;
  message?: string;
  /** Epoch ms when a "rate-limited" read may be retried. */
  retryAt?: number;
  pullRequests?: GitHubPullRequestSummary[];
}

export interface GitHubRepositoryRef {
  host: string;
  /** Canonical `owner/repo` (lowercase, no `.git`). */
  nameWithOwner: string;
}

export interface GitHubRepositoryStatus {
  availability: GitHubPullRequestAvailability;
  message?: string;
  /** Epoch ms when a "rate-limited" read may be retried. */
  retryAt?: number;
  repository?: GitHubRepositoryRef;
  /** The branch name the checked-out branch pushes to; absent for an explicit repository. */
  headBranch?: string;
}

export interface GitHubPullRequestCreateInput {
  repository?: string;
  title: string;
  body?: string;
  baseBranch?: string;
  headBranch?: string;
  draft?: boolean;
}

/**
 * `gh pr create` triage. "failed" means the CLI demonstrably never reached a
 * successful mutation (missing tool, auth, input rejected before the request).
 * Anything where GitHub may have created the PR — timeouts, kills, network
 * errors, even an exit code whose message is ambiguous — is "unknown" and must
 * go through reconciliation before being retried or reported.
 */
export type GitHubPullRequestCreateResult =
  | { kind: "created"; pullRequest: GitHubPullRequestSummary }
  | { kind: "failed"; availability: GitHubPullRequestAvailability; message: string }
  | { kind: "unknown"; message: string };

export type {
  ChatRole,
  AttachmentKind,
  Attachment,
  ModelCost,
  ModelMetadataSource,
  ModelInfo,
  ScheduledTaskMode,
  ScheduledTaskPermission,
  ScheduledTaskExecutionProfile,
  ScheduledRunResult,
  ScheduledTaskSettings,
  ApprovalRequest,
  ApprovalDecision,
};

export interface ChatMessage extends SharedChatMessage {
  /** Canonical Pi assistant protocol payload; raw errors and diagnostics are excluded. */
  pi?: Omit<AssistantMessage, "diagnostics" | "errorMessage">;
}

export interface ChatMeta extends SharedChatMeta {
  /** Bounded last visible message text for list projections; never a full history. */
  preview?: string;
  /**
   * Main-owned optimistic-concurrency token for transcript-free list
   * projections. Legacy records derive a stable token until their next write.
   */
  summaryRevision?: string;
}

export interface Chat extends ChatCore<ChatMessage>, ChatMeta {
  /** Main-owned receipt for an idempotent first-message commit; never renderer-authored. */
  firstMessageCommit?: { turnId: string; fingerprint: string };
}

/** Why a run was recorded without doing work. */
export type ScheduledRunSkipReason =
  | "bot_paused"
  | "duplicate"
  | "paused_by_person"
  /** The task posts into a chat that stayed busy past the bounded wait. */
  | "chat_busy"
  /** The task posts into a chat that already ran its hourly share of task runs. */
  | "chat_budget"
  /** A chat task's automatic fire more than 12 hours late (asleep or closed); it waits for its next time. */
  | "too_late";

export interface ScheduledMcpServerBinding {
  id: string;
  fingerprint: string;
}

/** A Bot's own wake-up: when the Bot set it, for the "You set this wake-up at …" framing. */
export interface BotWakeUpMarker {
  generation?: string;
  setAt: number;
}

export interface ScheduledTask extends SharedScheduledTask {
  /** A claimed Bot fire awaiting a durable run receipt and delivery handoff. */
  pendingRoutineFires?: Array<{
    fireTime: number;
    /** Original occurrence facts; retry fireTime is only the retry's due time. */
    routineTiming?: import("./bot-routines-port.js").BotRoutineTiming;
    /** Reconcile an admitted retry without starting a new turn. */
    observeOnly?: true;
    requestId: string;
    prompt: string;
    name: string;
    /**
     * Set when this entry is a delayed retry of a failed fire rather than a
     * scheduled fire. `fireTime` is when the retry becomes due.
     */
    retry?: { failedRunId: string; attempt: 1 | 2; verifiedToolFree?: true };
  }>;
  /** When a Bot routine was last turned back on; failure streaks count only runs after it. */
  enabledAt?: number;
  /** Main-owned provider-connection fingerprint. Renderer mutations cannot set this field. */
  providerFingerprint?: string;
  /** Main-owned immutable connection fingerprints for Assistant-approved MCP scope. */
  mcpServerBindings?: ScheduledMcpServerBinding[];
  /**
   * Main-owned Bot that owns this routine. A Bot routine submits to that Bot's
   * conversation instead of a workspace chat and is hidden from the generic
   * scheduled-task surfaces. Immutable once set.
   */
  botId?: string;
  /** Frequency-first schedule a Bot routine was created from; `cron` is derived from it. */
  routineSchedule?: BotRoutineSchedule;
  /** The Bot proposal an accepted routine came from; accepting it again returns this task. */
  sourceProposalId?: string;
  /** Main-owned: a one-time routine the Bot set for itself with `wake_up`, not one the person made. Set once. */
  wakeUp?: BotWakeUpMarker;
  /**
   * Main-owned: when repeated failed runs last paused this chat task. Only
   * failures after it count toward the next pause. Never on a Bot routine.
   */
  failurePausedAt?: number;
}

export interface ScheduledRun extends SharedScheduledRun {
  /** Private host occurrence facts; old Remote projections must omit these. */
  routineTiming?: import("./bot-routines-port.js").BotRoutineTiming;
  /** Present only when `result` is "skipped". */
  reason?: ScheduledRunSkipReason;
  /** Why an otherwise indistinguishable failure happened. Bot routines only. */
  failure?: BotRoutineFailure;
  /** The reply claimed a step worked that failed (spec §5 S5). Names only, bounded. */
  claimCheck?: { stepIds: string[]; toolNames: string[] };
  /** The Bot's behavior fingerprint when the run was sent (spec §4.4). */
  fingerprint?: string;
  /** The person started it (Run now). Its failure never counts toward pausing the task. */
  byHand?: true;
  /** A `blocked` run that was stopped (cancelled or Aiden quitting), not refused. */
  cancelled?: true;
}

export interface ScheduledTaskInput extends SharedScheduledTaskInput {
  /** Main-owned provider-connection fingerprint. Renderer mutations cannot set this field. */
  providerFingerprint?: string;
  /** Main-owned immutable connection fingerprints. Renderer mutations cannot set this field. */
  mcpServerBindings?: ScheduledMcpServerBinding[];
  /** Main-owned runtime profile. Renderer task mutations cannot set this field. */
  executionProfile?: ScheduledTaskExecutionProfile;
  /** Main-owned: the chat a new task posts into. Only read when creating; saves of an existing task keep its binding. */
  originChatId?: string;
  /** Main-owned Bot routine owner. Renderer schedule mutations cannot set this field. */
  botId?: string;
  /** Main-owned Bot routine schedule; when set, `cron` is derived from it. */
  routineSchedule?: BotRoutineSchedule;
  /** Main-owned: the Bot proposal this routine was accepted from. Set once, at creation. */
  sourceProposalId?: string;
  /** Main-owned: the Bot set this one-time routine for itself (`wake_up`). Set once, at creation. */
  wakeUp?: BotWakeUpMarker;
}

export type {
  McpTransport,
  McpServer,
  Skill,
  DiscoveredSkill,
  VoiceProvider,
  GeminiUsageScope,
  ChatTitleProviderId,
  FoundationModelsConnectionState,
  FoundationModelsConnectionStatus,
  AssistantSettingsPermission,
  AssistantConfig,
  AppSettings,
  TelegramProfileSettings,
  ComputerUseStatusState,
  ComputerUseStatus,
  Profile,
  UsageDateRange,
  UsageTokenBreakdown,
  UsageDaySummary,
  UsageModelSummary,
  UsageSummary,
};

/** Params for a streaming generation request. */
export interface ChatStartParams
  extends ChatStartParamsBase<"assistant" | "assistant-unattended" | "assistant-automation"> {
  messages: Array<{
    role: ChatRole;
    content: string;
    attachments?: Attachment[];
    grabbedElements?: GrabbedElementContextV1[];
  }>;
}

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
  /** Accepted Steer text Pi never read into the visible chat; the renderer restores it to the draft. */
  undeliveredGuidance?: string[];
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
  undeliveredGuidance?: string[];
}
export const MAX_CONFIG_ID_LENGTH = 256;
export const MAX_PROVIDER_BASE_URL_LENGTH = 4_096;
export const MAX_PROVIDER_KEY_LENGTH = 1_048_576;
