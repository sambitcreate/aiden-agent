// Renderer-facing IPC contracts. Shared cross-process shapes live in
// `renderer/shared/ipc-*-contracts.ts`; renderer-only view envelopes stay here.

import type {
  BoundedNonSecretProviderConfig,
  WebSearchProviderId,
  WebSearchProviderRendererMetadata,
  WebSearchRendererSnapshot,
  WebSearchRouteEntry,
  WebSearchSelection,
  WebSearchSettingsV2,
} from "../../main/services/web-search-provider-registry-core.js";
import type {
  WebSearchExistingAuthConsentRequest,
  WebSearchExistingAuthRendererOption,
  WebSearchExistingAuthRendererSnapshot,
  WebSearchExistingAuthRendererStatus,
} from "../../main/services/web-search-auth-reuse-core.js";
import type { ChatMetadataUpdatedPatch } from "../shared/chat-metadata-update.js";
import type { McpPreset, McpPresetAuth } from "../shared/connector-catalog.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  type CodexModelSummary,
  type CodexProviderSnapshot,
  type Provider,
  type ProviderAuthDone,
  type ProviderAuthError,
  type ProviderAuthErrorCode,
  type ProviderAuthEvent,
  type ProviderAuthPrompt,
  type ProviderAuthPromptType,
  type ProviderAuthSelectOption,
  type ProviderDeployment,
  type ProviderKind,
  type ProviderModelMetadata,
  type ProviderModelType,
} from "../shared/ipc-provider-contracts.js";
import type {
  GitBranches,
  GitCommitCapability,
  GitCommitInput,
  GitCommitMode,
  GitCommitResult,
  GitComparison,
  GitComparisonDiffInput,
  GitDiffInput,
  GitFileDiff,
  GitHubPullRequestAvailability,
  GitHubPullRequestCheck,
  GitHubPullRequestChecksState,
  GitHubPullRequestCheckStatus,
  GitHubPullRequestReviewDecision,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
  GitInfo,
  GitPushCapability,
  GitPushInput,
  GitPushResult,
  GitReview,
  GitReviewFile,
  GitReviewFileStatus,
  GitReviewSummary,
  GitWorktree,
  ManagedWorktree,
  Workspace,
  WorkspaceFileDocument,
  WorkspaceFileEntry,
  WorkspaceFileIndex,
  WorkspaceFileKind,
  WorkspacePermission,
} from "../shared/ipc-workspace-git-contracts.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  AttachmentKind,
  Chat,
  ChatMessage,
  ChatMeta,
  ChatRole,
  ChatStartParams,
  HookBlockedPromptV1,
  ModelCost,
  ModelInfo,
  ModelMetadataSource,
  ScheduledRun,
  ScheduledRunResult,
  ScheduledTask,
  ScheduledTaskExecutionProfile,
  ScheduledTaskInput,
  ScheduledTaskMode,
  ScheduledTaskPermission,
  ScheduledTaskSettings,
} from "../shared/ipc-chat-schedule-contracts.js";
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
  SubagentModelRoleSetting,
  SubagentModelSettings,
  TelegramProfileSettings,
  UsageDateRange,
  UsageDaySummary,
  UsageModelSummary,
  UsageSummary,
  UsageTokenBreakdown,
  VoiceProvider,
} from "../shared/ipc-settings-usage-contracts.js";

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
export type { BotDefinition } from "../shared/bots.js";

export {
  OPENAI_CODEX_PROVIDER_ID,
  type CodexModelSummary,
  type CodexProviderSnapshot,
  type Provider,
  type ProviderAuthDone,
  type ProviderAuthError,
  type ProviderAuthErrorCode,
  type ProviderAuthEvent,
  type ProviderAuthPrompt,
  type ProviderAuthPromptType,
  type ProviderAuthSelectOption,
  type ProviderDeployment,
  type ProviderKind,
  type ProviderModelMetadata,
  type ProviderModelType,
};

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

export interface CodexProviderStatusChanged {
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  needsAttention: boolean;
}

export interface OnboardingProviderValidationResult {
  provider: Provider;
  catalogWarning?: string;
}

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
  GitReviewFileStatus,
  GitReviewFile,
  GitReviewSummary,
  GitCommitCapability,
  GitReview,
  GitDiffInput,
  GitCommitMode,
  GitCommitInput,
  GitCommitResult,
  GitPushCapability,
  GitPushInput,
  GitPushResult,
  GitComparison,
  GitComparisonDiffInput,
  GitFileDiff,
  WorkspaceFileKind,
  WorkspaceFileEntry,
  WorkspaceFileIndex,
  WorkspaceFileDocument,
};

export interface ExternalEditor {
  id: string;
  label: string;
  iconDataUrl: string;
}

export type WorkspaceFileWriteResult =
  | { ok: true; document: WorkspaceFileDocument }
  | { ok: false; code: "changed_on_disk" | "io_error"; message: string };

export type {
  ChatRole,
  AttachmentKind,
  Attachment,
  HookBlockedPromptV1,
  ModelCost,
  ModelMetadataSource,
  ModelInfo,
  ChatMessage,
  ChatMeta,
  Chat,
  ScheduledTaskMode,
  ScheduledTaskPermission,
  ScheduledTaskExecutionProfile,
  ScheduledRunResult,
  ScheduledTask,
  ScheduledRun,
  ScheduledTaskInput,
  ScheduledTaskSettings,
  ChatStartParams,
  ApprovalRequest,
  ApprovalDecision,
};

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

export type ChatMetadataUpdated = ChatMetadataUpdatedPatch;

/** `chats:design-mode-changed`: one chat's design mode turned on or off. */
export interface ChatDesignModeChanged {
  chatId: string;
  designMode: boolean;
}

export interface ChatTitleRenameResult extends ChatMetadataUpdated {
  changed: boolean;
}

/** A built-in connector definition from the main-process catalog. */
export type { McpPreset, McpPresetAuth };

/** Catalog entry plus the user's connection state for it. */
export interface McpPresetState {
  preset: McpPreset;
  serverId: string;
  configured: boolean;
  enabled: boolean;
  /** API key stored (apiKey presets), OAuth tokens present (oauth presets), or saved (no-credential presets). */
  ready: boolean;
  /** OAuth presets: the stored sign-in was rejected and must be renewed. */
  needsSignIn?: boolean;
  /** OAuth presets: a browser sign-in is stored (usable or not), so it can be signed out. */
  hasSession?: boolean;
  /** The saved record for this preset is unusable; setup can repair it or it can be removed. */
  error?: string;
  /** The saved record failed validation; setup rebuilds it from the preset's official settings. */
  invalidRecord?: boolean;
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
  SubagentModelRoleSetting,
  SubagentModelSettings,
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

export type FormFillArtifactState =
  | "not-downloaded"
  | "downloading"
  | "preparing"
  | "ready"
  | "update-required"
  | "unsupported"
  | "error";

export interface FormFillArtifactStatus {
  state: FormFillArtifactState;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

export interface FormFillSettingsView {
  enabled: boolean;
  status: FormFillArtifactStatus;
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
  /** ISO 639 codes the model can transcribe. */
  languages: string[];
  capabilities: {
    autoDetect: boolean;
    languageHint: boolean;
    translateToEnglish: boolean;
    maxWindowSeconds: number | null;
  };
  license: { name: string; url: string; attribution?: string };
}

/** State of the bundled on-device (sherpa-onnx) engine. */
export interface EngineStatus {
  ready: boolean;
  error: string | null;
}

export type {
  McpDependent,
  McpLiveState,
  McpLiveStatus,
  McpMacAppStatus,
  McpServerDependents,
  McpStatus,
  McpToolSummary,
  McpPendingLaunchApproval,
} from "../shared/mcp-status.js";
