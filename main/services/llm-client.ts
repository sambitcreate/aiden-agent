import { createWorkspaceFilesTouchedNotifier } from "./workspace-files-touched.js";
import { aidenAppNavigation } from "./aiden-app-navigation.js";
import type { AgentNoticeV1 } from "../../renderer/shared/agent-notices.js";
import { createAidenAppTools } from "./aiden-app-tools.js";
import { appControlsService } from "./app-controls-main.js";
import type { AppControlPanel } from "../../renderer/shared/app-controls.js";
import { canUseProviderAuthenticatedMcp } from "./mcp-provider-auth-core.js";
import { providerRegistry } from "./provider-registry.js";
import { canWarmForegroundChat, PiCacheWarmer, withPiCacheWarming } from "./pi-cache-warming.js";
import { createModelPaceMeasurement } from "./model-pace-core.js";
import { modelPaceRecorder } from "./model-pace-runtime.js";
import { usageLimits } from "./usage-limit-main.js";
import { withUsageLimitWait } from "./usage-limit-stream.js";
import { spending } from "./spending-main.js";
import { createSpendingMeter, spendCounts } from "./spending-service.js";
import type { SpendingOwner } from "./spending-core.js";
import { createLocalClassifierModels } from "./pi-local-classifier.js";
import { piResourcesForSkillSnapshot } from "./skill-tools.js";
import { createMcpServersSectionRefresher, renderMcpServersSection } from "./mcp-server-instructions.js";
import { createAgentsInstructionRefresher } from "./agents-instructions.js";
import { aidenConfigDir } from "./aiden-config-dir.js";
import { assertCustomModelImageLimit, applyCustomModelToolPolicy, customModelThinkingLevels, prepareCustomModelToolContext } from "../../renderer/shared/custom-model-options.js";
import { compactionEngineFrom, configuredCompactionReserveTokens, resolveCompactionModelBudget } from "../../renderer/shared/compaction.js";
import { createVccRecallTool } from "./pi-vcc/recall.js";
import { attachWorkspaceToolOutputs } from "./tool-output-runtime.js";
// Chat generation via pi's embedded agent loop (@earendil-works/pi-agent-core +
// pi-ai). A fresh Agent runs per generation: it owns multi-step tool calling
// (folder-scoped coding tools, Exa search, Agent Skills, MCP servers) and
// streams assistant text. Text, local-model reasoning, and tool activity are
// pushed to the exact renderer document that owns the generation.
//
// Workspaces bind a folder + a permission level. In "ask" mode the agent pauses
// before any mutating tool (write/edit/run_command) via pi's `beforeToolCall`
// hook and waits for the user to Allow or Deny in the UI.

import { type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { convertToLlm, DEFAULT_COMPACTION_SETTINGS } from "./pi-legacy-harness.js";
import { createInitialSystemMessage, toToolDeclaration, type AssistantMessage } from "@earendil-works/pi-ai";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { app, ipcMain, logger } from "../platform.js";
import { buildAgentTools, buildSchedulingTools } from "./tools.js";
import {
  BROWSER_MUTATION_TOOL_NAMES,
  browserToolApprovalSummary,
  browserLocalFileRequest,
  createBrowserAgentTools,
  canUseBrowserTools,
  isBrowserToolName,
} from "./browser-tools.js";
import {
  prepareBrowserToolApproval,
  assertBrowserToolApproval,
  type BrowserToolApproval,
} from "./browser/approval.js";
import type { PreparedBrowserFile } from "./browser/files.js";
import { createBrowserDiscovery } from "./browser-discovery.js";
import { resolveBrowserAgentAccess } from "../../renderer/shared/browser.js";
import {
  canUseDeviceTools,
  createDeviceAgentTools,
  deviceToolApprovalSummary,
  deviceToolRequiresApproval,
  isDeviceToolName,
} from "./devices/device-tools.js";
import { devicesEnabled } from "./devices/feature-flag.js";
import { webSearchService } from "./web-search-main.js";
import { WEB_FETCH_TOOL_NAME } from "../../renderer/shared/web-extract.js";
import { webFetchService } from "./web-fetch-main.js";
import { createVisionAnalysisTool, INSPECT_IMAGE_TOOL_NAME } from "./vision-analysis-tool.js";
import {
  APPROVAL_TOOL_NAMES,
  DISCLOSURE_APPROVAL_TOOL_NAMES,
  buildPinnedCodingTools,
  summarizeToolCall,
} from "./coding-tools.js";
import {
  BOT_FILE_TOOL_NAMES,
  buildBotFileTools,
  type BotFileToolLocation,
} from "./bot-file-tool-router.js";
import { generationGitContext } from "./generation-git-context.js";
import { configStore } from "./config-store.js";
import { chatStore } from "./chat-store.js";
import { botStore } from "./bot-store.js";
import {
  resolveBotForGeneration,
  withBotRuntimeInstructions,
  type BotWorkspacePromptAuthority,
} from "./bot-system-prompt.js";
import {
  assertExactBotProviderDispatch,
  prepareBotGeneration,
  type PreparedBotGeneration,
} from "./bot-generation-preparation.js";
import { selectCanonicalBotChat } from "./bot-canonical-chat.js";
import {
  botRuntimeAuthority,
  BOT_DESKTOP_AUDIENCE_ID,
  resolveBotRuntimeCatalogSnapshot,
  resolveBotRuntimeApprovedRoots,
  type BotRuntimeApprovedRoot,
} from "./bot-runtime-authority-main.js";
import type { BotRuntimeAuthorityAdmission } from "./bot-runtime-authority.js";
import { hostPlatformCapabilities } from "./host-platform-capabilities.js";
import { backgroundJobRequiresApproval } from "./follow-through/background-job-tool.js";
import {
  hostRunRegistry,
  recordRunAttentionResolved,
  recordRunBegin,
  recordRunNotification,
  recordRunSettled,
} from "./host-runs-main.js";
import {
  botManagedWorkspace,
  resolveBotRuntimeMcpConnectionIdentities,
  resolveBotRuntimeSkills,
} from "./bot-capability-services-main.js";
import { mcpAgentToolDescriptor } from "./mcp-agent-tool-descriptor.js";
import {
  botMcpLiveToolMatchesGrant,
  exactBotMcpToolNames,
  exactBotSkillToolNames,
  filterExactBotSubagentMcpInventory,
  filterBotSkillSnapshot,
  protectAdmittedBotTool,
  isComputerUseCapabilityTool,
} from "./bot-tool-authority.js";
import { mcpAgentToolIdentity, mcpToolActivityLabel } from "./mcp-tool-identity.js";
import { createShareImageTool, SHARE_IMAGE_TOOL_NAME } from "./share-image-tool.js";
import { type SkillRegistrySnapshot, withoutSkills } from "./skill-registry.js";
import { buildSystemPrompt, buildSystemPromptWithSections } from "./chat-system-prompt.js";
import { skillRegistry } from "./skill-registry-main.js";
import { DESKTOP_ARTIFACT_SKILLS } from "./workspace-artifacts/skill.js";
import { DESKTOP_HOOK_SKILLS } from "./hooks-skill.js";
import { HOOKS_TOOL_NAME, createHooksTool, offersHooksTool, runsWorkspaceChatHooks } from "./hooks-tool.js";
import { getHookService } from "./hooks/hook-service-main.js";
import {
  assistantTurnTextSeparator,
  buildAgentRuntimeOptions,
  reconcileTerminalAssistantProjection,
  terminalAssistantActivityAnchors,
  terminalAssistantReasoning,
  terminalAssistantThinkingSegments,
  terminalAssistantText,
  resolveGenerationThinkingLevel,
  runtimeSupportsImages,
  settleGenerationCleanup,
  shouldExposeReasoning,
  waitForGenerationStateClear,
} from "./generation-runtime.js";
import { ANTHROPIC_PROVIDER_ID } from "./anthropic-provider.js";
import {
  preflightBotModelAuth,
  resolveBotModelRuntime,
  resolveModelRuntime,
  type ResolvedModelRuntime,
} from "./model-runtime.js";
import { admitBotAfterProviderAuthPreflight } from "./bot-provider-auth-admission-core.js";
import { isBotPaused } from "./bot-pause-main.js";
import {
  AssistantRequestUsageTracker,
  assistantUsageRecord,
  isLocalModelProvider,
  modelOperationUsageRecord,
  reportedTokens,
  unreportedUsageRecord,
} from "./usage-accounting.js";
import {
  ASSISTANT_TURN_STATS_VERSION,
  addTurnUsage,
  type AssistantTurnUsageV1,
} from "../../renderer/shared/assistant-turn-stats.js";
import { usageStore } from "./usage-store.js";
import { storedPiAssistantMessage } from "./pi-message-storage.js";
import { chatForRenderer } from "./visible-chat-projection.js";
import { cancelWorkspaceGenerationsAndSettle } from "./workspace-mutation-gate.js";
import type {
  ApprovalDecision,
  Attachment,
  Chat,
  ChatStartParams,
  WorkspacePermission,
  StoredProvider,
} from "./types.js";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import type { UsageRequestSource } from "./usage-store-core.js";
import type { ProviderFailureV1 } from "../../renderer/shared/provider-failure.js";
import type { ChatContextPressureV1 } from "../../renderer/shared/context-pressure.js";
import { compactionFailureLogMetadata } from "./provider-failure.js";
import { MAX_CUT_OFF_CONTINUATIONS } from "./cut-off-reply.js";
import {
  MAX_STOP_HOOK_CONTINUATIONS,
  createRunInputContexts,
  createWorkspaceChatHooks,
  endWorkspaceChatSession,
  markWorkspaceChatCompacted,
  preCompactSummaryInstructions,
  runPromptIntakeHooks,
  screenRunInputWithHooks,
} from "./workspace-chat-hooks.js";
import { chatSurfaceHooks } from "./agent-surface-hooks.js";
import type { ComputerUseController } from "./computer-use/controller.js";
import {
  authorizeAllowedComputerUseAction,
  COMPUTER_USE_ACCESS_SUMMARY,
  createComputerUseAccessGate,
  type ComputerUseAccessDecision,
} from "./computer-use/access-gate.js";
import {
  COMPUTER_USE_ACCESS_APPROVAL_KIND,
  COMPUTER_USE_ACCESS_SCOPES,
} from "../../renderer/shared/computer-use-access.js";
import type { ComputerUseArgs } from "./computer-use/schema.js";
import { COMPUTER_USE_TOOL_NAME } from "./computer-use/tool.js";
import {
  FORM_FILL_TOOL_NAME,
  currentFormFillAttachments,
  FormFillService,
  type FormFillApprovalDescriptor,
} from "./form-fill/service.js";
import { FORM_FILL_MUTATION_AVAILABLE } from "../../renderer/shared/form-fill-availability.js";
import { toolApprovalPreview } from "../../renderer/shared/tool-approval-preview.js";
import { formFillArtifacts, formFillRuntime } from "./form-fill/artifacts.js";
import {
  EDIT_AUTOMATION_TOOL_NAME,
  SCHEDULE_TOOL_NAME,
  attachAssistantScheduleMcpApproval,
  prepareAssistantEditAutomationProposal,
  prepareStandardScheduleApproval,
  repairAssistantScheduleMcpTarget,
  resolveAssistantScheduleMcpServers,
  resolveAssistantScheduleProject,
  scheduleToolRequiresApproval,
  summarizeEditAutomationToolCall,
  summarizeScheduleToolCall,
} from "./schedule-tool.js";
import {
  ToolApprovalCoordinator,
  toolApprovalBlockReason,
  type ToolApprovalDecisionPayload,
} from "./tool-approval.js";
import { botApprovals } from "./bot-runtime/bot-approvals-main.js";
import {
  SCOPED_APPROVAL_OFFER,
  toolApprovalRuleTarget,
  type ToolApprovalRuleTarget,
} from "./tool-approval-rules.js";
import { toolApprovalRules } from "./tool-approval-rules-main.js";
import { chatMessageToPiMessage, chatUserTextWithAttachments } from "./generation-messages.js";
import { createPiCompactionModels, type PiCompactionEvent } from "./pi-compaction-core.js";
import {
  beginPiVisibleTurnLease,
  piCompactionSessionStore,
  recordPiEffectRecoveryBoundary,
  syncChatMessagesToPiSession,
  projectVisibleHistoryWithoutSkills,
  ensurePiForkSummary,
  type PiVisibleTurnLease,
  appendPiMessages,
} from "./pi-compaction-session-store.js";
import { piRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { createInMemoryPiSession } from "./pi-session-repository-port.js";
import type { PiSessionPort } from "./pi-session-port.js";
import { computerUseCanEverRun, createComputerUseController } from "./computer-use/runtime.js";
import { computerUseStatus } from "./computer-use/status.js";
import { computerUseSupported } from "./computer-use/platform.js";
import { GenerationTimelineProjector, safeToolIssueDetails } from "./generation-timeline.js";
import { canHostAcpHarness, createAcpGenerationHost } from "./acp/generation-host.js";
import { acpHosts } from "./acp/hosts.js";
import { captureRootIdentity } from "./acp/client-files.js";
import { createAcpScratchDirectories } from "./acp/scratch-directory.js";
import { isAcpHarnessProvider } from "../../renderer/shared/acp-harness.js";
import { advisorRuntime } from "./advisor-runtime-main.js";
import { ADVISOR_TOOL_NAME } from "./advisor-runtime.js";
import { snapshotAdvisorRuntimeMessages } from "./advisor-context.js";
import { persistGenerationInitializationTerminal } from "./generation-initialization-terminal.js";
import type { GenerationCancellationOrigin } from "../../renderer/shared/generation-timeline.js";
import {
  assertGenerationContextCapacity,
  updateGenerationContextOptions,
  chatContextPressureFromProjection,
  createGenerationContextTransform,
  modelRetainsSystemUpdates,
} from "./generation-context.js";
import { promptCacheTtlMs } from "./prompt-cache-lifetimes.js";
import {
  invalidateChatContextJournal,
  rememberChatContextProfile,
  rememberPromptCacheRefresh,
} from "./context-pressure.js";
import { generationEmergencyUserError } from "./generation-emergency-outcome.js";
import { buildGeminiWorkspaceSnapshot, GeminiContextCache } from "./gemini-context-cache.js";
import { attachClaimCheck } from "../../renderer/shared/claim-check.js";
import {
  MAX_ATTACHMENT_INLINE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../renderer/shared/attachment-contract.js";
import { listWorkspaceFiles } from "./workspace-files.js";
import { assertManagedWorktreeAdmission } from "./managed-worktree-admission.js";
import { assertWorkspaceFolderPresent, restoreNoWorkspaceFolder } from "./workspace-folder-presence.js";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import {
  activateComputerUseStream,
  activatedComputerUseStreamIds,
  cancelComputerUseAndSettle,
  ComputerUseGenerationGate,
} from "./computer-use/generation-gate.js";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { startLocalModelLoadMonitor, type LocalModelLoadMonitor } from "./local-runtime-status.js";
import { isLocalProviderDeployment } from "../../renderer/shared/provider-deployment.js";
import {
  buildAssistantSystemPrompt,
  withTelegramAgentContract,
  withUnattendedAssistantContract,
} from "./assistant/system-prompt.js";
import { assistantMcpServerInventory } from "./assistant/mcp-tool.js";
import {
  assertScheduledGenerationProvider,
  scheduledProviderFingerprint,
} from "./schedule-provider-binding.js";
import { createPiTurnContextPreparation } from "./pi-turn-context.js";
import { endRunAfterIgnoredToolRecovery } from "./assistant/tool-loop-guard.js";
import type { ToolApprovalDetails } from "../../renderer/shared/assistant.js";
import { DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS } from "./subagents/subagent-child-runner.js";
import { assistantSettingsSections } from "../../renderer/lib/settings-section.js";
import { SubagentSupervisor } from "./subagents/subagent-supervisor.js";
import { chatActivityRegistry } from "./chat-activity.js";
import { interruptedWaits } from "./interrupted-waits-main.js";
import { clipInterruptedWaitSummary } from "./interrupted-reply.js";
import { interruptedWaitSettled } from "../../renderer/shared/interrupted-reply.js";
import { createSubagentTool } from "./subagents/subagent-tool.js";
import {
  parseSubagentModelSettings,
  subagentModelToolOptions,
  type SubagentModelPolicy,
} from "./subagents/subagent-model-selection.js";
import {
  createSubagentChildModelResolver,
  savedThinkingLevelFor,
  subagentModelCandidatesFromSettings,
} from "./subagents/subagent-model-runtime.js";
import { listConfiguredProviders } from "./provider-list-main.js";
import {
  subagentsAllowedForGeneration,
  subagentWorkspaceWriteAllowedForGeneration,
} from "./subagents/eligibility.js";
import {
  subagentChildMcpEnabled,
  subagentChildMcpMutationsEnabled,
  subagentChildDelegationEnabled,
  subagentChildShellEnabled,
  subagentChildWriteEnabled,
  subagentChildWebEnabled,
} from "./subagents/feature-flag.js";
import { inheritedSubagentReadToolCeiling } from "./subagents/capability-profile.js";
import { SubagentEventProjector } from "./subagents/subagent-event-projector.js";
import { subagentRunStore } from "./subagents/subagent-run-store.js";
import { createForegroundSubagentPersistenceV2 } from "./subagents/subagent-foreground-persistence-v2.js";
import { subagentHealthMetrics } from "./subagents/subagent-health-metrics.js";
import { subagentRuntimeRegistry } from "./subagents/child-agent-runtime.js";
import { subagentControlMainV2 } from "./subagents/subagent-control-main.js";
import { resolveProductionSubagentMcpInventory } from "./subagents/subagent-mcp-inventory-production.js";
import {
  projectRequestableSubagentMcpInventoryV2,
  projectRequestableSubagentMcpMutationInventoryV2,
} from "./subagents/request-capabilities-v2.js";
import { productionSubagentMcpMutationHost } from "./subagents/subagent-mcp-mutation-production.js";
import { resolveSubagentShellRunnerBinary } from "./subagents/subagent-shell-runner-io.js";
import {
  isSafeSubagentIdentifier,
  subagentMessageReference,
} from "../../renderer/shared/subagent-runs.js";
import { workspaceMutationGate } from "./workspace-mutation-gate.js";
import { workspaceOperationRegistry } from "./workspace-operation-registry.js";
import {
  preparedSkillPromptForCurrentTurn,
  formatPreparedSkillInvocation,
  type PreparedSkillInvocation,
} from "./skill-invocation-turn.js";
import { SLASH_LIMITS } from "../../renderer/shared/slash-commands.js";
import { ChatDeletionGate } from "./chat-deletion-gate.js";
import {
  authoritativeChatGenerationMode,
  authoritativeChatWorkspaceId,
} from "./chat-workspace-authority.js";
import { ChatWorkspaceMutationGate } from "./chat-workspace-mutation-gate.js";
import { ChatTurnAdmission } from "./chat-turn-admission.js";
import type { ChatTurnLease } from "./chat-turn-admission.js";
import {
  createChatRunInputAdmission,
  type ChatRunInputHooks,
  type ChatRunInputAdmissionRequest,
  type ChatRunInputAdmissionResult,
} from "./chat-run-input-admission.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { btwOperationRegistry, btwService } from "./rpiv-btw/service.js";
import { createPiCodemodeTool } from "./pi-codemode.js";
import { createPiToolDiscovery } from "./pi-tool-discovery.js";
import { NO_LATE_MCP_DISCOVERY, type McpLateDiscovery } from "./mcp-tool-discovery-core.js";
import { isPiCodemodeCallable, partitionPiCodemodeTools } from "./pi-runtime-tool.js";
import { createOnDemandTools } from "./on-demand-tools.js";
import {
  PiAgentRuntimeHarness,
  isPiManagedCancellationError,
  piAgentRuntimeExtensions,
  extensionSkillsPrompt,
  resolvePiAgentRuntimeContributionSnapshot,
  resolvePiAgentRuntimeStaticContributions,
  type PiAgentRuntimeExtension,
  type PiRuntimeStopEvent,
} from "./pi-agent-runtime-harness.js";
import {
  MEMORY_EXTENSION_ID,
  createMemoryExtension,
  authorizeMemoryProposal,
  authorizeMemoryRemoval,
  memoryMetadataForChat,
  memoryProvenanceForGeneration,
  memoryScopeForChat,
  REMEMBER_MEMORY_TOOL_NAME,
  FORGET_MEMORY_TOOL_NAME,
} from "./memory-context.js";
import { memoryStore } from "./memory-store-main.js";
import { memoryEnabledForChat } from "./memory-policy.js";
import { piUpgradeRolloutStore } from "./pi-upgrade-rollout-main.js";
import {
  piUpgradeBehaviorEnabledAtStartup,
  piUpgradeChatBehaviorEligible,
  piUpgradeMemoryEligible,
} from "./pi-upgrade-rollout.js";
import { isPackagedRuntime } from "../runtime-mode.js";
import type { MemoryProvenance, MemoryScope } from "./memory-store.js";
import { createPiModelImageReferences } from "./pi-model-image-references.js";
import {
  classifierApprovalFor,
  createPiModelTools,
  piModelOperationProviderLabel,
  piModelOperationsSystemPrompt,
  IMAGE_GENERATION_UNAVAILABLE_PROMPT,
  piModelOperationUsage,
} from "./pi-model-tools.js";
import {
  createDisplayImageExtensionRuntime,
  displayedAssistantImageUsage,
  DISPLAY_IMAGE_TOOL_NAME,
  shouldEnableImageGeneration,
  planModelOperationsForChat,
} from "./display-image-extension.js";
import { imageGeneration } from "./image-generation/runtime-main.js";
import {
  IMAGE_GENERATION_PROVIDER_NAMES,
  isImageGenerationProviderId,
  type ImageGenerationSnapshot,
} from "../../renderer/shared/image-generation/types.js";
import {
  CHAT_ARTIFACT_EVENT_VERSION,
  CHAT_ARTIFACT_VERSION,
  type ChatHtmlArtifactV1,
} from "../../renderer/shared/chat-artifacts.js";
import { MAX_HTML_ARTIFACTS_PER_RESPONSE } from "../../renderer/shared/generative-ui.js";
import { displayImageArtifactStore } from "./display-image-artifact-store.js";
import {
  createGenerativeUiExtensionRuntime,
  displayedAssistantHtmlUsage,
  GENERATIVE_UI_TOOL_NAME,
  shouldEnableGenerativeUiExtension,
} from "./generative-ui-extension.js";
import { createGenerativeUiDraftSession } from "./generative-ui-draft.js";
import { createUiDraftSession } from "./aiden-ui-draft.js";
import { withoutVisualSnapshots } from "../../renderer/shared/visual-snapshots.js";
import { displayedAssistantUiCount } from "./aiden-ui-tool.js";
import { visualSnapshotImages } from "./visual-snapshot-core.js";
import { enqueueVisualSnapshots } from "./visual-snapshot-service.js";
import type { ChatUiVisualV1 } from "../../renderer/shared/aiden-ui/types.js";
import { wrapGenerativeUiHtml } from "./generative-ui-html.js";
import { registerGenerativeUiPreviewDocument } from "./generative-ui-preview-store.js";
import { GENERATIVE_UI_EXTENSION_ID } from "./generative-ui-extension.js";
import { createArtifactPlacementLedger, imageAttachmentPlacements, presentPlacedImage } from "./generative-ui-placements.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { generationHasVisibleOutput } from "./generation-visible-output.js";
import { createGenerationHarness } from "./generation-harness.js";
import {
  resolveGenerationProfile,
  selectRuntimeExtensions,
  type DesignRunBinding,
  type GenerationProfile,
} from "./generation-profile.js";
import { designGenerationWiring, designRunOutcome } from "./design/design-generation.js";
import type { DesignRunOutcome } from "./design/store-core.js";
import {
  createAskUserQuestionExtension,
  resolveAskUserQuestionTimeoutMs,
  shouldEnableAskUserQuestionExtension,
} from "./ask-user-question-extension.js";
import {
  AskUserQuestionCoordinator,
  type AskUserQuestionRespondOutcome,
} from "./ask-user-question-coordinator.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../renderer/shared/ask-user-question.js";
import { createTodoExtension, shouldEnableTodoExtension } from "./rpiv-todo/extension.js";
import {
  createWorkspaceArtifactTool,
  WORKSPACE_ARTIFACT_TOOL_NAME,
  workspaceArtifactCallApproval,
  type WorkspaceArtifactCallApproval,
} from "./workspace-artifacts/tool.js";
import {
  notifyWorkspaceArtifactsChanged,
  workspaceArtifactRunner,
  workspaceArtifactStore,
} from "./workspace-artifacts/main.js";
import { TODO_TOOL_NAME } from "./rpiv-todo/contract.js";
import { loadDurableTodoSnapshot } from "./rpiv-todo/snapshot.js";
import { writeDiagnosticEvent } from "./diagnostic-journal.js";
import { todoSnapshotDiagnostic } from "./rpiv-todo/diagnostics.js";
import { todoSnapshotForRenderer } from "../../renderer/shared/todo.js";
import { chatProgressEvents } from "./chat-progress-events.js";
import { GenerationDeltaCoalescer } from "./generation-delta-coalescer.js";

subagentRuntimeRegistry.setHealthMetrics(subagentHealthMetrics);
subagentRuntimeRegistry.setLimits({
  usageLimits: (owner, providerLabel, extra) => usageLimits.streamOptions(owner, providerLabel, extra),
  spending,
});
subagentRuntimeRegistry.setRuntimeFaultReporter((source) => {
  logger.warn("subagents", `Pi child runtime fault (${source}).`);
});

type GenerationPermission = WorkspacePermission | "read-only";

/**
 * Per stream, the command digest each allowed workspace_artifact approval card
 * showed, by tool call id. The tool consumes its entry first thing, and only
 * a save whose commands match that digest records an approval. A stream's
 * entries go when it ends.
 */
const approvedWorkspaceArtifactCalls = new Map<string, Map<string, string>>();

function takeApprovedWorkspaceArtifactCall(streamId: string, toolCallId: string): string | undefined {
  const calls = approvedWorkspaceArtifactCalls.get(streamId);
  const digest = calls?.get(toolCallId);
  calls?.delete(toolCallId);
  return digest;
}

function uniqueResponseImages(
  sharedImages: readonly Attachment[],
  displayedImages: readonly Attachment[],
): Attachment[] {
  const images = [...sharedImages];
  for (const attachment of displayedImages) {
    if (images.some((item) => item.id === attachment.id || item.data === attachment.data)) {
      continue;
    }
    images.push(attachment);
  }
  return images;
}


export interface GenerationExecutionOptions {
  /** Main-owned Telegram queue provenance, resolved freshly at generation. */
  telegramSkillInvocation?: import("./telegram/telegram-queue.js").TelegramSkillInvocation;
  /** Internal-only execution policy. Renderer chat starts always use the workspace permission. */
  permission?: GenerationPermission;
  /** Scheduled and other background runs can withhold tools that would recurse or mutate. */
  excludeToolNames?: ReadonlySet<string>;
  /** Computer Use always requires a live renderer approval surface unless explicitly enabled. */
  allowComputerUse?: boolean;
  /** Privacy-safe accounting category for this model call. */
  usageSource?: UsageRequestSource;
  /** Withhold connector tools when their mutation semantics cannot be enforced. */
  allowMcpTools?: boolean;
  /** Exact MCP server identities approved for an unattended generation. */
  mcpServerIds?: readonly string[];
  /** Exact main-owned MCP connection fingerprints approved for this run. */
  mcpServerBindings?: readonly import("./types.js").ScheduledMcpServerBinding[];
  /** Exact Assistant-approved inference connection fingerprint. */
  providerFingerprint?: string;
  /** Internal foreground policy; scheduled/background callers explicitly disable delegation. */
  allowSubagents?: boolean;
  /** Main-owned lease token spanning user-message persistence through generation registration. */
  turnId?: string;
  /** Fires once the persisted turn has synchronously transferred to generation ownership. */
  onTurnAccepted?: () => void;
  /** Main-owned interactive delivery surface; renderer starts cannot set this. */
  interactionSurface?: "telegram";
  /** Main-owned: a paired device sent this turn and sees visuals as snapshots. */
  visualAudience?: "remote";
  /** Main-owned stable principal used for the versioned Bot Full Access notice. */
  botAudienceId?: string;
  /** Main-only Design Studio run; parseParams can never produce it (ADR-DS §4). */
  designRun?: DesignRunBinding;
  /**
   * Main-owned follow-up turn nobody is watching (a background job ended, a
   * followed pull request or a "done when" check needs the agent). Approvals
   * and questions are unavailable for the whole turn.
   */
  unattended?: boolean;
}

interface BotGenerationAuthorityContext {
  admission: BotRuntimeAuthorityAdmission;
  prepared: PreparedBotGeneration<ResolvedModelRuntime>;
}

interface LoadMonitorState {
  monitor: LocalModelLoadMonitor;
  readyEmitted: boolean;
}

interface ActiveGeneration {
  agent: PiAgentRuntimeHarness;
  chatId: string;
  owner: ChatGenerationOwner;
  removeOwnerInvalidation: () => void;
  stopCacheWarming?: () => void;
  workspaceId?: string;
  cancelRequested: boolean;
  cancellationOrigin?: GenerationCancellationOrigin;
  rendererDetached: boolean;
  computerUse?: ComputerUseController;
  /** Set when a computer_use or fill_form call first reaches the access gate. */
  computerUseActivated?: boolean;
  formFill?: FormFillService;
  completion: Promise<void> | null;
  loadMonitor?: LoadMonitorState;
  releaseSkillReservation: () => void;
  releaseBotAuthority: () => void;
  /** Runs that take no mid-flight input (Design Studio). */
  inputClosed: boolean;
  /** A steered send stops this run's still-running subagents. */
  stopSubagentsForGuidance?: () => void;
  /** UserPromptSubmit for mid-flight input, in a chat that runs hooks. */
  inputHooks?: ChatRunInputHooks;
}

const active = new Map<string, ActiveGeneration>();
const CHAT_CANCEL_SETTLEMENT_GRACE_MS = 5_000;
const WORKSPACE_CANCEL_SETTLEMENT_GRACE_MS = 5_000;
const initializing = new Map<
  string,
  {
    chatId: string;
    owner: ChatGenerationOwner;
    removeOwnerInvalidation: () => void;
    stopCacheWarming?: () => void;
    workspaceId?: string;
    cancelRequested: boolean;
    cancellationOrigin?: GenerationCancellationOrigin;
    rendererDetached: boolean;
    controller: AbortController;
    computerUse?: ComputerUseController;
    formFill?: FormFillService;
    loadMonitor?: LoadMonitorState;
    releaseSkillReservation: () => void;
    releaseBotAuthority: () => void;
  }
>();
const computerUseGenerationGate = new ComputerUseGenerationGate();
const chatDeletionGate = new ChatDeletionGate();
const chatWorkspaceMutationGate = new ChatWorkspaceMutationGate();
const runInputAdmission = createChatRunInputAdmission({
  active,
  isChatDeleting: (chatId) => chatDeletionGate.isDeleting(chatId),
  appendMessage: (chatId, message, meta) => chatStore.appendMessage(chatId, message, meta),
  readChat: (chatId) => chatStore.get(chatId),
});
const chatCopyGate = new ChatWorkspaceMutationGate();
const chatTurnAdmission = new ChatTurnAdmission();
const geminiContextCache = new GeminiContextCache({
  onWarning: (message, error) => logger.warn("pi", message, error),
});

/**
 * Work that holds the chat's turn. A cancelled subagent that is still draining
 * is left out: its parent already settled it, so it must not trap queued sends
 * or new turns behind a stuck provider stream.
 */
function chatHasGenerationOwnership(chatId: string): boolean {
  return (
    [...initializing.values()].some((entry) => entry.chatId === chatId) ||
    [...active.values()].some((entry) => entry.chatId === chatId) ||
    subagentRuntimeRegistry.hasLiveChatChildren(chatId)
  );
}

/** A started turn, or the chat's turn is held by live generation work. */
function chatTurnIsHeld(chatId: string): boolean {
  return chatTurnAdmission.isAdmitted(chatId) || chatHasGenerationOwnership(chatId);
}

/**
 * Wait until `busy()` is false, waking early once the chat's running
 * generations complete. False when the settlement grace ran out first.
 */
async function waitForChatSettlement(chatId: string, busy: () => boolean): Promise<boolean> {
  const deadline = Date.now() + CHAT_CANCEL_SETTLEMENT_GRACE_MS;
  while (busy()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const completions = [...active.values()]
      .filter((entry) => entry.chatId === chatId && entry.completion)
      .map((entry) => entry.completion!);
    const pause = new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    if (completions.length > 0) {
      await Promise.race([Promise.allSettled(completions), pause]);
    } else {
      await pause;
    }
  }
  return true;
}

/** Cancel every starting and running generation of the chat, and its subagents. */
function cancelChatGenerations(chatId: string, origin: GenerationCancellationOrigin): void {
  for (const [streamId, entry] of [...initializing.entries()]) {
    if (entry.chatId === chatId) llmClient.cancel(streamId, origin);
  }
  for (const [streamId, entry] of [...active.entries()]) {
    if (entry.chatId === chatId) llmClient.cancel(streamId, origin);
  }
  subagentRuntimeRegistry.abortChat(chatId);
}

function releaseGenerationSkillReservation(entry: { releaseSkillReservation: () => void }): void {
  const release = entry.releaseSkillReservation;
  entry.releaseSkillReservation = () => {};
  release();
}

function releaseGenerationBotAuthority(entry: { releaseBotAuthority: () => void }): void {
  const release = entry.releaseBotAuthority;
  entry.releaseBotAuthority = () => {};
  release();
}

function botWorkspacePromptAuthority(
  context: BotGenerationAuthorityContext,
  roots: readonly BotRuntimeApprovedRoot[],
): BotWorkspacePromptAuthority {
  const { files } = context.admission.authority;
  if (files.mode === "full_mac") {
    return { mode: "full_mac", botHome: files.botHome };
  }
  if (files.mode === "off") return { mode: "off", botHome: false };
  return {
    mode: "scoped",
    botHome: files.botHome,
    approvedRoots: roots.map(({ root }) => root),
  };
}

function botHasOrdinaryCapability(
  context: BotGenerationAuthorityContext,
  kind: "web" | "browser" | "computer_use" | "computer" | "schedules" | "subagents" | "tasks",
): boolean {
  return context.admission.authority.otherCapabilities.some((grant) => grant.kind === kind);
}

async function prepareBotSkillAuthority(
  context: BotGenerationAuthorityContext,
  snapshot: SkillRegistrySnapshot,
  currentSkills: Parameters<typeof exactBotSkillToolNames>[1],
): Promise<{ snapshot: SkillRegistrySnapshot; toolNames: ReadonlySet<string> }> {
  const resolved = await resolveBotRuntimeSkills(context.admission.authority.botId);
  const allowedToolNames = exactBotSkillToolNames(
    context.admission.authority,
    currentSkills,
    resolved,
    snapshot,
  );
  // Prove the captured instructions still correspond to the admitted catalog
  // before either prompt resources or tool schemas can expose them.
  await context.admission.revalidateBeforeEffect();
  return {
    snapshot: filterBotSkillSnapshot(snapshot, allowedToolNames, context.admission),
    toolNames: allowedToolNames,
  };
}

const notifyWorkspaceFilesTouched = createWorkspaceFilesTouchedNotifier({
  // A skill the agent just wrote must not be hidden by the registry's short-lived snapshot.
  invalidate: (workspaceId) => skillRegistry.invalidate(workspaceId),
  broadcast: (workspaceId) => ipcMain.broadcast("workspace:files-touched", { workspaceId }),
});

function broadcastChatSettled(
  streamId: string,
  chatId: string,
  workspaceId: string | undefined,
  fallbackWorkspaceId: string | undefined,
): void {
  chatActivityRegistry.settle(streamId);
  recordRunSettled(hostRunRegistry, streamId);
  chatProgressEvents.settle(chatId, streamId);
  const normalizedWorkspaceId = persistedChatWorkspaceId(workspaceId ?? fallbackWorkspaceId);
  if (!isSafeSubagentIdentifier(chatId) || !isSafeSubagentIdentifier(normalizedWorkspaceId)) {
    return;
  }
  ipcMain.broadcast("chats:settled", {
    chatId,
    workspaceId: normalizedWorkspaceId,
  });
}

function queuedGuidanceText(messages: readonly { role: string; content?: unknown }[]): string[] {
  return messages.flatMap((message) =>
    message.role === "user" && typeof message.content === "string" && message.content.trim()
      ? [message.content]
      : [],
  );
}

/**
 * Guidance whose visible save Stop stopped waiting for, and which then did not
 * land. The stream's terminal has already been sent, so it goes to the window
 * that owned the stream on its own channel.
 */
export function returnLateGuidance(
  owner: Pick<ChatGenerationOwner, "kind" | "isDestroyed" | "send"> | undefined,
  chatId: string,
  streamId: string,
  guidance: string[],
): void {
  if (guidance.length === 0) return;
  // Steer is desktop-only; a paired-device owner has no draft to restore into.
  if (!owner || owner.kind === "remote" || owner.isDestroyed()) {
    logger.warn("pi", `Late guidance for stream ${streamId} had no window to return to.`);
    return;
  }
  try {
    owner.send("chat:guidance-returned", { chatId, streamId, undeliveredGuidance: guidance });
  } catch (error) {
    logger.warn("pi", `Could not return late guidance for stream ${streamId}.`, error);
  }
}

function ownerForStream(streamId: string): ChatGenerationOwner | undefined {
  return active.get(streamId)?.owner ?? initializing.get(streamId)?.owner;
}

const deltaCoalescer = new GenerationDeltaCoalescer();

function sendGeneration(streamId: string, channel: NotificationChannel, payload: unknown): boolean {
  const chatId = active.get(streamId)?.chatId ?? initializing.get(streamId)?.chatId;
  if (chatId && channel === "chat:todo") {
    const snapshot = (
      payload as { snapshot?: import("../../renderer/shared/todo.js").TodoSnapshotViewV1 }
    )?.snapshot;
    if (snapshot) chatProgressEvents.durableTodo(chatId, streamId, snapshot);
  } else if (chatId && channel === "chat:subagents") {
    chatProgressEvents.changed(chatId);
  }
  // Journal before delivery so a run whose window went away stays observable.
  // Prompts are journaled by their coordinators only once delivery succeeds.
  if (channel !== "chat:approval" && channel !== "chat:questionnaire") {
    recordRunNotification(hostRunRegistry, streamId, channel, payload);
  }
  const owner = ownerForStream(streamId);
  if (!owner || owner.isDestroyed()) {
    deltaCoalescer.discard(streamId);
    return false;
  }
  // Renderer documents receive text and reasoning deltas in short batches;
  // paired devices and headless owners keep per-delta delivery.
  if (owner.kind !== "remote" && owner.id !== 0) {
    if (deltaCoalescer.push(streamId, channel, payload, owner)) return true;
  }
  // Every other notification follows the deltas that preceded it.
  deltaCoalescer.flush(streamId);
  try {
    owner.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

function endLoadMonitor(
  entry: { loadMonitor?: LoadMonitorState } | undefined,
  streamId: string,
  emitReadyIfLoading: boolean,
): void {
  const state = entry?.loadMonitor;
  if (!state) return;
  const wasLoading = state.monitor.announcedLoading;
  state.monitor.stop();
  entry.loadMonitor = undefined;
  if (emitReadyIfLoading && wasLoading && !state.readyEmitted) {
    state.readyEmitted = true;
    sendGeneration(streamId, "chat:status", {
      streamId,
      phase: "model_ready",
    });
  }
}

// What a foreground reply is waiting on is saved so a restart can offer it
// again. A crash never settles the card; a quit withdraws it while
// `quitInProgress` is set, before any window closes, so it stays saved. Any
// other settlement removes it. It is offered only when the chat's latest run
// was cut short by that quit or crash.
let quitInProgress = false;
function rememberInterruptedWait(
  streamId: string,
  wait: Parameters<typeof interruptedWaits.remember>[1],
): void {
  const chatId = active.get(streamId)?.chatId;
  if (!chatId) return;
  void interruptedWaits.remember(chatId, wait).catch((error: unknown) => {
    logger.warn("pi", "Could not save what the reply is waiting on.", error);
  });
}
function forgetInterruptedWait(waitId: string): void {
  void interruptedWaits.forget(waitId).catch((error: unknown) => {
    logger.warn("pi", "Could not clear what the reply was waiting on.", error);
  });
}

const approvals = new ToolApprovalCoordinator(
  (prompt) => {
    if (!sendGeneration(prompt.streamId, "chat:approval", prompt)) {
      throw new Error("The generation's renderer document is no longer active.");
    }
    chatActivityRegistry.requestAttention(prompt.approvalId, prompt.streamId, "approval");
    recordRunNotification(hostRunRegistry, prompt.streamId, "chat:approval", prompt);
    rememberInterruptedWait(prompt.streamId, {
      kind: "approval",
      waitId: prompt.approvalId,
      askedAt: Date.now(),
      summary: clipInterruptedWaitSummary(prompt.summary),
    });
  },
  (approvalId, outcome) => {
    if (
      interruptedWaitSettled({ byPerson: outcome === "allowed" || outcome === "denied", quitting: quitInProgress })
    ) {
      forgetInterruptedWait(approvalId);
    }
    chatActivityRegistry.resolveAttention(approvalId);
    recordRunAttentionResolved(hostRunRegistry, approvalId, {
      kind: "approval",
      decision: outcome === "allowed" ? "allow" : outcome === "denied" ? "deny" : "cancelled",
    });
  },
);
const questionnaires = new AskUserQuestionCoordinator(
  (prompt) => {
    if (!sendGeneration(prompt.streamId, "chat:questionnaire", prompt)) {
      throw new Error("The generation's renderer document is no longer active.");
    }
    chatActivityRegistry.requestAttention(prompt.promptId, prompt.streamId, "input");
    recordRunNotification(hostRunRegistry, prompt.streamId, "chat:questionnaire", prompt);
    rememberInterruptedWait(prompt.streamId, {
      kind: "question",
      waitId: prompt.promptId,
      askedAt: Date.now(),
      questions: prompt.questions,
    });
  },
  (promptId, response, settledBy) => {
    if (
      interruptedWaitSettled({ byPerson: settledBy === "owner", timedOut: response.timedOut, quitting: quitInProgress })
    ) {
      forgetInterruptedWait(promptId);
    }
    chatActivityRegistry.resolveAttention(promptId);
    recordRunAttentionResolved(hostRunRegistry, promptId, {
      kind: "question",
      outcome: response.timedOut ? "expired" : response.cancelled ? "cancelled" : "answered",
    });
  },
);
// A parent can be waiting for a child that is still constructing its tools.
// Give the child's own bounded cancellation drain time to report a cleanup
// miss before the outer parent shutdown deadline can release a soak receipt.
const SHUTDOWN_GENERATION_GRACE_MS = DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS + 1_000;

function resetGenerationAgent(agent: PiAgentRuntimeHarness, streamId: string): void {
  try {
    agent.reset();
  } catch (error) {
    logger.warn("pi", `Could not eagerly reset stream ${streamId}.`, error);
  }
}

function savedGenerationThinkingLevel(
  settings: Awaited<ReturnType<typeof configStore.getSettings>>,
  providerId: string,
  model: string,
  provider: Pick<StoredProvider, "isBuiltin" | "kind" | "modelMetadata">,
) {
  return providerId === GOOGLE_PROVIDER_ID
    ? settings.googleThinkingByModel?.[model]
    : providerId === OPENAI_CODEX_PROVIDER_ID
      ? settings.codexThinkingByModel?.[model]
      : providerId === ANTHROPIC_PROVIDER_ID
        ? settings.anthropicThinkingByModel?.[model]
        : provider.isBuiltin ||
            (provider.kind === "openai" &&
              customModelThinkingLevels(provider.modelMetadata?.[model]?.overrides))
          ? settings.providerThinkingByModel?.[providerId]?.[model]
          : undefined;
}

/**
 * A ready inline preview for a just-presented visual, so the renderer swaps
 * the draft for a loaded document. The guest asks for the live theme on
 * load. Best effort: without it the renderer fetches a preview as usual.
 */
function readyPreviewSrc(title: string, html: string): { src?: string } {
  try {
    return {
      src: registerGenerativeUiPreviewDocument(
        wrapGenerativeUiHtml(html, title, undefined, { inline: true }),
      ),
    };
  } catch {
    return {};
  }
}

/**
 * The workspace codemode lane: MCP tools are deferred behind codemode and
 * tool_search instead of declared to the provider. Decided once before tool
 * discovery (to defer slow MCP servers) and again when composing extensions,
 * so both must agree.
 */
function workspaceCodemodeEnabled(input: {
  workspaceId: string | undefined;
  folderPath: string | undefined;
  bot: boolean;
  mode: unknown;
  permission: GenerationPermission;
  excludeToolNames: ReadonlySet<string> | undefined;
}): boolean {
  return Boolean(input.workspaceId && input.folderPath) && !input.bot && input.mode === undefined &&
    input.permission !== "none" && !input.excludeToolNames?.has("codemode");
}

async function prepareGeneration(
  streamId: string,
  params: ChatStartParams & { workspaceId: string },
  chat: Chat,
  botContext: BotGenerationAuthorityContext | undefined,
  signal: AbortSignal,
  computerUseGateSnapshot: number,
  ownComputerUse: (controller: ComputerUseController) => void,
  ownerDocumentId: string,
  rendererOwner: boolean,
  browserOwner: ChatGenerationOwner,
  options: GenerationExecutionOptions,
) {
  const sharedImages: Attachment[] = [];
  const displayedImages: Attachment[] = [];
  const displayedImageIds = new Set<string>();
  const appPanels: AppControlPanel[] = [];
  const displayedHtmlArtifacts: ChatHtmlArtifactV1[] = [];
  const displayedHtmlIds = new Set<string>();
  /** mediaId → the render_artifact call it renders after. */
  const htmlArtifactPlacements = createArtifactPlacementLedger();
  const displayedUiVisuals: ChatUiVisualV1[] = [];
  /** visual id → the render_ui call it renders after. */
  const uiVisualPlacements = createArtifactPlacementLedger();
  /** generated image attachment id → the generate_image call it renders after. */
  const imagePlacements = createArtifactPlacementLedger();
  const generationExtensions: PiAgentRuntimeExtension[] = [];
  const responseImages = () => uniqueResponseImages(sharedImages, displayedImages);
  const modelImageReferences = createPiModelImageReferences({
    snapshot: chat.messages.flatMap((message) => withoutVisualSnapshots(message.attachments ?? [])),
    generated: responseImages,
    readCurrent: async (referenceSignal) => {
      signal.throwIfAborted();
      referenceSignal?.throwIfAborted();
      const current = await chatStore.get(params.chatId);
      signal.throwIfAborted();
      referenceSignal?.throwIfAborted();
      if (!current || persistedChatWorkspaceId(current.workspaceId) !== persistedChatWorkspaceId(params.workspaceId)) throw new Error("The reference image chat is no longer available in this workspace.");
      return current.messages.flatMap((message) => withoutVisualSnapshots(message.attachments ?? []));
    },
  });
  const shareImage = (attachment: Attachment, toolCallId: string) => {
    const existing = responseImages();
    if (existing.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error("This response already contains the maximum number of images.");
    }
    if (existing.some((item) => item.id === attachment.id || item.data === attachment.data)) {
      return;
    }
    const nextBytes = existing.reduce((sum, item) => sum + item.size, 0) + attachment.size;
    if (nextBytes > MAX_ATTACHMENT_INLINE_BYTES) {
      throw new Error("The images shared in this response exceed the 16 MB limit.");
    }
    sharedImages.push(attachment);
    if (attachment.kind !== "image" || attachment.data === undefined) {
      imagePlacements.record(attachment.id, toolCallId);
      return;
    }
    // Shown live at the sharing call's row, like a displayed image.
    const { id, name, mimeType, size, data } = attachment;
    presentPlacedImage(
      imagePlacements,
      { version: CHAT_ARTIFACT_VERSION, kind: "image", attachment: { id, name, mimeType, kind: "image", size, data } },
      toolCallId,
      (event) => {
        sendGeneration(streamId, "chat:artifact", { streamId, event });
      },
    );
  };
  const runtime =
    botContext?.prepared.runtime ??
    (await resolveModelRuntime(params.providerId, params.model, signal, chat.id));

  if (options.designRun) {
    // A design run composes exactly its binding's extension (designGenerationWiring);
    // createGenerationHarness refuses any other extension, tool or skill (ADR-DS §4).
    const designSettings = await configStore.getSettings();
    const designModel = runtime.model;
    return {
      runtime: { ...runtime, model: designModel },
      agentsInstructions: undefined,
      agentsInstructionRoots: undefined,
      browserDiscovery: undefined,
      browserSelection: { initialized: false } as { initialized: boolean; tabId?: string },
      browserFileApprovals: new Map<string, PreparedBrowserFile>(),
      browserActionApprovals: new Map<
        string,
        { approval: BrowserToolApproval; args: Record<string, unknown> }
      >(),
      permission: "none" as GenerationPermission,
      folderPath: undefined,
      git: await generationGitContext(undefined, signal),
      tools: [] as AgentTool[],
      generationExtensions,
      modelImageReferences,
      lateMcpDiscovery: NO_LATE_MCP_DISCOVERY as McpLateDiscovery,
      displayedImages,
      displayedHtmlArtifacts,
      appPanels,
      htmlArtifactPlacements,
      imagePlacements,
      displayedUiVisuals,
      uiVisualPlacements,
      supportsImages: runtimeSupportsImages(designModel),
      thinkingLevel: resolveGenerationThinkingLevel(
        params.providerId,
        designModel,
        params.thinkingLevel ?? savedGenerationThinkingLevel(designSettings, params.providerId, params.model, runtime.provider),
      ),
      computerUse: undefined,
      formFill: undefined,
      googleWorkspaceSnapshot: undefined,
      skillSnapshot: undefined,
      workspaceId: undefined,
      subagentSupervisor: undefined,
      showLocalModelReasoning: designSettings.showLocalModelReasoning,
      compactionEngine: compactionEngineFrom(designSettings.compactionEngine),
      compactionModelOverrides: designSettings.compactionModelOverrides,
      cacheWarmingEnabled: false,
      sharedImages,
      botContext: undefined,
      botApprovedRoots: [] as string[],
      botMutatingToolNames: new Set<string>(),
    };
  }
  const botBound = botContext !== undefined;
  const botApprovedRoots = botContext
    ? await resolveBotRuntimeApprovedRoots(botContext.admission.authority)
    : [];
  const botRuntimeCatalog = botContext
    ? await resolveBotRuntimeCatalogSnapshot(botContext.admission.authority, signal)
    : undefined;
  const attendedAssistant = params.mode === "assistant";
  const assistantPersonaMode =
    params.mode === "assistant" || params.mode === "assistant-unattended";
  const assistantAutomationMode = params.mode === "assistant-automation";
  const assistantMode = assistantPersonaMode || assistantAutomationMode;
  if (
    shouldEnableAskUserQuestionExtension({
      usageSource: options.usageSource,
      interactionSurface: options.interactionSurface,
      assistantMode,
      botBound,
      rendererOwner,
      remoteOwner: browserOwner.kind === "remote",
      excluded: options.excludeToolNames?.has(ASK_USER_QUESTION_TOOL_NAME) ?? false,
    })
  ) {
    generationExtensions.push(
      createAskUserQuestionExtension({
        request: (toolCallId, questions, requestSignal, timeoutSeconds) =>
          questionnaires.request(
            {
              streamId,
              toolCallId,
              questions,
              timeoutMs: resolveAskUserQuestionTimeoutMs(timeoutSeconds, {
                unattended: browserOwner.kind === "remote",
              }),
            },
            ownerDocumentId,
            requestSignal,
          ),
      }),
    );
  }
  // The dock persona is never folder-scoped. Project automation mode is
  // main-only and reaches this branch only after the persisted approval profile
  // has bound the scheduled run to a workspace.
  const workspace =
    botContext?.prepared.workspace ??
    (params.workspaceId && !assistantPersonaMode
      ? await configStore.getWorkspace(params.workspaceId)
      : undefined);
  if (workspace && !botBound) {
    await restoreNoWorkspaceFolder(workspace);
    // Name a moved or deleted folder before any tool fails without saying why.
    await assertWorkspaceFolderPresent(workspace);
    await assertManagedWorktreeAdmission(workspace);
  }
  const permission: GenerationPermission = options.permission ?? workspace?.permission ?? "ask";
  const folderPath = workspace?.folderPath;
  // Connectors this workspace switched off. Bots keep their own grants.
  const workspaceDisabledMcpServerIds = botBound ? undefined : workspace?.disabledMcpServerIds;
  // Bot and Assistant prompts retain their exact, separately granted sources.
  const agentsInstructionRoots = !botBound && !assistantMode
    ? {
        globalRoot: aidenConfigDir(),
        workspaceRoot: permission !== "none" && workspace?.permission !== "none" ? folderPath : undefined,
      }
    : undefined;
  const agentsInstructions = agentsInstructionRoots
    ? await createAgentsInstructionRefresher({
        ...agentsInstructionRoots,
        onNotices: (notices) => {
          sendGeneration(streamId, "chat:status", { streamId, phase: "agents_instructions_limited", notices });
        },
        revalidate: async (requestSignal) => {
          signal.throwIfAborted();
          requestSignal?.throwIfAborted();
          if (!workspace) return;
          const current = await configStore.getWorkspace(workspace.id);
          if (!current || current.folderPath !== workspace.folderPath || current.permission !== workspace.permission) {
            throw new Error("Workspace instruction access changed. Start a new response.");
          }
          await assertManagedWorktreeAdmission(current);
          signal.throwIfAborted();
          requestSignal?.throwIfAborted();
        },
      })
    : undefined;
  if (agentsInstructions) {
    generationExtensions.push({
      id: "aiden.agents-instruction-scope",
      beforeProviderRequest: async (_context, requestSignal) => {
        await agentsInstructions.assertCurrent(requestSignal);
        return undefined;
      },
    });
  }
  const git = await generationGitContext(
    permission !== "none" && (!botContext || botContext.admission.authority.files.botHome)
      ? folderPath
      : undefined,
    signal,
  );
  // The resolved runtime model is the connection-bound capability authority.
  // Display metadata must not re-enable an input that Pi or discovery rejected.
  const model = runtime.model;
  assertCustomModelImageLimit(
    runtime.provider.modelMetadata?.[model.id]?.overrides,
    runtimeSupportsImages(model) ? chat.messages : chat.messages.slice(-1),
  );
  assertScheduledGenerationProvider(params.mode, runtime.provider, options.providerFingerprint);
  const assistantModelSelection = {
    providerId: runtime.provider.id,
    providerName: runtime.provider.label,
    model: model.id,
    modelName: model.name,
    providerFingerprint: scheduledProviderFingerprint(runtime.provider),
  };
  const supportsImages = runtimeSupportsImages(model);
  const settings = await configStore.getSettings();
  const savedThinkingLevel = savedGenerationThinkingLevel(settings, params.providerId, params.model, runtime.provider);
  const thinkingLevel = resolveGenerationThinkingLevel(
    params.providerId,
    model,
    params.thinkingLevel ?? savedThinkingLevel,
  );
  // With the beta on, the model always gets the tool on a build and OS that
  // can run it (a cheap static check; no driver probe here). Access is asked
  // once per chat on its first call (see computer-use/access-gate.ts), and the
  // controller only starts its driver host on first use, so readiness is
  // checked there rather than here. Offering the tool does not count as using
  // Computer Use: the stream is activated only on its first call.
  let computerUse: ComputerUseController | undefined;
  if (
    computerUseSupported() &&
    computerUseCanEverRun() &&
    options.allowComputerUse !== false &&
    (!botContext || botHasOrdinaryCapability(botContext, "computer_use")) &&
    settings.computerUseEnabled === true &&
    computerUseGenerationGate.isCurrent(computerUseGateSnapshot)
  ) {
    computerUse = createComputerUseController(streamId, supportsImages);
    ownComputerUse(computerUse);
  }
  // The Form Fill Specialist is layered on Computer Use: it exists only when
  // CU itself is available and ready for this generation, the user enabled the
  // specialist, and the verified model package is already on disk (status is
  // offline).
  let formFill: FormFillService | undefined;
  const sourceAttachments = currentFormFillAttachments(chat.messages);
  if (FORM_FILL_MUTATION_AVAILABLE && computerUse && settings.formFillSpecialistEnabled === true && sourceAttachments.length) {
    const status = await computerUseStatus.status({ signal });
    const artifact = status.ready && computerUseGenerationGate.isCurrent(computerUseGateSnapshot)
      ? await formFillArtifacts.refresh()
      : undefined;
    if (artifact?.state === "ready") {
      formFill = new FormFillService({
        controller: computerUse,
        scorer: formFillRuntime,
        attachmentResolver: () => sourceAttachments,
        owner: { chatId: chat.id, generationId: streamId, documentId: ownerDocumentId },
      });
    }
  }
  const toolPermission: WorkspacePermission = permission === "read-only" ? "full" : permission;
  const allowSubagents = subagentsAllowedForGeneration({
    assistantMode,
    providerId: params.providerId,
    allowSubagents:
      options.allowSubagents !== false &&
      (!botContext || botHasOrdinaryCapability(botContext, "subagents")),
    usageSource: options.usageSource,
    excludedToolNames: options.excludeToolNames,
    workspaceId: workspace?.id,
    folderPath,
    permission,
  });
  const childWebRollout = subagentChildWebEnabled();
  const childMcpRollout = subagentChildMcpEnabled();
  const childMcpMutationsRollout = subagentChildMcpMutationsEnabled();
  const childWriteRollout = subagentChildWriteEnabled();
  const childShellRollout = subagentChildShellEnabled();
  const childDelegationRollout = subagentChildDelegationEnabled();
  const subagentWriteEnabled =
    subagentWorkspaceWriteAllowedForGeneration({
      subagentsAllowed: allowSubagents,
      childWriteRollout,
      v2StoreSelected: subagentRunStore.selection === "v2",
      workspacePermission: workspace?.permission,
      generationPermission: permission,
    }) &&
    (!botContext || botContext.admission.authority.files.botHome);
  const subagentWebAvailability =
    allowSubagents &&
    childWebRollout &&
    (!botContext || botHasOrdinaryCapability(botContext, "web"))
      ? await webSearchService.availability()
      : undefined;
  const subagentWebEnabled = subagentWebAvailability?.ready === true;
  const discoveredSubagentMcpInventory =
    allowSubagents && childMcpRollout && subagentRunStore.selection === "v2"
      ? await resolveProductionSubagentMcpInventory(signal)
      : [];
  const botSubagentMcpConnectionIdentities =
    botContext && discoveredSubagentMcpInventory.length > 0
      ? await resolveBotRuntimeMcpConnectionIdentities(signal)
      : [];
  const subagentMcpInventory = botContext
    ? filterExactBotSubagentMcpInventory(
        botContext.admission.authority,
        discoveredSubagentMcpInventory,
        botSubagentMcpConnectionIdentities,
      )
    : discoveredSubagentMcpInventory.filter(
        (scope) => !workspaceDisabledMcpServerIds?.includes(scope.serverId),
      );
  const subagentShellBinary = resolveSubagentShellRunnerBinary();
  const subagentShellEnabled =
    allowSubagents &&
    childShellRollout &&
    subagentRunStore.selection === "v2" &&
    workspace?.permission !== "none" &&
    (permission === "ask" || permission === "full") &&
    (!botContext || botContext.admission.authority.shell.enabled) &&
    (await access(subagentShellBinary).then(
      () => true,
      () => false,
    ));
  const subagentDelegationEnabled =
    allowSubagents &&
    childDelegationRollout &&
    subagentRunStore.selection === "v2" &&
    workspace?.permission !== "none" &&
    permission !== "none" &&
    !botContext;
  const subagentReadCeiling =
    botContext && !botContext.admission.authority.files.botHome
      ? []
      : inheritedSubagentReadToolCeiling(options.excludeToolNames);
  let subagentProjector: SubagentEventProjector | undefined;
  const subagentPersistence =
    allowSubagents && workspace && folderPath
      ? createForegroundSubagentPersistenceV2({
          store: subagentRunStore,
          generationId: streamId,
          chatId: params.chatId,
          workspace,
          runtime: { ...runtime, model },
          thinkingLevel,
          ownerDocumentId,
          permission: workspace.permission,
          generationPermission: permission,
          writeEnabled: subagentWriteEnabled,
          webEnabled: subagentWebEnabled,
          mcpInventory: subagentMcpInventory,
          mcpMutationsEnabled: childMcpMutationsRollout,
          mcpMutationHost: productionSubagentMcpMutationHost,
          shellEnabled: subagentShellEnabled,
          shellBinary: subagentShellEnabled ? subagentShellBinary : undefined,
          delegationEnabled: subagentDelegationEnabled,
          requestApproval: (descriptor, approvalSignal, approvalOwnerDocumentId) =>
            approvals
              .request(descriptor, approvalSignal, approvalOwnerDocumentId)
              .then((outcome) => outcome === "allowed"),
          currentWorkspace: async (workspaceId) =>
            botContext && workspaceId === workspace.id
              ? { ...workspace }
              : configStore.getWorkspace(workspaceId),
          validateWorkspace: async (candidate) => {
            if (!botContext) return assertManagedWorktreeAdmission(candidate);
            if (candidate.id !== workspace.id || candidate.folderPath !== workspace.folderPath) {
              throw new Error("The Bot subagent workspace changed.");
            }
            await botManagedWorkspace.revalidate(botContext.prepared.managedWorkspace);
          },
          workspaceOperationRegistry,
          control: subagentRunStore.selection === "v2" ? subagentControlMainV2 : undefined,
          applyControlSnapshot: (snapshot) => {
            if (!subagentProjector) {
              throw new Error("Subagent control projector is unavailable.");
            }
            return subagentProjector.applyControlSnapshot(snapshot);
          },
          currentControlSnapshot: (runId) => {
            const snapshot = subagentProjector
              ?.snapshot()
              .find((candidate) => candidate.runId === runId);
            if (!snapshot) {
              throw new Error("Subagent control projector state is unavailable.");
            }
            return snapshot;
          },
          settleControlSnapshots: () =>
            subagentProjector?.flush() ??
            Promise.reject(new Error("Subagent control projector is unavailable.")),
          onControlSnapshot: (snapshot) => {
            sendGeneration(streamId, "chat:subagents", { streamId, snapshot });
          },
        })
      : undefined;
  if (allowSubagents && workspace && subagentPersistence) {
    subagentProjector = new SubagentEventProjector({
      generationId: streamId,
      chatId: params.chatId,
      workspaceId: workspace.id,
      modelId: model.id,
      contextWindow: model.contextWindow,
      // Presentation-only: bypasses persistence and the Remote progress
      // revision, which only track durable snapshots.
      onContextUsage: (runId, usage) => {
        sendGeneration(streamId, "chat:subagent-context", {
          streamId,
          chatId: params.chatId,
          runId,
          usage,
        });
      },
      prepareSnapshot: (snapshot) => subagentPersistence.prepare(snapshot),
      onControlSnapshot: async (snapshot) => {
        subagentPersistence.projectControlSnapshot(snapshot);
        await subagentPersistence.flushControlPersistence();
      },
      onSnapshot: async (snapshot) => {
        await subagentPersistence.upsert(snapshot);
        sendGeneration(streamId, "chat:subagents", {
          streamId,
          snapshot: subagentPersistence.rendererSnapshot(snapshot),
        });
      },
    });
  }
  // Bot and Assistant runtimes are bound by their grant, so their children
  // always run on the parent model. Model choice never reaches capabilities.
  const subagentModelOverridesAllowed = !botBound && !assistantMode;
  const subagentModelSettings = subagentModelOverridesAllowed
    ? parseSubagentModelSettings(settings.subagentModels)
    : undefined;
  const subagentModelPolicy: SubagentModelPolicy | undefined =
    allowSubagents && folderPath && workspace?.id
      ? {
          parent: {
            providerId: runtime.provider.id,
            providerLabel: runtime.provider.label,
            modelId: model.id,
            modelLabel: model.name?.trim() || model.id,
            effort: thinkingLevel,
          },
          candidates: subagentModelOverridesAllowed
            ? subagentModelCandidatesFromSettings(
                await listConfiguredProviders().catch(() => []),
                subagentModelSettings,
              )
            : [],
          overridesAllowed: subagentModelOverridesAllowed,
          settings: subagentModelSettings,
        }
      : undefined;
  const subagentModelOptions = subagentModelPolicy
    ? subagentModelToolOptions(subagentModelPolicy)
    : undefined;
  const subagentSupervisor =
    allowSubagents && folderPath && workspace?.id
      ? new SubagentSupervisor({
          compactionEngine: compactionEngineFrom(settings.compactionEngine),
          compactionModelOverrides: settings.compactionModelOverrides,
          generationId: streamId,
          chatId: params.chatId,
          workspaceId: workspace.id,
          runtime,
          thinkingLevel,
          workspaceRoot: folderPath,
          permission: toolPermission,
          inheritedCeiling: subagentReadCeiling,
          loadPersistedChatForFork: async (forkSignal) => {
            if (subagentRunStore.selection !== "v2") {
              throw new Error("Forked subagent context is unavailable during V1 rollback.");
            }
            if (forkSignal?.aborted) {
              throw forkSignal.reason instanceof Error
                ? forkSignal.reason
                : new Error("Forked subagent context was cancelled.");
            }
            const persisted = await chatStore.get(params.chatId);
            if (forkSignal?.aborted) {
              throw forkSignal.reason instanceof Error
                ? forkSignal.reason
                : new Error("Forked subagent context was cancelled.");
            }
            if (!persisted || persistedChatWorkspaceId(persisted.workspaceId) !== workspace.id) {
              throw new Error("Forked subagent context no longer belongs to this workspace.");
            }
            return persisted;
          },
          prepareRun: subagentPersistence?.prepareRun,
          selectChildModel: subagentModelPolicy
            ? createSubagentChildModelResolver({
                policy: subagentModelPolicy,
                parentRuntime: runtime,
                savedEffort: (providerId, modelId) =>
                  savedThinkingLevelFor(settings, providerId, modelId),
                resolveRuntime: (providerId, modelId, modelSignal) =>
                  resolveModelRuntime(providerId, modelId, modelSignal, chat.id),
              })
            : undefined,
          modelOptions: subagentModelOptions,
          healthMetrics: subagentHealthMetrics,
          projector: subagentProjector,
          // SubagentStop for the chats whose own turns run hooks (the same
          // gate as `chatHooks` in runChat); Bots wire their own.
          ...(runsWorkspaceChatHooks({
            usageSource: options.usageSource,
            interactionSurface: options.interactionSurface,
            bot: botBound,
            design: false,
            assistant: assistantMode,
            harnessProvider: isAcpHarnessProvider(runtime.provider.id),
          })
            ? {
                stopHooks: chatSurfaceHooks(
                  {
                    chatId: params.chatId,
                    cwd: folderPath,
                    ...(workspace.noWorkspace === true ? {} : { workspaceRoot: folderPath }),
                  },
                  undefined,
                  {
                    // Shown in the chat while its turn is live, else logged; never the model's.
                    report: (messages) => {
                      const live = active.has(streamId) || initializing.has(streamId);
                      if (live && sendGeneration(streamId, "chat:status", { streamId, phase: "hook_messages", messages })) return;
                      logger.warn("hooks", `SubagentStop hooks for chat ${params.chatId}: ${messages.join("\n")}`);
                    },
                  },
                ),
              }
            : {}),
        })
      : undefined;
  // Assistant modes use positive allowlists: the dock gets safe metadata plus
  // scheduling, while an approved automation gets only its project tools and
  // exact MCP identities. Computer Use, skills, and delegation stay out.
  // Desktop-only: the Artifacts tab is a Mac and Linux surface, so phone,
  // Telegram and Bot turns get neither the tool nor its skill.
  const offerWorkspaceArtifacts =
    !botContext &&
    !assistantMode &&
    Boolean(workspace) &&
    options.usageSource === "chat" &&
    options.interactionSurface !== "telegram" &&
    options.visualAudience !== "remote" &&
    permission !== "read-only" &&
    !options.excludeToolNames?.has(WORKSPACE_ARTIFACT_TOOL_NAME);
  let skillSnapshot =
    !assistantMode && workspace ? await skillRegistry.snapshotResolved(workspace) : undefined;
  if (skillSnapshot && !offerWorkspaceArtifacts) {
    skillSnapshot = withoutSkills(skillSnapshot, DESKTOP_ARTIFACT_SKILLS);
  }
  // The agent's hooks tool and its skill: where workspace chat hooks run, and
  // only while someone can answer the owner's card. Design runs returned above.
  const offerHooksTool = hostPlatformCapabilities().hooks && offersHooksTool({
    usageSource: options.usageSource,
    interactionSurface: options.interactionSurface,
    bot: Boolean(botContext),
    design: false,
    assistant: assistantMode,
    harnessProvider: isAcpHarnessProvider(runtime.provider.id),
    unattended: options.unattended === true,
    excludedToolNames: options.excludeToolNames,
  });
  if (skillSnapshot && !offerHooksTool) {
    skillSnapshot = withoutSkills(skillSnapshot, DESKTOP_HOOK_SKILLS);
  }
  let botSkillToolNames: ReadonlySet<string> = new Set();
  if (botContext && skillSnapshot) {
    if (!botRuntimeCatalog) throw new Error("Bot runtime catalog was not prepared.");
    const filtered = await prepareBotSkillAuthority(
      botContext,
      skillSnapshot,
      botRuntimeCatalog.resources.skills,
    );
    skillSnapshot = filtered.snapshot;
    botSkillToolNames = filtered.toolNames;
  }
  const botConnectionIds = botContext
    ? botContext.admission.authority.connections.map(({ sourceId }) => sourceId)
    : undefined;
  const schedulingAllowed =
    (!assistantMode || attendedAssistant) &&
    !options.excludeToolNames?.has(SCHEDULE_TOOL_NAME) &&
    (!botContext || options.interactionSurface !== "telegram") &&
    (!botContext || botHasOrdinaryCapability(botContext, "schedules"));
  const botScheduleToolNames =
    botContext && schedulingAllowed
      ? new Set(
          buildSchedulingTools({
            workspaceId: workspace?.id,
            allowScheduling: true,
          }).map(({ name }) => name),
        )
      : new Set<string>();
  const browserFileApprovals = new Map<string, PreparedBrowserFile>();
  const browserActionApprovals = new Map<
    string,
    { approval: BrowserToolApproval; args: Record<string, unknown> }
  >();
  const browserSelection: { initialized: boolean; tabId?: string } = { initialized: false };
  // Legacy Bot generations stay without browser tools: a Bot's browser (its
  // own profile, masked snapshots, no scripts) is offered only on durable Bot
  // turns, through `bot-runtime/bot-browser-tools.ts`.
  const browserEligible =
    workspace &&
    canUseBrowserTools({ permission, rendererOwner, assistantMode, bot: Boolean(botContext) });
  const browserState = browserEligible
    ? await (await import("./browser/service.js")).browserService.getState(workspace.id)
    : undefined;
  const browserEnabled =
    browserState &&
    resolveBrowserAgentAccess(browserState.defaults.agentAccess, browserState.agentAccessOverride);
  const browserTools =
    workspace && browserEnabled
      ? createBrowserAgentTools({
          workspaceId: workspace.id,
          chatId: params.chatId,
          generationId: streamId,
          signal,
          supportsImages,
          selection: browserSelection,
          revalidate: async () => {
            if (signal.aborted || !active.has(streamId))
              throw new Error("This browser generation is no longer active.");
            const currentWorkspace = await configStore.getWorkspace(workspace.id);
            if (
              !currentWorkspace ||
              currentWorkspace.permission === "none" ||
              currentWorkspace.permission !== workspace.permission ||
              currentWorkspace.folderPath !== workspace.folderPath
            ) {
              throw new Error("Browser workspace access changed. Start a new response.");
            }
          },
          port: {
            getState: async () =>
              (await import("./browser/service.js")).browserService.getState(workspace.id),
            command: async (command, browserSignal, callId) => {
              const { browserService } = await import("./browser/service.js");
              const approvedAction = callId ? browserActionApprovals.get(callId) : undefined;
              const beforeEffect = approvedAction
                ? () =>
                    assertBrowserToolApproval(
                      approvedAction.approval,
                      approvedAction.approval.toolName,
                      approvedAction.args,
                      browserService.getApprovalTarget(
                        workspace.id,
                        approvedAction.approval.target.tabId,
                      ),
                    )
                : undefined;
              beforeEffect?.();
              return browserService.command(workspace.id, command, {
                source: "agent",
                signal: browserSignal,
                supportsImages,
                beforeEffect,
                ...(callId && browserFileApprovals.has(callId)
                  ? { preparedFile: browserFileApprovals.get(callId)! }
                  : {}),
                ...(browserOwner.id !== 0 ? { owner: browserOwner } : {}),
              });
            },
          },
        })
      : [];
  const disclosedBrowserTools = browserTools.filter(({ name }) => !options.excludeToolNames?.has(name));
  const browserDiscovery = disclosedBrowserTools.length ? createBrowserDiscovery(
    disclosedBrowserTools,
    async () => {
      signal.throwIfAborted();
      if (!active.has(streamId) || !workspace) throw new Error("This browser generation is no longer active.");
      const current = await configStore.getWorkspace(workspace.id);
      if (!current || current.permission !== workspace.permission || current.folderPath !== workspace.folderPath) throw new Error("Browser workspace access changed. Start a new response.");
      const state = await (await import("./browser/service.js")).browserService.getState(workspace.id);
      if (!resolveBrowserAgentAccess(state.defaults.agentAccess, state.agentAccessOverride)) throw new Error("Browser agent access is disabled for this workspace.");
    },
  ) : undefined;
  // Simulator tools: the flag, agent access, and an interactive desktop owner must all hold now.
  const deviceStaticGate = canUseDeviceTools({
    enabled: devicesEnabled(),
    agentAccess: true,
    permission,
    rendererOwner,
    assistantMode,
    bot: Boolean(botContext),
  });
  const deviceService = deviceStaticGate && params.chatId
    ? await (await import("../handlers/devices.js")).deviceServiceForAgents()
    : null;
  const deviceGate = Boolean(deviceService?.state().consent.agentAccess);
  const deviceTools =
    deviceService && deviceGate
      ? createDeviceAgentTools({
          chatId: params.chatId,
          signal,
          supportsImages,
          port: deviceService,
          revalidate: async () => {
            if (signal.aborted || !active.has(streamId))
              throw new Error("This simulator generation is no longer active.");
            if (!devicesEnabled()) throw new Error("Simulator support is off.");
            if (workspace) {
              const currentWorkspace = await configStore.getWorkspace(workspace.id);
              if (
                !currentWorkspace ||
                currentWorkspace.permission === "none" ||
                currentWorkspace.permission !== workspace.permission ||
                currentWorkspace.folderPath !== workspace.folderPath
              ) {
                throw new Error("Workspace access changed. Start a new response to use simulators.");
              }
            }
          },
          screenshotDir: () => deviceService.screenshotDir(params.chatId!),
          // `saveTo` may write only into this chat's workspace or Downloads.
          saveRoots: async () => ({
            ...(folderPath && workspace?.permission !== "none" ? { workspace: folderPath } : {}),
            downloads: (await import("../handlers/devices.js")).deviceDownloadsDir(),
          }),
        }).filter(({ name }) => !options.excludeToolNames?.has(name))
      : [];
  // PATH gets the pinned agent-device only when the gate held at generation start, and
  // loses it on the next command once agent access is revoked.
  const deviceShimDir =
    deviceTools.length && deviceService ? () => deviceService.agentShimDir() : undefined;
  // In the codemode lane a slow MCP server joins the turn late instead of
  // holding its start; elsewhere tools are declared and discovery blocks.
  let lateMcpDiscovery: McpLateDiscovery = NO_LATE_MCP_DISCOVERY;
  const mcpDeferral = workspaceCodemodeEnabled({
    workspaceId: workspace?.id,
    folderPath,
    bot: Boolean(botContext),
    mode: params.mode,
    permission,
    excludeToolNames: options.excludeToolNames,
  })
    ? { onLate: (late: McpLateDiscovery) => { lateMcpDiscovery = late; } }
    : undefined;
  let tools = (
    await buildAgentTools({
      mcpDeferral,
      mcpProviderScope: {
        signal,
        onInvalidated: (listener) => browserOwner.onInvalidated(listener),
        isCurrent: () => {
          const generation = active.get(streamId) ?? initializing.get(streamId);
          return !signal.aborted && !!generation && generation.owner === browserOwner && !generation.cancelRequested && !generation.rendererDetached && !generation.owner.isDestroyed();
        },
      },
      allowMcpProviderAuth: canUseProviderAuthenticatedMcp({ rendererOwner, permission, workspace: Boolean(workspace?.folderPath), assistant: assistantMode, bot: Boolean(botContext), usageSource: options.usageSource, interactionSurface: options.interactionSurface }),
      workspaceId: workspace?.id,
      workspaceRoot: folderPath,
      skillSnapshot,
      permission: toolPermission,
      computerUse,
      formFill,
      browserTools: browserDiscovery ? [browserDiscovery.tool] : [],
      deviceTools,
      ...(deviceShimDir ? { shellPathPrefix: deviceShimDir } : {}),
      allowScheduling: schedulingAllowed,
      allowMcpTools: botContext
        ? options.allowMcpTools !== false && botConnectionIds!.length > 0
        : options.allowMcpTools,
      mcpServerIds: botContext ? botConnectionIds : options.mcpServerIds,
      disabledMcpServerIds: workspaceDisabledMcpServerIds,
      mcpServerBindings: options.mcpServerBindings,
      allowSubagents,
      mode: assistantPersonaMode
        ? "assistant"
        : assistantAutomationMode
          ? "assistant-automation"
          : undefined,
      interactionSurface: options.interactionSurface,
      allowTelegramDirect:
        !botBound &&
        (!assistantMode || attendedAssistant || options.interactionSurface === "telegram"),
      assistantModelSelection: schedulingAllowed ? assistantModelSelection : undefined,
      createSubagentTool: subagentSupervisor
        ? () =>
            createSubagentTool(
              subagentSupervisor,
              projectRequestableSubagentMcpInventoryV2(subagentMcpInventory),
              subagentWriteEnabled,
              childMcpMutationsRollout
                ? projectRequestableSubagentMcpMutationInventoryV2(subagentMcpInventory)
                : [],
              subagentShellEnabled,
              subagentDelegationEnabled,
              subagentModelOptions,
            )
        : undefined,
      shareImage: folderPath ? shareImage : undefined,
      includeCodingTools: !botContext,
      imageInspectionTool:
        botContext && !supportsImages && botContext.admission.authority.visionProvider
          ? createVisionAnalysisTool(
              {
                attachments: chat.messages.flatMap((message) => withoutVisualSnapshots(message.attachments ?? [])),
                authority: {
                  providerId: botContext.admission.authority.visionProvider.sourceProviderId,
                  modelId: botContext.admission.authority.visionProvider.sourceModelId,
                  revalidateBeforeEffect: () => botContext.admission.revalidateBeforeEffect(),
                },
              },
              {
                resolveRuntime: (providerId, modelId, signal) =>
                  resolveBotModelRuntime(providerId, modelId, signal, params.chatId),
              },
            )
          : undefined,
    })
  ).filter((tool) => !options.excludeToolNames?.has(tool.name));
  // Reading web pages follows the Web Search switch in attended chats on the
  // desktop and paired phones. Bots, schedules, helper agents, the Assistant
  // and Telegram do not get it yet.
  if (
    !botContext &&
    !assistantMode &&
    options.usageSource === "chat" &&
    options.interactionSurface !== "telegram" &&
    !options.excludeToolNames?.has(WEB_FETCH_TOOL_NAME)
  ) {
    const webFetchTool = await webFetchService.toolForGeneration();
    if (webFetchTool) tools.push(webFetchTool);
  }
  // Background jobs and pull request follows: workspace chats with folder
  // access, on the Mac and Linux desktop. Their news reaches the chat later.
  if (
    !botContext &&
    !assistantMode &&
    params.chatId &&
    workspace &&
    folderPath &&
    permission !== "none" &&
    permission !== "read-only" &&
    options.usageSource === "chat" &&
    options.interactionSurface !== "telegram" &&
    hostPlatformCapabilities().backgroundJobs
  ) {
    const { createFollowThroughTools } = await import("./follow-through/follow-through-tools-main.js");
    tools.push(
      ...createFollowThroughTools({
        chatId: params.chatId,
        workspaceId: workspace.id,
        folderPath,
        permission: workspace.permission,
        ...(deviceShimDir ? { pathPrefix: deviceShimDir } : {}),
        isCurrent: () => !signal.aborted && active.has(streamId),
        excludeToolNames: options.excludeToolNames,
      }),
    );
  }
  const botMutatingToolNames = new Set<string>();
  if (botContext) {
    const authority = botContext.admission.authority;
    const fileLocations: BotFileToolLocation[] = [];
    if (authority.files.botHome) {
      fileLocations.push({
        id: "builtin.bot_home.v1",
        label: "Bot folder",
        root: authority.workingDirectory,
        expectedIdentity: authority.managedHome.incarnation,
      });
    }
    if (authority.files.fullMac) {
      fileLocations.push({
        id: authority.files.fullMac.sourceId,
        label: "Full Mac",
        root: "/",
      });
    }
    fileLocations.push(
      ...botApprovedRoots.map(({ device, inode, ...location }) => ({
        ...location,
        expectedIdentity: { device, inode },
      })),
    );
    if (fileLocations.length > 0) {
      tools.push(
        ...buildBotFileTools({
          defaultLocation: fileLocations[0]!,
          additionalLocations: fileLocations.slice(1),
        }),
      );
    }
    if (authority.files.botHome) {
      tools.push(
        createShareImageTool({
          workspaceRoot: authority.workingDirectory,
          expectedWorkspaceIdentity: authority.managedHome.incarnation,
          scopeToWorkspace: true,
          share: shareImage,
        }),
      );
    }
    if (authority.shell.enabled) {
      const shell = buildPinnedCodingTools(authority.workingDirectory).find(
        ({ name }) => name === "run_command",
      );
      if (!shell) throw new Error("The Bot shell tool is unavailable.");
      tools.push(shell);
    }
    if (!botRuntimeCatalog) throw new Error("Bot runtime catalog was not prepared.");
    // Joined to the built tools by MCP identity, so their real names (from the
    // full live inventory) are the ones granted.
    const mcpToolNames = exactBotMcpToolNames(authority, botRuntimeCatalog.resources.connections, tools);
    for (const [modelToolName, grant] of mcpToolNames) {
      if (grant.effect === "mutating") botMutatingToolNames.add(modelToolName);
    }
    const webAllowed = botHasOrdinaryCapability(botContext, "web");
    const computerAllowed = botHasOrdinaryCapability(botContext, "computer_use");
    const subagentsAllowed = botHasOrdinaryCapability(botContext, "subagents");
    tools = tools.flatMap((tool) => {
      const allowed = botSkillToolNames.has(tool.name)
        ? true
        : tool.name === INSPECT_IMAGE_TOOL_NAME
          ? !supportsImages && Boolean(authority.visionProvider)
          : mcpToolNames.has(tool.name)
            ? // The built tool itself must carry the grant's exact schema and effect.
              botMcpLiveToolMatchesGrant(mcpToolNames.get(tool.name)!, mcpAgentToolDescriptor(tool))
            : tool.name === "web_search"
              ? webAllowed
              : isComputerUseCapabilityTool(tool.name)
                ? computerAllowed
                : tool.name === "subagent"
                  ? subagentsAllowed
                  : BOT_FILE_TOOL_NAMES.includes(tool.name as (typeof BOT_FILE_TOOL_NAMES)[number])
                    ? fileLocations.length > 0
                    : tool.name === "run_command"
                      ? authority.shell.enabled
                      : tool.name === SHARE_IMAGE_TOOL_NAME
                        ? authority.files.botHome
                        : botScheduleToolNames.has(tool.name);
      return allowed ? [protectAdmittedBotTool(tool, botContext.admission)] : [];
    });
  }
  // Image generation also runs in folderless conversations (image tools only);
  // workspace chats need a file permission and also get classify and display_image.
  const modelOperationsScope = {
    usageSource: options.usageSource,
    interactionSurface: options.interactionSurface,
    assistantMode,
    workspaceRoot: folderPath,
    permission,
    // Bots never get model operations.
    excluded: Boolean(botContext),
  };
  const modelOperationsEnabled = shouldEnableImageGeneration(modelOperationsScope);
  // Image generation has its own registry and keys (Settings → Image Generation);
  // it never uses chat provider credentials. The snapshot is cached and offline.
  const imageSnapshot: ImageGenerationSnapshot = modelOperationsEnabled
    ? await imageGeneration.snapshot().catch((error: unknown) => {
        logger.warn("image-generation", "Could not load image generation settings for this chat.", error);
        return { available: false };
      })
    : { available: false };
  const artifactStoreAvailability = modelOperationsEnabled
    ? displayImageArtifactStore.availability()
    : ({ available: true } as const);
  const modelOperationsPlan = planModelOperationsForChat(modelOperationsScope, {
    imageGenerationAvailable: imageSnapshot.available,
    stagingAvailable: artifactStoreAvailability.available,
  });
  if (!artifactStoreAvailability.available && modelOperationsPlan.staging === "fail") {
    throw new Error(
      `${artifactStoreAvailability.reason} Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair.`,
    );
  }
  if (!artifactStoreAvailability.available && modelOperationsPlan.staging === "skip") {
    logger.warn(
      "image-generation",
      `Image generation is off for this chat because image staging is unavailable: ${artifactStoreAvailability.reason}`,
    );
  }
  if (modelOperationsPlan.setupHint) {
    generationExtensions.push({
      id: "aiden.model-operations",
      systemPrompt: IMAGE_GENERATION_UNAVAILABLE_PROMPT,
    });
  }
  if (modelOperationsPlan.imageTools) {
    const displayImageWorkspaceRoot = modelOperationsPlan.displayImage ? folderPath : undefined;
    const existingUsage = displayedAssistantImageUsage(chat.messages);
    const pendingUsage = await displayImageArtifactStore.usageByChat(params.chatId);
    if (pendingUsage.count > 0) {
      throw new Error(
        "A previous image response could not be recovered. Delete this chat to discard it before continuing.",
      );
    }
    const displayImageRuntime = createDisplayImageExtensionRuntime({
      workspaceRoot: displayImageWorkspaceRoot,
      artifactNamespace: streamId,
      existingChatImageBytes: existingUsage.bytes + pendingUsage.bytes,
      existingChatImageCount: existingUsage.count + pendingUsage.count,
      existingChatImagePixels: existingUsage.pixels + pendingUsage.pixels,
      onArtifact: async (artifact, dimensions, source) => {
        const existing = responseImages();
        if (
          existing.some(
            (item) => item.id === artifact.attachment.id || item.data === artifact.attachment.data,
          )
        ) {
          return false;
        }
        if (existing.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
          throw new Error("This response already contains the maximum number of images.");
        }
        const nextBytes =
          existing.reduce((sum, item) => sum + item.size, 0) + artifact.attachment.size;
        if (nextBytes > MAX_ATTACHMENT_INLINE_BYTES) {
          throw new Error("The images shared in this response exceed the 16 MB limit.");
        }
        await displayImageArtifactStore.stage({
          chatId: params.chatId,
          generationId: streamId,
          model: params.model,
          artifact,
          pixels: dimensions.width * dimensions.height,
        });
        if (displayedImageIds.has(artifact.attachment.id)) return false;
        displayedImageIds.add(artifact.attachment.id);
        displayedImages.push(artifact.attachment);
        presentPlacedImage(imagePlacements, artifact, source.toolCallId, (event) => {
          sendGeneration(streamId, "chat:artifact", { streamId, event });
        });
        return true;
      },
    });
    if (displayImageRuntime.extension && !options.excludeToolNames?.has(DISPLAY_IMAGE_TOOL_NAME)) {
      generationExtensions.push(displayImageRuntime.extension);
    }
    // Labels, local/remote accounting and classifier opt-in need provider shape only, not keychain presence.
    const savedOperationProviders = await configStore.listStoredProviders();
    const localClassifierModels = createLocalClassifierModels({
      models: providerRegistry.models,
      providers: savedOperationProviders,
      getProvider: (id) => configStore.getProvider(id),
      resolveRuntime: (providerId, modelId, requestSignal) => resolveModelRuntime(providerId, modelId, requestSignal, chat.id),
    });
    const operationProviders = [runtime.provider, ...savedOperationProviders];
    generationExtensions.push({
      id: "aiden.model-operations",
      systemPrompt: piModelOperationsSystemPrompt({
        defaultImageModel: imageSnapshot.defaultModel,
        classifiers: modelOperationsPlan.classify,
      }),
      tools: createPiModelTools({
        imageModels: imageGeneration.models,
        ...(modelOperationsPlan.classify ? { classifierModels: localClassifierModels.models } : {}),
        providerLabel: (id, type) =>
          type === "image"
            ? isImageGenerationProviderId(id) ? IMAGE_GENERATION_PROVIDER_NAMES[id] : id
            : piModelOperationProviderLabel(id, operationProviders, providerRegistry.builtinProvider(id)?.label),
        listImages: modelImageReferences.listImages,
        resolveImage: modelImageReferences.resolveImage,
        resolveImages: modelImageReferences.resolveImages,
        onImage: displayImageRuntime.presentGeneratedImage,
        // Account at the provider-call boundary, not at nested/parent tool events.
        onUsage: async (record) => {
          // Image providers are always hosted; chat provider deployments never apply to them.
          const imageOperation = record.operation === "image";
          await usageStore.record(modelOperationUsageRecord(
            record, imageOperation ? [] : operationProviders, options.usageSource ?? "chat",
            !imageOperation && localClassifierModels.isLocalProvider(record.provider),
          ));
        },
      })
        .filter((tool) => !options.excludeToolNames?.has(tool.name)),
    });
  }
  if (
    !botContext &&
    shouldEnableGenerativeUiExtension({
      usageSource: options.usageSource,
      interactionSurface: options.interactionSurface,
      assistantMode,
      workspaceRoot: folderPath,
      permission,
      excluded: options.excludeToolNames?.has(GENERATIVE_UI_TOOL_NAME) ?? false,
      inlineVisuals: params.inlineVisuals,
      visualize: params.visualize === true,
    })
  ) {
    const htmlStoreAvailability = generativeUiArtifactStore.availability();
    if (!htmlStoreAvailability.available) {
      throw new Error(
        `${htmlStoreAvailability.reason} Open Aiden's developer log to locate the staging file that needs repair.`,
      );
    }
    const existingHtmlUsage = displayedAssistantHtmlUsage(chat.messages);
    const pendingHtmlUsage = await generativeUiArtifactStore.usageByChat(params.chatId);
    if (pendingHtmlUsage.count > 0) {
      await generativeUiArtifactStore.reconcilePersisted({
        id: params.chatId,
        messages: chat.messages,
      });
    }
    const pendingHtmlAfterReconcile = await generativeUiArtifactStore.usageByChat(params.chatId);
    if (pendingHtmlAfterReconcile.count > 0) {
      throw new Error(
        "A previous visual artifact could not be recovered. Delete this chat to discard it before continuing.",
      );
    }
    const visualize = params.visualize === true;
    const generativeUiRuntime = createGenerativeUiExtensionRuntime({
      // Inline HTML works in every chat; reading a workspace .html file
      // additionally needs a workspace with file access.
      workspaceRoot: folderPath && permission !== "none" ? folderPath : undefined,
      artifactNamespace: `${streamId}:html`,
      existingChatHtmlBytes: existingHtmlUsage.bytes + pendingHtmlAfterReconcile.bytes,
      existingChatHtmlCount: existingHtmlUsage.count + pendingHtmlAfterReconcile.count,
      preferArtifactThisTurn: visualize,
      ...(options.visualAudience ? { audience: options.visualAudience } : {}),
      existingChatUiCount: displayedAssistantUiCount(chat.messages),
      onUiVisual: (visual, context) => {
        uiVisualPlacements.record(visual.id, context.toolCallId, visual.layout ?? "column");
        const toolCallId = uiVisualPlacements.publicIdFor(visual.id);
        const placed: ChatUiVisualV1 = toolCallId ? { ...visual, toolCallId } : visual;
        const index = displayedUiVisuals.findIndex((item) => item.id === visual.id);
        if (index >= 0) displayedUiVisuals[index] = placed;
        else displayedUiVisuals.push(placed);
        sendGeneration(streamId, "chat:artifact", {
          streamId,
          event: { version: CHAT_ARTIFACT_EVENT_VERSION, operation: "ui", visual: placed },
        });
        return true;
      },
      onArtifact: async (artifact, html, context) => {
        await generativeUiArtifactStore.stage({
          chatId: params.chatId,
          generationId: streamId,
          model: params.model,
          artifact,
          html,
        });
        const index = displayedHtmlArtifacts.findIndex((item) => item.mediaId === artifact.mediaId);
        if (index >= 0) {
          displayedHtmlArtifacts[index] = artifact;
        } else {
          if (displayedHtmlArtifacts.length >= MAX_HTML_ARTIFACTS_PER_RESPONSE) {
            throw new Error("This response already contains the maximum number of HTML artifacts.");
          }
          displayedHtmlIds.add(artifact.mediaId);
          displayedHtmlArtifacts.push(artifact);
        }
        htmlArtifactPlacements.record(artifact.mediaId, context.toolCallId, context.layout);
        const placedToolCallId = htmlArtifactPlacements.publicIdFor(artifact.mediaId);
        sendGeneration(streamId, "chat:artifact", {
          streamId,
          event: {
            version: CHAT_ARTIFACT_EVENT_VERSION,
            operation: "present",
            artifact,
            ...(placedToolCallId ? { toolCallId: placedToolCallId } : {}),
            ...(readyPreviewSrc(artifact.title, html)),
            ...(htmlArtifactPlacements.layoutFor(artifact.mediaId) === "wide" ? { layout: "wide" as const } : {}),
          },
        });
        return true;
      },
    });
    generationExtensions.push(generativeUiRuntime.extension);
  }
  if (offerWorkspaceArtifacts && workspace) {
    // Gated by offerWorkspaceArtifacts above.
    generationExtensions.push({
      id: "aiden.workspace-artifacts",
      tools: [
        createWorkspaceArtifactTool({
          workspaceId: workspace.id,
          chatId: params.chatId,
          permission,
          hasFolder: Boolean(folderPath),
          store: workspaceArtifactStore,
          takeApprovedDigest: (toolCallId) => takeApprovedWorkspaceArtifactCall(streamId, toolCallId),
          refresh: (artifact, refreshSignal) =>
            workspaceArtifactRunner.refresh(workspace.id, artifact.id, { folderPath, permission }, refreshSignal),
          workspaceExists: async () => Boolean(await configStore.getWorkspace(workspace.id)),
          onChanged: notifyWorkspaceArtifactsChanged,
        }),
      ],
    });
  }
  if (!botContext && !assistantMode && workspace && permission !== "none" && !options.excludeToolNames?.has("read_tool_output")) {
    const outputs = await attachWorkspaceToolOutputs(tools, params.chatId, workspace.id,
      () => !signal.aborted && (active.has(streamId) || initializing.has(streamId)), workspace);
    tools = outputs.tools;
    // Servers that finish discovery after the turn starts get the same
    // retained-output handling, and read_tool_output accepts their handles.
    const late = lateMcpDiscovery;
    if (late !== NO_LATE_MCP_DISCOVERY) {
      lateMcpDiscovery = {
        tools: () => outputs.adopt(late.tools()),
        pending: () => late.pending(),
        settled: (requestSignal) => late.settled(requestSignal),
      };
    }
  }
  if (!botContext && (!assistantMode || attendedAssistant) && options.interactionSurface !== "telegram" && schedulingAllowed && (rendererOwner || browserOwner?.kind === "remote")) {
    tools.push(...createAidenAppTools({
      service: appControlsService, liveState: browserOwner?.kind !== "remote",
      runtime: { interaction: "attended-workspace", workspacePermission: permission, providerId: params.providerId, modelId: params.model, availableTools: tools.map((tool) => tool.name) },
      open: browserOwner?.kind !== "remote" ? (destination, toolSignal) => aidenAppNavigation.open(destination, browserOwner, toolSignal) : undefined,
      context: { actor: `agent:${params.chatId}`, target: browserOwner?.kind === "remote" ? "Paired host" : "This desktop", workspaceId: workspace?.id,
        humanGesture: false, isCurrent: () => !signal.aborted && !browserOwner?.isDestroyed() },
      present: (panel) => {
        if (appPanels.length >= 4) throw new Error("This response already has four settings panels.");
        appPanels.push(panel);
      },
    }).filter((tool) => !options.excludeToolNames?.has(tool.name)));
  }
  let googleWorkspaceSnapshot: string | undefined;
  if (
    params.providerId === GOOGLE_PROVIDER_ID &&
    workspace?.id &&
    folderPath &&
    permission !== "none" &&
    (!botContext || botContext.admission.authority.files.botHome)
  ) {
    try {
      googleWorkspaceSnapshot = buildGeminiWorkspaceSnapshot(
        await listWorkspaceFiles(folderPath, signal),
        git,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warn(
        "pi",
        `Could not prepare Gemini workspace context for ${workspace.id}; continuing without a cache.`,
        error,
      );
    }
  }
  return {
    runtime: { ...runtime, model },
    agentsInstructions,
    agentsInstructionRoots,
    browserDiscovery,
    browserSelection,
    browserFileApprovals,
    browserActionApprovals,
    permission,
    folderPath,
    git,
    tools,
    generationExtensions,
    modelImageReferences,
    lateMcpDiscovery,
    displayedImages,
    displayedHtmlArtifacts,
    appPanels,
    htmlArtifactPlacements,
    imagePlacements,
    displayedUiVisuals,
    uiVisualPlacements,
    supportsImages,
    thinkingLevel,
    computerUse,
    formFill,
    googleWorkspaceSnapshot,
    skillSnapshot,
    workspaceId: workspace?.id,
    /** The folder is the hidden one behind a No workspace chat. */
    noWorkspace: workspace?.noWorkspace === true,
    subagentSupervisor,
    showLocalModelReasoning: settings.showLocalModelReasoning,
    compactionEngine: compactionEngineFrom(settings.compactionEngine),
    compactionModelOverrides: settings.compactionModelOverrides,
    cacheWarmingEnabled: settings.cacheWarmingEnabled === true,
    sharedImages,
    botContext,
    botApprovedRoots,
    botMutatingToolNames,
    offerHooksTool,
  };
}

const acpScratch = createAcpScratchDirectories({
  root: () => join(app.getPath("userData"), "acp", "scratch"),
  onPrepareError: (error) => logger.warn("acp", "Could not prepare the agent scratch directory.", error),
});

export const llmClient = {
  /**
   * Aiden is about to quit (or the quit was called off): cards withdrawn from
   * now on stay saved, so the next launch can offer them again.
   */
  setQuitInProgress(value: boolean): void {
    quitInProgress = value;
  },

  async start(
    streamId: string,
    params: ChatStartParams,
    owner: ChatGenerationOwner,
    options: GenerationExecutionOptions = {},
  ): Promise<boolean> {
    const designRun = options.designRun;
    const designWiring = designRun ? designGenerationWiring(designRun, appendPiMessages) : undefined;
    const turnId = options.turnId;
    const ownsTurn =
      typeof turnId === "string" &&
      turnId.length > 0 &&
      chatTurnAdmission.owns(params.chatId, turnId, owner.documentId);
    try {
      if (!ownsTurn) {
        throw new Error("This message turn expired before generation could start.");
      }
      if (chatDeletionGate.isDeleting(params.chatId)) {
        throw new Error("This chat is being deleted.");
      }
      if (chatWorkspaceMutationGate.isChanging(params.chatId)) {
        throw new Error("This chat is changing workspaces. Try again in a moment.");
      }
      if (chatCopyGate.isChanging(params.chatId)) {
        throw new Error("This chat is being copied. Try again in a moment.");
      }
      if (initializing.has(streamId) || active.has(streamId)) {
        throw new Error("A generation with this stream id is already running.");
      }
      if (chatHasGenerationOwnership(params.chatId)) {
        throw new Error("This chat already has a response in progress.");
      }
    } catch (error) {
      if (turnId) {
        chatTurnAdmission.releaseMatching(params.chatId, turnId, owner.documentId);
      }
      throw error;
    }
    const initialization = {
      chatId: params.chatId,
      owner,
      removeOwnerInvalidation: () => {},
      stopCacheWarming: undefined as (() => void) | undefined,
      workspaceId: undefined as string | undefined,
      cancelRequested: false,
      cancellationOrigin: undefined as GenerationCancellationOrigin | undefined,
      rendererDetached: false,
      controller: new AbortController(),
      computerUse: undefined as ComputerUseController | undefined,
      loadMonitor: undefined as LoadMonitorState | undefined,
      skillInvocation: undefined as PreparedSkillInvocation | undefined,
      skillPrompt: undefined as string | undefined,
      releaseSkillReservation: () => {},
      releaseBotAuthority: () => {},
    };
    const computerUseGateSnapshot = computerUseGenerationGate.snapshot();
    let handedOff = false;
    try {
      handedOff =
        Boolean(turnId) &&
        chatTurnAdmission.handoff(
          params.chatId,
          turnId!,
          owner.documentId,
          (skillInvocation, releaseSkillReservation) => {
            initialization.skillInvocation = skillInvocation;
            initialization.releaseSkillReservation = releaseSkillReservation;
            initializing.set(streamId, initialization);
            chatActivityRegistry.begin(streamId, params.chatId);
            recordRunBegin(hostRunRegistry, streamId, params.chatId, owner);
            chatProgressEvents.begin(params.chatId, streamId);
          },
        );
    } catch (error) {
      if (turnId) chatTurnAdmission.releaseMatching(params.chatId, turnId, owner.documentId);
      throw error;
    }
    if (!handedOff) {
      throw new Error("This message turn expired before generation could start.");
    }
    options.onTurnAccepted?.();
    if (options.unattended) {
      // Nobody is there to answer: every approval or question this turn would
      // raise settles at once as unavailable, and the model is told so.
      approvals.detachStream(streamId);
      questionnaires.detachStream(streamId);
    }
    initialization.removeOwnerInvalidation = owner.onInvalidated(() => {
      this.detachRenderer(streamId, owner.documentId);
    });
    if (initialization.controller.signal.aborted) initialization.removeOwnerInvalidation();
    let setup: Awaited<ReturnType<typeof prepareGeneration>>;
    let authoritativeChat: Chat | undefined;
    let authoritativeBot: BotDefinition | undefined;
    let botContext: BotGenerationAuthorityContext | undefined;
    let authoritativeMode: ChatStartParams["mode"];
    let generationProfile: GenerationProfile = { kind: "default" };
    const initializationTerminalState = { attempted: false };
    const persistInitializationTerminal = async (
      status: "failed" | "cancelled",
      cancellationOrigin?: GenerationCancellationOrigin,
    ): Promise<void> => {
      await persistGenerationInitializationTerminal({
        state: initializationTerminalState,
        hasAuthoritativeChat: authoritativeChat !== undefined,
        workspaceId: initialization.workspaceId,
        streamId,
        providerId: params.providerId,
        model: params.model,
        status,
        cancellationOrigin,
        isCurrent: () =>
          initializing.get(streamId) === initialization ||
          (active.get(streamId)?.chatId === params.chatId && active.get(streamId)?.owner === owner),
        append: (message, meta) => chatStore.appendMessage(params.chatId, message, meta),
        onUnknownOutcome: (terminalError) =>
          logger.error(
            "pi",
            `Could not persist the initialization outcome for stream ${streamId}`,
            terminalError,
          ),
      });
    };
    try {
      const chat = await chatStore.get(params.chatId);
      if (!chat) {
        throw new Error("This chat is no longer available.");
      }
      // A design-owned chat runs only with its own project's main-built binding.
      // It throws before authoritativeChat is set, so no failure turn is written.
      generationProfile = resolveGenerationProfile(chat, options);
      authoritativeChat = chat;
      authoritativeMode = authoritativeChatGenerationMode(chat.workspaceId, params.mode);
      if (chat.botId && !hostPlatformCapabilities().bots) {
        throw new Error("Bot chats are not available on this platform.");
      }
      authoritativeBot = await resolveBotForGeneration(chat, authoritativeMode, (botId) =>
        botStore.get(botId),
      );
      // Over its spending limit, a chat (or a Bot's month) starts no reply.
      const spendingRefusal = await spending.refusal(
        authoritativeBot ? { kind: "bot", id: authoritativeBot.id } : { kind: "chat", id: chat.id },
        authoritativeBot?.name,
      );
      if (spendingRefusal) throw new Error(spendingRefusal);
      if (authoritativeBot) {
        const canonical = selectCanonicalBotChat(await chatStore.listByBot(authoritativeBot.id));
        if (canonical?.id !== chat.id) {
          throw new Error("This historical Bot chat is read-only. Open the Bot's current chat.");
        }
        // A paused Bot runs no turn on this path either (plan §7). Checked once
        // this generation is registered, so a pause recorded after the check
        // finds it and stops it (`stopChatWork`).
        if (await isBotPaused(authoritativeBot.id)) {
          throw new Error("This Bot is paused. Resume it to continue.");
        }
        const providerId = chat.providerId;
        const model = chat.model;
        const botId = authoritativeBot.id;
        if (!providerId || !model) {
          throw new Error(
            "This Bot chat needs an exact AI connection and model before it can reply.",
          );
        }
        const admission = await admitBotAfterProviderAuthPreflight({
          signal: initialization.controller.signal,
          preflightAuth: () =>
            preflightBotModelAuth(providerId, model, initialization.controller.signal),
          admit: () =>
            botRuntimeAuthority.admit({
              audienceId: options.botAudienceId ?? BOT_DESKTOP_AUDIENCE_ID,
              botId,
              chatId: chat.id,
            }),
        });
        const invalidate = () => {
          active.get(streamId)?.agent.abort();
          if (!initialization.controller.signal.aborted) {
            initialization.controller.abort(
              admission.signal.reason instanceof Error
                ? admission.signal.reason
                : new Error("Bot access changed while this response was active."),
            );
          }
        };
        admission.signal.addEventListener("abort", invalidate, { once: true });
        if (admission.signal.aborted) invalidate();
        initialization.releaseBotAuthority = () => {
          admission.signal.removeEventListener("abort", invalidate);
          admission.release();
        };
        const prepared = await prepareBotGeneration({
          chat,
          bot: authoritativeBot,
          requested: {
            workspaceId: params.workspaceId,
            providerId: params.providerId,
            model: params.model,
          },
          resolveManagedWorkspace: (botId) => botManagedWorkspace.resolve(botId),
          resolveRuntime: resolveBotModelRuntime,
          signal: initialization.controller.signal,
        });
        botContext = { admission, prepared };
      }
      if (chatDeletionGate.isDeleting(params.chatId)) {
        throw new Error("This chat is being deleted.");
      }
      const authoritativeWorkspaceId = authoritativeChatWorkspaceId(
        chat.workspaceId,
        params.workspaceId,
      );
      initialization.workspaceId = authoritativeWorkspaceId;
      const preparedSkillInvocation = initialization.skillInvocation;
      if (preparedSkillInvocation) {
        const currentUser = [...authoritativeChat.messages]
          .reverse()
          .find((message) => message.role === "user");
        initialization.skillPrompt = preparedSkillPromptForCurrentTurn(
          preparedSkillInvocation,
          authoritativeWorkspaceId,
          currentUser,
          authoritativeMode,
        );
      }
      if (options.telegramSkillInvocation) {
        const selection = options.telegramSkillInvocation;
        const currentUser = [...authoritativeChat.messages]
          .reverse()
          .find((message) => message.role === "user");
        if (
          options.interactionSurface !== "telegram" ||
          selection.workspaceId !== authoritativeWorkspaceId ||
          !currentUser
        ) {
          throw new Error("The queued Telegram skill no longer matches this conversation.");
        }
        const skill = await skillRegistry.resolveFresh(
          selection.workspaceId,
          selection.invocationId,
        );
        const prepared = formatPreparedSkillInvocation(
          skill,
          currentUser.content,
          selection.workspaceId,
          currentUser.id,
        );
        initialization.skillInvocation = prepared;
        initialization.skillPrompt = prepared.formattedPrompt;
      }
      if (workspaceMutationGate.isChanging(authoritativeWorkspaceId)) {
        throw new Error("The workspace is changing. Try again in a moment.");
      }
      if (initialization.controller.signal.aborted) {
        throw initialization.controller.signal.reason;
      }
      setup = await prepareGeneration(
        streamId,
        {
          ...params,
          workspaceId: authoritativeWorkspaceId,
          mode: authoritativeMode,
        },
        chat,
        botContext,
        initialization.controller.signal,
        computerUseGateSnapshot,
        (computerUse) => {
          initialization.computerUse = computerUse;
        },
        owner.documentId,
        owner.id !== 0,
        owner,
        options,
      );
    } catch (error) {
      if (initialization.cancelRequested || initialization.controller.signal.aborted) {
        await persistInitializationTerminal("cancelled", initialization.cancellationOrigin);
        sendGeneration(streamId, "chat:done", {
          streamId,
          content: "",
          cancelled: true,
          cancellationOrigin: initialization.cancellationOrigin,
        });
        releaseGenerationSkillReservation(initialization);
        releaseGenerationBotAuthority(initialization);
        approvedWorkspaceArtifactCalls.delete(streamId);
        initializing.delete(streamId);
        initialization.removeOwnerInvalidation();
        approvals.releaseStream(streamId);
        questionnaires.releaseStream(streamId);
        broadcastChatSettled(
          streamId,
          params.chatId,
          initialization.workspaceId,
          params.workspaceId,
        );
        return false;
      }
      await persistInitializationTerminal("failed");
      releaseGenerationSkillReservation(initialization);
      releaseGenerationBotAuthority(initialization);
      approvedWorkspaceArtifactCalls.delete(streamId);
      initializing.delete(streamId);
      initialization.removeOwnerInvalidation();
      approvals.releaseStream(streamId);
      questionnaires.releaseStream(streamId);
      broadcastChatSettled(streamId, params.chatId, initialization.workspaceId, params.workspaceId);
      throw error;
    }
    const generationChat = authoritativeChat;
    if (!generationChat) {
      throw new Error("This chat is no longer available.");
    }
    const {
      runtime,
      agentsInstructions,
      agentsInstructionRoots,
      browserDiscovery,
      browserSelection,
      browserFileApprovals,
      browserActionApprovals,
      permission,
      folderPath,
      git,
      tools: setupTools,
      generationExtensions,
      modelImageReferences,
      lateMcpDiscovery,
      displayedImages,
      displayedHtmlArtifacts,
      appPanels,
      htmlArtifactPlacements,
      imagePlacements,
      displayedUiVisuals,
      uiVisualPlacements,
      supportsImages,
      thinkingLevel,
      computerUse,
      formFill,
      googleWorkspaceSnapshot,
      skillSnapshot: setupSkillSnapshot,
      workspaceId,
      noWorkspace,
      subagentSupervisor,
      showLocalModelReasoning,
      compactionEngine,
      compactionModelOverrides,
      cacheWarmingEnabled,
      sharedImages,
      botContext: preparedBotContext,
      botApprovedRoots,
      botMutatingToolNames,
      offerHooksTool,
    } = setup;
    // Claim checks tell connector failures by the tools' real MCP identity.
    const claimCheckOptions = {
      isConnectorTool: (name: string) => [...tools, ...lateMcpDiscovery.tools()]
        .some((tool) => tool.name === name && mcpAgentToolIdentity(tool) !== undefined),
    };
    const attendedAssistant = authoritativeMode === "assistant";
    initialization.computerUse = computerUse;
    const { model } = runtime;
    // Agent-backed providers (ACP harnesses) own their conversation context:
    // Aiden neither trims nor compacts the transcript they receive.
    const harnessProvider = isAcpHarnessProvider(runtime.provider.id);
    // Aiden hooks run for ordinary desktop chats only. Bot chats (policy-owned
    // hooks arrive with Bots), Design Studio runs, the attended Assistant,
    // routines, Telegram and side questions (their usage source is not
    // "chat") and ACP harness providers (the agent runs its own tools) start
    // none; title generation, probes, catalogs and subagents never come
    // through here.
    const chatHooks =
      runsWorkspaceChatHooks({
        usageSource: options.usageSource,
        bot: Boolean(preparedBotContext || authoritativeBot),
        design: generationProfile.kind === "design",
        assistant: attendedAssistant,
        harnessProvider,
      })
        ? createWorkspaceChatHooks(
            {
              chatId: params.chatId,
              ...(folderPath && !noWorkspace ? { workspaceRoot: folderPath } : {}),
            },
            undefined,
            {
              // Hook messages reach the person as notices, never the model.
              onMessages: (messages) => {
                sendGeneration(streamId, "chat:status", { streamId, phase: "hook_messages", messages });
              },
            },
          )
        : undefined;
    // The agent's hooks tool (plan §9) where chat hooks run on an attended
    // turn. A proposal waits for the owner's card on this Mac, raised from
    // inside the tool so Full access and remembered approvals never answer it.
    const hooksTool =
      chatHooks && offerHooksTool
        ? createHooksTool({
            chatId: params.chatId,
            ...(folderPath && !noWorkspace ? { workspaceRoot: folderPath } : {}),
            service: getHookService,
            requestApproval: async (toolCallId, card, approvalSignal) => {
              timeline.toolAwaitingApproval(toolCallId);
              const publicToolCallId = timeline.publicToolCallId(toolCallId);
              if (!publicToolCallId) throw new Error("The tool approval step was not initialized.");
              chatHooks.notify("Aiden needs your permission to save a hook", "permission_prompt");
              try {
                return await approvals.request(
                  {
                    streamId,
                    toolCallId: publicToolCallId,
                    toolName: HOOKS_TOOL_NAME,
                    summary: card.summary,
                    details: card.details,
                  },
                  approvalSignal,
                  owner.documentId,
                );
              } finally {
                timeline.toolRunning(toolCallId);
              }
            },
          })
        : undefined;
    const tools = hooksTool ? [...setupTools, hooksTool] : setupTools;
    const skillSnapshot =
      hooksTool || !setupSkillSnapshot ? setupSkillSnapshot : withoutSkills(setupSkillSnapshot, DESKTOP_HOOK_SKILLS);
    let hookTurnContext: string | undefined;
    // Mid-flight input's UserPromptSubmit context, on that input's message only.
    const hookInputContexts = createRunInputContexts();
    // Each response's price counts toward the chat's limit (a Bot chat's, its
    // month). A sign-in or a model on this Mac counts as $0.
    const spendingOwner: SpendingOwner = authoritativeBot
      ? { kind: "bot", id: authoritativeBot.id }
      : { kind: "chat", id: params.chatId };
    const spendingMeter = createSpendingMeter({
      spending,
      owner: spendingOwner,
      counts: () => spendCounts({ local: isLocalModelProvider(runtime.provider), provider: runtime.provider, models: runtime.models }),
    });
    const approvalModelSelection = {
      providerId: runtime.provider.id,
      providerName: runtime.provider.label,
      model: model.id,
      modelName: model.name,
      providerFingerprint: scheduledProviderFingerprint(runtime.provider),
    };
    const exposeReasoning = shouldExposeReasoning(runtime.provider, showLocalModelReasoning);

    if (isLocalProviderDeployment(runtime.provider)) {
      const loadMonitorState: LoadMonitorState = {
        readyEmitted: false,
        monitor: startLocalModelLoadMonitor({
          provider: runtime.provider,
          modelId: params.model,
          signal: initialization.controller.signal,
          onLoading: () => {
            sendGeneration(streamId, "chat:status", {
              streamId,
              phase: "model_loading",
            });
          },
          onReady: () => {
            if (loadMonitorState.readyEmitted) return;
            loadMonitorState.readyEmitted = true;
            sendGeneration(streamId, "chat:status", {
              streamId,
              phase: "model_ready",
            });
          },
        }),
      };
      initialization.loadMonitor = loadMonitorState;
    }

    const deniedToolCalls = new Set<string>();
    const timeline = new GenerationTimelineProjector(streamId, (snapshot) => {
      sendGeneration(streamId, "chat:timeline", {
        streamId,
        timeline: snapshot,
      });
    });
    // One access card per chat, asked on the first computer_use call. A deny
    // holds for the rest of this stream.
    const computerUseAccess = computerUse
      ? createComputerUseAccessGate({
          readGrant: async () =>
            (await configStore.getSettings()).computerUseAlwaysAllow === true ||
            (await chatStore.get(params.chatId))?.computerUseAllowed === true,
          status: (statusOptions) => computerUseStatus.status(statusOptions),
          requestAccess: async (toolCallId, approvalSignal) => {
            timeline.toolAwaitingApproval(toolCallId);
            const publicToolCallId = timeline.publicToolCallId(toolCallId);
            if (!publicToolCallId) throw new Error("The tool approval step was not initialized.");
            const outcome = await approvals.request(
              {
                streamId,
                toolCallId: publicToolCallId,
                toolName: COMPUTER_USE_TOOL_NAME,
                summary: COMPUTER_USE_ACCESS_SUMMARY,
                details: { kind: COMPUTER_USE_ACCESS_APPROVAL_KIND },
                scopes: COMPUTER_USE_ACCESS_SCOPES,
              },
              approvalSignal,
              owner.documentId,
            );
            const scope =
              outcome === "allowed"
                ? approvals.takeDecisionPayload(streamId, publicToolCallId)?.scope
                : undefined;
            return { outcome, scope };
          },
          grantChat: () => chatStore.setComputerUseAllowed(params.chatId, true),
          grantAlways: () => configStore.setSettings({ computerUseAlwaysAllow: true }),
          setPendingContinue: (pending) =>
            chatStore.setComputerUsePendingContinue(params.chatId, pending),
          cancellationOrigin: () =>
            active.get(streamId)?.cancellationOrigin ?? initialization.cancellationOrigin,
          warn: (message, error) => logger.warn("pi", message, error),
        })
      : undefined;
    // computer_use and fill_form share the access gate. The first call marks
    // the stream as using Computer Use, so only such streams are cancelled
    // when the beta, Form Fill or its model goes away.
    const authorizeComputerUseAccess = async (
      toolCallId: string,
      accessSignal?: AbortSignal,
    ): Promise<ComputerUseAccessDecision> => {
      if (!computerUseAccess) {
        return { allowed: false, reason: "Computer Use is not enabled for this response." };
      }
      if (
        !activateComputerUseStream(
          computerUseGenerationGate,
          computerUseGateSnapshot,
          active.get(streamId),
        )
      ) {
        return {
          allowed: false,
          reason: "Computer Use was turned off during this response. Ask again to use it.",
        };
      }
      return computerUseAccess.authorize(toolCallId, accessSignal);
    };
    if (formFill) {
      formFill.progressSink = (toolCallId, completed, total) =>
        timeline.toolDetail(toolCallId, `${completed} of ${total} fields`);
    }
    // Visuals are placed by the timeline's public call ids, not Pi's raw ones.
    htmlArtifactPlacements.setResolver((rawToolCallId) => timeline.publicToolCallId(rawToolCallId));
    uiVisualPlacements.setResolver((rawToolCallId) => timeline.publicToolCallId(rawToolCallId));
    imagePlacements.setResolver((rawToolCallId) => timeline.publicToolCallId(rawToolCallId));
    // Drafts only stream when render_artifact is really registered this turn
    // (not when visuals are Off, or for surfaces that never get the tool).
    const visualsRegistered = generationExtensions.some(
      (extension) => extension.id === GENERATIVE_UI_EXTENSION_ID,
    );
    const htmlVisualDrafts = createGenerativeUiDraftSession({
      enabled: visualsRegistered,
      publicToolCallId: (rawToolCallId) => timeline.publicToolCallId(rawToolCallId),
      send: (event) => sendGeneration(streamId, "chat:artifact", { streamId, event }),
    });
    const uiVisualDrafts = createUiDraftSession({
      enabled: visualsRegistered,
      publicToolCallId: (rawToolCallId) => timeline.publicToolCallId(rawToolCallId),
      send: (event) => sendGeneration(streamId, "chat:artifact", { streamId, event }),
    });
    // Each session ignores tool calls that are not its own.
    const visualDrafts = {
      delta(rawToolCallId: string, toolName: string, args: unknown) {
        htmlVisualDrafts.delta(rawToolCallId, toolName, args);
        uiVisualDrafts.delta(rawToolCallId, toolName, args);
      },
      end(rawToolCallId: string) {
        htmlVisualDrafts.end(rawToolCallId);
        uiVisualDrafts.end(rawToolCallId);
      },
      cancel(rawToolCallId: string) {
        htmlVisualDrafts.cancel(rawToolCallId);
        uiVisualDrafts.cancel(rawToolCallId);
      },
      dispose() {
        htmlVisualDrafts.dispose();
        uiVisualDrafts.dispose();
      },
    };
    let loadHost: { loadMonitor?: LoadMonitorState } = initialization;
    const noteModelBecameReady = () => endLoadMonitor(loadHost, streamId, true);
    const generationCancelRequested = () =>
      initialization.cancelRequested || active.get(streamId)?.cancelRequested === true;
    const persistAssistant = async (
      content: string,
      reasoning: string,
      finalTimeline: ReturnType<GenerationTimelineProjector["snapshot"]>,
      providerFailure?: ProviderFailureV1,
    ) => {
      const subagents = subagentMessageReference(streamId, subagentSupervisor?.snapshots() ?? []);
      const assistantAttachments = uniqueResponseImages(sharedImages, displayedImages);
      if (
        !content.trim() &&
        !reasoning.trim() &&
        finalTimeline.steps.length === 0 &&
        finalTimeline.status !== "cancelled" &&
        !subagents &&
        !providerFailure &&
        assistantAttachments.length === 0 &&
        displayedHtmlArtifacts.length === 0 &&
        displayedUiVisuals.length === 0 &&
        appPanels.length === 0
      ) {
        return { chat: undefined, error: undefined, messageId: undefined };
      }
      try {
        // The inspector store is authoritative. Never announce terminal chat
        // completion before every accepted child snapshot is durable.
        await subagentSupervisor?.flush();
        const chat = await chatStore.appendMessage(
          params.chatId,
          {
            role: "assistant",
            content,
            model: params.model,
            reasoning: reasoning.trim() ? reasoning : undefined,
            pi: lastAssistantMessage
              ? storedPiAssistantMessage(
                  designWiring
                    ? designWiring.storedAssistantMessage(lastAssistantMessage)
                    : lastAssistantMessage,
                )
              : undefined,
            providerFailure,
            timeline:
              // A failed status is kept so a partial reply still reads as Failed in the chat list.
              finalTimeline.steps.length ||
              finalTimeline.status === "cancelled" ||
              finalTimeline.status === "failed"
                ? finalTimeline
                : undefined,
            turnStats: {
              version: ASSISTANT_TURN_STATS_VERSION,
              startedAt: finalTimeline.startedAt,
              finishedAt: Math.max(finalTimeline.startedAt, finalTimeline.finishedAt ?? Date.now()),
              ...(turnUsage ? { usage: turnUsage } : {}),
            },
            subagents,
            attachments: assistantAttachments.length > 0 ? assistantAttachments : undefined,
            appPanels: appPanels.length ? appPanels : undefined,
            htmlArtifacts: displayedHtmlArtifacts.length > 0 ? displayedHtmlArtifacts : undefined,
            htmlArtifactPlacements: htmlArtifactPlacements.placementsFor(displayedHtmlArtifacts),
            imagePlacements: imageAttachmentPlacements(imagePlacements, assistantAttachments),
            uiVisuals: displayedUiVisuals.length
              ? displayedUiVisuals.map((visual) => {
                  const toolCallId = uiVisualPlacements.publicIdFor(visual.id);
                  return toolCallId ? { ...visual, toolCallId } : visual;
                })
              : undefined,
          },
          {
            providerId: params.providerId,
            model: params.model,
            expectedWorkspaceId: initialization.workspaceId,
          },
        );
        const messageId = [...chat.messages]
          .reverse()
          .find((message) => message.role === "assistant")?.id;
        if (displayedImages.length > 0) {
          try {
            await displayImageArtifactStore.remove(
              params.chatId,
              displayedImages.map((attachment) => attachment.id),
            );
          } catch (error) {
            logger.warn(
              "pi",
              `Could not clear committed image artifacts for stream ${streamId}.`,
              error,
            );
          }
        }
        if (displayedHtmlArtifacts.length > 0) {
          try {
            await generativeUiArtifactStore.commit(
              params.chatId,
              displayedHtmlArtifacts.map((artifact) => artifact.mediaId),
            );
          } catch (error) {
            logger.warn("pi", `Could not commit HTML artifacts for stream ${streamId}.`, error);
          }
        }
        if (messageId && (displayedHtmlArtifacts.length > 0 || displayedUiVisuals.length > 0)) {
          // Snapshots for clients that cannot draw visuals; never delays this reply.
          enqueueVisualSnapshots({
            chatId: params.chatId,
            messageId,
            visuals: [
              ...displayedHtmlArtifacts.map((artifact) => ({
                kind: "html" as const,
                visualId: artifact.mediaId,
                title: artifact.title,
                ...(htmlArtifactPlacements.layoutFor(artifact.mediaId) === "wide" ? { layout: "wide" as const } : {}),
              })),
              ...displayedUiVisuals.map((visual) => ({
                kind: "ui" as const,
                visualId: visual.id,
                title: visual.title,
                visual,
                // The same images the saved message draws beside this visual.
                attachments: visualSnapshotImages(visual, assistantAttachments),
                ...(visual.layout === "wide" ? { layout: "wide" as const } : {}),
              })),
            ],
          });
        }
        return { chat, error: undefined, messageId };
      } catch (error) {
        logger.error("pi", `Could not persist response for stream ${streamId}`, error);
        return {
          chat: undefined,
          error: "local storage failed",
          messageId: undefined,
        };
      }
    };
    let full = "";
    let reasoning = "";
    let lastAssistantMessage: AssistantMessage | undefined;
    let currentAssistantTurnHadVisibleText = false;
    let currentAssistantTurnHadReasoningDelta = false;
    let currentAssistantTurnStart = { full: 0, reasoning: 0, steps: 0 };
    // Set while the model is asked to continue a cut-off reply; its text then
    // joins the kept text directly, without a paragraph break.
    let continuingCutOffReply = false;
    let currentAssistantTurnContinuesCutOff = false;
    // Where the latest failed turn's text started; a retry drops only that turn.
    let failedAssistantTurnStart: { full: number; reasoning: number } | undefined;
    const requestUsage = new AssistantRequestUsageTracker();
    let turnUsage: AssistantTurnUsageV1 | undefined;
    let activeCompactionStepId: string | undefined;
    let piSession: PiSessionPort | undefined;
    let candidate: PiAgentRuntimeHarness | null = null;
    let cacheWarmer: PiCacheWarmer | undefined;
    let lastContextPressure: ChatContextPressureV1 | undefined;
    let currentPromptMessage: AgentMessage | undefined;
    let journalContentOverrides: ReadonlyMap<string, string> = new Map();
    let piJournalHealthy = true;
    let piJournalStopNoted = false;
    let piJournalless = false;
    let piUpgradeCompactionEnabled = false;
    let memoryApprovalContext: { scope: MemoryScope; provenance: MemoryProvenance } | undefined;
    try {
      const piUpgradePolicy = await piUpgradeRolloutStore.load();
      piUpgradeCompactionEnabled = piUpgradeChatBehaviorEligible(piUpgradePolicy, generationChat, {
        development: !isPackagedRuntime(),
        behaviorEnabled: piUpgradeBehaviorEnabledAtStartup,
      });
      const piOpen = await piCompactionSessionStore.openChatIfEligible(
        params.chatId,
        generationChat,
      );
      if (piOpen.session) {
        piSession = piOpen.session;
      } else {
        // The device rollout classifies this chat as pre-activation or holding
        // a deferred v3 migration. Run the turn journalless over an in-memory
        // session: no v4 journal is created and no recovery record is claimed.
        piJournalless = true;
        piSession = await createInMemoryPiSession(params.chatId);
      }
      const recallExtension: PiAgentRuntimeExtension = {
        id: "aiden.chat-history-recall",
        tools: [createVccRecallTool(async () => piSession!)],
      };
      let memoryExtension: PiAgentRuntimeExtension | undefined;
      // Design runs never read or write durable memory. Bots keep their own
      // memory files (`bot-memory/`) and never use the workspace store.
      if (generationProfile.kind === "default" && !generationChat.botId) {
        try {
          const memoryEligible = piUpgradeMemoryEligible(piUpgradePolicy, generationChat, {
            development: !isPackagedRuntime(),
            behaviorEnabled: piUpgradeBehaviorEnabledAtStartup,
          });
          if (!memoryEligible) throw new Error("Durable memory is outside the active rollout stage.");
          if (!(await memoryEnabledForChat(configStore, generationChat))) {
            throw new Error("Durable memory is disabled by the current memory policy.");
          }
          const memoryWorkspace = !generationChat.workspaceId
            ? undefined
            : await configStore.getWorkspace(generationChat.workspaceId);
          const scope = memoryScopeForChat(
            generationChat,
            memoryWorkspace?.folderPath,
            memoryWorkspace?.noWorkspace === true,
          );
          const indexing = await memoryStore.replaceChatMetadata(
            scope,
            generationChat.id,
            memoryMetadataForChat(generationChat),
          );
          if (indexing.rejected || indexing.evicted) writeDiagnosticEvent({
            level: "info", area: "persistence", event: "memory-indexed", outcome: "completed",
            fields: { accepted: indexing.accepted, rejected: indexing.rejected, evicted: indexing.evicted, truncated: indexing.atCapacity },
          });
          const provenance = memoryProvenanceForGeneration(
            generationChat,
            options.turnId,
            owner.id !== 0,
          );
          memoryExtension = await createMemoryExtension({
            store: memoryStore,
            enabled: () => memoryEnabledForChat(configStore, generationChat),
            scope,
            ...(provenance ? { provenance } : {}),
          });
          if (provenance) memoryApprovalContext = { scope, provenance };
        } catch {
          // Memory is an optional local context source. Corruption or an
          // unsupported SQLite build must remove both read and write tools.
          logger.warn("memory", `Disabled durable memory for chat ${params.chatId}.`);
        }
      }
      let todoRuntimeExtension: PiAgentRuntimeExtension | undefined;
      if (
        shouldEnableTodoExtension({
          usageSource: options.usageSource,
          interactionSurface: options.interactionSurface,
          assistantMode: authoritativeMode !== undefined,
          botBound: preparedBotContext !== undefined,
          rendererOwner: owner.id !== 0,
          remoteOwner: owner.kind === "remote",
          botTaskTrackingAllowed:
            preparedBotContext !== undefined &&
            botHasOrdinaryCapability(preparedBotContext, "tasks"),
          excluded: options.excludeToolNames?.has(TODO_TOOL_NAME) ?? false,
        })
      ) {
        const todo = await loadDurableTodoSnapshot(
          params.chatId,
          piJournalless ? undefined : piSession,
        );
        if (todo.state) {
          const todoState = todo.state;
          const publishTodo = (state: typeof todoState) => {
            sendGeneration(streamId, "chat:todo", {
              streamId,
              snapshot: todoSnapshotForRenderer(params.chatId, state),
            });
          };
          todoRuntimeExtension = createTodoExtension(todoState, { onDurableSnapshot: publishTodo });
          if (preparedBotContext) {
            const authority = preparedBotContext.admission;
            todoRuntimeExtension.beforeToolCall = async (context) => {
              if (context.toolCall.name === TODO_TOOL_NAME)
                await authority.revalidateBeforeEffect();
              return undefined;
            };
          }
          generationExtensions.push(todoRuntimeExtension);
        }
        const todoDiagnostic = todoSnapshotDiagnostic(todo.snapshot);
        if (todoDiagnostic) writeDiagnosticEvent(todoDiagnostic);
        sendGeneration(streamId, "chat:todo", { streamId, snapshot: todo.snapshot });
      }
      const runtimeExtensionSnapshot = piAgentRuntimeExtensions.snapshotWithRevision();
      // Arbitrary runtime extensions remain outside the exact Bot catalog.
      // Only the explicitly admitted task extension and history recall enter
      // Bot prompts and schemas.
      const baseRuntimeExtensions: readonly PiAgentRuntimeExtension[] =
        generationProfile.kind === "design"
          ? // Exactly the binding's extension; an empty base fails the composition check.
            [...(designWiring?.extensions ?? [])]
          : preparedBotContext
        ? [
            ...(todoRuntimeExtension ? [todoRuntimeExtension] : []),
            // Journalless runs must not offer VCC recall over an empty
            // in-memory journal; history recall would be dishonest.
            ...(piJournalless ? [] : [recallExtension]),
            {
              id: "aiden.bot-runtime-authority",
              beforeProviderRequest: async ({ model: requestModel }) => {
                assertExactBotProviderDispatch(
                  {
                    provider: preparedBotContext.prepared.runtime.model.provider,
                    model: preparedBotContext.admission.authority.provider.sourceModelId,
                  },
                  { provider: requestModel.provider, model: requestModel.id },
                );
                await preparedBotContext.admission.revalidateBeforeEffect();
                return undefined;
              },
            },
          ]
        : [
            ...runtimeExtensionSnapshot.extensions,
            ...generationExtensions,
            ...(memoryExtension ? [memoryExtension] : []),
            // Journalless runs must not offer VCC recall over an empty
            // in-memory journal; history recall would be dishonest.
            ...(piJournalless ? [] : [recallExtension]),
            // The person's hooks: PostToolUse feedback on tool results and the
            // SessionStart/UserPromptSubmit context for this turn only.
            ...(chatHooks
              ? [
                  chatHooks.extension({
                    promptTimestamp: () =>
                      currentPromptMessage && "timestamp" in currentPromptMessage
                        ? currentPromptMessage.timestamp
                        : undefined,
                    turnContext: () => hookTurnContext,
                    inputContext: hookInputContexts.lookup,
                  }),
                ]
              : []),
          ];
      const toolsBeforeAdvisor = resolvePiAgentRuntimeStaticContributions(
        "",
        tools,
        baseRuntimeExtensions,
      ).tools;
      // A design run composes exactly its own extension: no advisor, codemode or
      // other base extension may join it (ADR-DS §4).
      const advisorExtension = generationProfile.kind === "design" ? undefined : await advisorRuntime.extensionForGeneration({
        scope: {
          usageSource: options.usageSource,
          interactionSurface: options.interactionSurface,
          mode: authoritativeMode,
          bot: preparedBotContext !== undefined,
          child: false,
          rendererOwner: owner.id !== 0,
          excluded: options.excludeToolNames?.has(ADVISOR_TOOL_NAME) ?? false,
        },
        executor: {
          providerId: runtime.provider.id,
          modelId: model.id,
          effort: thinkingLevel,
        },
        executorTools: toolsBeforeAdvisor,
        getLiveMessages: (toolCallId) =>
          candidate ? snapshotAdvisorRuntimeMessages(candidate.state, toolCallId) : [],
        ...(shouldEnableAskUserQuestionExtension({
          usageSource: options.usageSource,
          interactionSurface: options.interactionSurface,
          assistantMode: authoritativeMode !== undefined,
          botBound: preparedBotContext !== undefined,
          rendererOwner: owner.id !== 0,
          remoteOwner: owner.kind === "remote",
          excluded: options.excludeToolNames?.has(ASK_USER_QUESTION_TOOL_NAME) ?? false,
        })
          ? {
              requestQuestionnaire: (
                toolCallId: string,
                questions: Parameters<typeof questionnaires.request>[0]["questions"],
                requestSignal?: AbortSignal,
              ) =>
                questionnaires.request(
                  {
                    streamId,
                    toolCallId,
                    questions,
                    // The advisor picker falls back to its default model on
                    // timeout; only unattended owners get a deadline here.
                    timeoutMs: resolveAskUserQuestionTimeoutMs(undefined, {
                      unattended: owner.kind === "remote",
                    }),
                  },
                  owner.documentId,
                  requestSignal,
                ),
            }
          : {}),
      });
      const codemodeExtension: PiAgentRuntimeExtension | undefined =
        generationProfile.kind === "design"
          ? undefined
          : workspaceCodemodeEnabled({
            workspaceId,
            folderPath,
            bot: Boolean(preparedBotContext),
            mode: authoritativeMode,
            permission,
            excludeToolNames: options.excludeToolNames,
          })
          ? {
              id: "aiden.workspace-codemode",
              tools: [createPiCodemodeTool({
                tools: () => candidate?.getCallableTools() ?? [],
                executeTool: (parentId, name, args, requestSignal) => {
                  if (!candidate) throw new Error("The workspace runtime is not ready.");
                  return candidate.executeNestedToolCall(parentId, name, args, requestSignal);
                },
                settled: (requestSignal) => lateMcpDiscovery.settled(requestSignal),
              }), ...(!options.excludeToolNames?.has("tool_search") ? [createPiToolDiscovery({
                tools: () => candidate?.getCallableTools() ?? [],
                isCallable: isPiCodemodeCallable,
                settled: (requestSignal) => lateMcpDiscovery.settled(requestSignal),
              }).toolSearch] : [])],
            }
          : undefined;
      const runtimeExtensions: readonly PiAgentRuntimeExtension[] = selectRuntimeExtensions(
        generationProfile,
        { base: baseRuntimeExtensions, advisor: advisorExtension, codemode: codemodeExtension },
      );
      const toolsWithRuntimeContributions = resolvePiAgentRuntimeStaticContributions(
        "",
        tools,
        runtimeExtensions,
      ).tools;
      const assistantMcpInventory =
        authoritativeMode === "assistant"
          ? await configStore
              .listMcpServers()
              .then((servers) => assistantMcpServerInventory(servers))
              .catch(() => ({
                servers: [],
                totalEnabledServers: 0,
                omittedInvalidIdentities: 0,
                truncated: false,
              }))
          : {
              servers: [],
              totalEnabledServers: 0,
              omittedInvalidIdentities: 0,
              truncated: false,
            };
      const telegramInteractive = options.interactionSurface === "telegram";
      let hostPromptSkills: string | undefined;
      const baseSystemPrompt =
        generationProfile.kind === "design"
          ? (designWiring?.baseSystemPrompt ?? "")
          : authoritativeMode === "assistant" || authoritativeMode === "assistant-unattended"
          ? buildAssistantSystemPrompt({
              settingsSections: assistantSettingsSections({
                devices: devicesEnabled(),
                botComputers: hostPlatformCapabilities().botComputers,
              }),
              availableTools: toolsWithRuntimeContributions.map((tool) => tool.name),
              mcpToolNames: tools.filter((tool) => mcpAgentToolIdentity(tool) !== undefined).map((tool) => tool.name),
              mcpServers: assistantMcpInventory.servers,
              mcpServerTotal: assistantMcpInventory.totalEnabledServers,
              mcpInventoryTruncated: assistantMcpInventory.truncated,
              mcpOmittedInvalidIdentities: assistantMcpInventory.omittedInvalidIdentities,
              unattended: authoritativeMode === "assistant-unattended" && !telegramInteractive,
              surface: telegramInteractive ? "telegram" : "desktop",
            })
          : authoritativeMode === "assistant-automation"
            ? telegramInteractive
              ? withTelegramAgentContract(
                  await buildSystemPrompt(folderPath, git.branch, permission, false, false),
                  { workspaceBound: Boolean(folderPath) },
                )
              : withUnattendedAssistantContract(
                  await buildSystemPrompt(folderPath, git.branch, permission, false, false),
                )
            : await buildSystemPromptWithSections(
                folderPath,
                git.branch,
                permission,
                toolsWithRuntimeContributions.some((tool) => tool.name === "subagent"),
                true,
                skillSnapshot,
                new Set(toolsWithRuntimeContributions.map((tool) => tool.name)),
                noWorkspace,
              ).then(({ systemPrompt, sections }) => {
                hostPromptSkills = sections.skills;
                return systemPrompt;
              });
      const botSystemPrompt = authoritativeBot
        ? preparedBotContext
          ? withBotRuntimeInstructions(
              baseSystemPrompt,
              authoritativeBot,
              preparedBotContext.prepared.managedWorkspace,
              botWorkspacePromptAuthority(preparedBotContext, botApprovedRoots),
            )
          : (() => {
              throw new Error("Bot runtime authority was not prepared.");
            })()
        : baseSystemPrompt;
      const resolvedContributions = resolvePiAgentRuntimeContributionSnapshot(
        botSystemPrompt,
        tools,
        piResourcesForSkillSnapshot(skillSnapshot),
        runtimeExtensions,
        runtimeExtensionSnapshot.revision,
      );
      const modelContributions = applyCustomModelToolPolicy(
        resolvedContributions, runtime.provider.modelMetadata?.[model.id]?.overrides,
      );
      // What each prompt part adds, for the context meter's per-category breakdown.
      const contextPromptSections = {
        skills: (hostPromptSkills ?? "") + extensionSkillsPrompt(resolvedContributions.extensions),
        memory: resolvedContributions.extensions
          .find((extension) => extension.id === MEMORY_EXTENSION_ID)
          ?.volatileSystemPrompt?.trim() ?? "",
        "bot-instructions": botSystemPrompt.slice(baseSystemPrompt.length),
      };
      // Freeze only the already-admitted MCP inventory. The provider sees the
      // discovery/script tools; nested calls still use the ordinary host gates.
      const { declared, deferred: deferredTools } = partitionPiCodemodeTools(modelContributions.tools);
      // Workspace chats with codemode declare rarely used built-in tools only
      // once the model loads them; scripts can still call the ones they could.
      const onDemandTools = !preparedBotContext && declared.some((tool) => tool.name === "codemode")
        ? createOnDemandTools(declared)
        : undefined;
      // Held-back tools a script can call join the callable inventory the way
      // late MCP tools do, so loading one later never collides with the frozen deferred set.
      const onDemandCallable = onDemandTools?.onDemand.filter((tool) => isPiCodemodeCallable(tool)) ?? [];
      let runtimeTools: AgentTool[] = onDemandTools ? onDemandTools.initialTools([]) : declared;
      const runtimeContributions = {
        ...modelContributions,
        tools: runtimeTools,
      };
      const { systemPrompt } = runtimeContributions;
      // The MCP servers this turn may use, as a bounded section patched into the
      // transcript (never the base prompt), from the final admitted inventory,
      // including servers that finish discovery after the turn started.
      const declaredToolNames = new Set(runtimeTools.map(({ name }) => name));
      const mcpServersSection = createMcpServersSectionRefresher(() => renderMcpServersSection(
        candidate?.getCallableTools() ?? modelContributions.tools,
        { declared: declaredToolNames },
      ));
      // Activity shows MCP tools by their `server/tool` label, not the generated name.
      timeline.setToolLabels((toolName) => mcpToolActivityLabel(candidate?.getCallableTools() ?? modelContributions.tools, toolName));
      const compactionBudget = resolveCompactionModelBudget(compactionModelOverrides, model, compactionEngine);
      const compactionInputReserveTokens = configuredCompactionReserveTokens(compactionModelOverrides, model, compactionEngine);
      const generationContextOptions = {
        compactionReserveTokens: compactionInputReserveTokens,
        contextWindow: model.contextWindow,
        systemPrompt,
        tools: runtimeTools,
        supportsImages,
        providerId: model.provider,
        modelId: model.id,
        retainsSystemUpdates: modelRetainsSystemUpdates(model),
        promptSections: contextPromptSections,
        deferredTools,
      };
      assertGenerationContextCapacity(generationContextOptions);
      const onCompactionEvent = (event: PiCompactionEvent) => {
        if (event.type === "start") {
          cacheWarmer?.stop();
          activeCompactionStepId = timeline.compactionStarted();
          logger.info("pi", `Started ${event.reason} compaction for stream ${streamId}.`, {
            model: model.id,
          });
          return;
        }
        if (activeCompactionStepId) {
          timeline.compactionFinished(
            activeCompactionStepId,
            event.aborted ? "cancelled" : event.result ? "completed" : "failed",
            event.result,
          );
          activeCompactionStepId = undefined;
        }
        // A completed compaction makes the chat's next turn a SessionStart
        // `compact` turn, like Claude Code's compact source.
        if (chatHooks && event.result && !event.aborted) markWorkspaceChatCompacted(params.chatId);
        logger.info("pi", `Finished ${event.reason} compaction for stream ${streamId}.`, {
          aborted: event.aborted,
          tokensBefore: event.result?.tokensBefore,
          estimatedTokensAfter: event.result?.estimatedTokensAfter,
          willRetry: event.willRetry,
        });
        if (event.errorMessage) {
          logger.warn(
            "pi",
            `Compaction failed for stream ${streamId}.`,
            compactionFailureLogMetadata(event),
          );
        }
      };
      const compactionOptions = {
        engine: compactionEngine,
        models: createPiCompactionModels(runtime, (message) => {
          spendingMeter.count(message);
          return usageStore.record(
            assistantUsageRecord({
              message,
              provider: runtime.provider,
              model,
              source: "compaction",
            }),
          );
        }),
        model,
        thinkingLevel,
        settings: {
          ...DEFAULT_COMPACTION_SETTINGS,
          ...compactionBudget,
          enabled: piUpgradeCompactionEnabled && !harnessProvider,
        },
        signal: initialization.controller.signal,
        onEvent: onCompactionEvent,
        // PreCompact: every compaction inside a turn (threshold, overflow and
        // the emergency checkpoint) is "auto"; hook context becomes summary
        // instructions, bounded by each hook's timeout, and errors add none.
        ...(chatHooks
          ? {
              summaryInstructions: (reason: string, compactionSignal: AbortSignal) =>
                preCompactSummaryInstructions(chatHooks, { trigger: "auto", reason, signal: compactionSignal }),
            }
          : {}),
      };

      const currentUser = [...generationChat.messages]
        .reverse()
        .find((message) => message.role === "user");
      const priorVisibleMessages = currentUser
        ? generationChat.messages.filter((message) => message.id !== currentUser.id)
        : generationChat.messages;
      // SessionStart, then UserPromptSubmit, before the model sees the turn.
      // Their context rides this turn only (the `aiden.hooks` extension) and
      // is never saved as the person's words. A SessionStart `continue: false`
      // or a refused prompt throws here, so the turn ends with no model call.
      // A retried prompt that was blocked before loses its mark, on
      // `currentUser` too, so the journal takes it in order below.
      hookTurnContext = await runPromptIntakeHooks({
        target: chatHooks?.target ?? { chatId: params.chatId },
        ...(chatHooks ? { dispatch: chatHooks.dispatch } : {}),
        hasPriorMessages: priorVisibleMessages.length > 0,
        prompt: currentUser,
        store: chatStore,
        idempotencyKeys: { userPromptSubmit: `UserPromptSubmit:${params.chatId}:${streamId}` },
        signal: initialization.controller.signal,
        onStoreError: (message, error) => logger.error("hooks", message, error),
      });
      const skillsEnabledForTurn = (await configStore.getSettings()).skillsEnabled !== false;
      // A forked chat's summary of where its source went after the fork
      // point sits right after the last copied message.
      const forkSummary = generationChat.forkedFrom?.summary;
      if (!skillsEnabledForTurn) {
        piSession = await projectVisibleHistoryWithoutSkills(
          piSession,
          priorVisibleMessages,
          model,
          forkSummary,
        );
      } else {
        await ensurePiForkSummary(piSession, priorVisibleMessages, forkSummary, model, supportsImages);
      }
      const promptJournal = piSession;
      const contentOverrides = new Map<string, string>();
      if (currentUser) {
        if (
          initialization.skillInvocation?.userMessageId === currentUser.id &&
          initialization.skillPrompt
        ) {
          if ((await configStore.getSettings()).skillsEnabled === false) {
            throw new Error("Skills are disabled in Settings → Skills.");
          }
          if (preparedBotContext) {
            const allowedSkill = skillSnapshot?.available.find(
              (skill) =>
                skill.name === initialization.skillInvocation?.provenance.name &&
                skill.source === initialization.skillInvocation.provenance.source,
            );
            if (!allowedSkill) {
              throw new Error("This skill is not enabled for this Bot chat.");
            }
            const expectedPrompt = formatPreparedSkillInvocation(
              allowedSkill,
              chatUserTextWithAttachments(
                currentUser.content,
                currentUser.attachments,
                SLASH_LIMITS.formattedInvocationBytes,
              ),
              workspaceId!,
              currentUser.id,
            ).formattedPrompt;
            if (expectedPrompt !== initialization.skillPrompt) {
              throw new Error("This Bot skill changed before generation started.");
            }
          }
          contentOverrides.set(currentUser.id, initialization.skillPrompt);
        }
      }
      journalContentOverrides = contentOverrides;
      await syncChatMessagesToPiSession(promptJournal, priorVisibleMessages, model, supportsImages);
      // Visible history must precede the recovery boundary. Installing this at
      // app startup could put a recreated/rolled-back journal warning before
      // older ChatStore messages and let compaction discard the safety tail.
      const recoveryEffects = await piRuntimeEffectStore.listEffectsNeedingRecoveryByChat(
        params.chatId,
      );
      if (recoveryEffects.length > 0) {
        await recordPiEffectRecoveryBoundary(promptJournal, recoveryEffects);
        if (!piJournalless) {
          for (const effect of recoveryEffects) {
            await piRuntimeEffectStore.markRecoveryRecorded({
              effectId: effect.effectId,
              operationId: effect.operationId,
              runId: effect.runId,
              chatId: effect.chatId,
            });
          }
        }
      }
      currentPromptMessage = currentUser
        ? chatMessageToPiMessage(
            currentUser,
            model,
            supportsImages,
            contentOverrides.get(currentUser.id),
          )
        : undefined;
      let initialMessages = (await promptJournal.buildContext()).messages;
      if (onDemandTools) {
        // Tools this chat already loaded or called stay declared from the start.
        runtimeTools = onDemandTools.initialTools(initialMessages);
        generationContextOptions.tools = runtimeTools;
      }
      const head = createInitialSystemMessage(systemPrompt, runtimeTools.map(toToolDeclaration));
      if (head) initialMessages = [head, ...initialMessages];
      if (agentsInstructions) {
        const prepared = await agentsInstructions.apply({
          messages: initialMessages,
          tools: [...runtimeTools],
        }, initialization.controller.signal);
        initialMessages = prepared.messages;
        updateGenerationContextOptions(generationContextOptions, prepared);
      }
      {
        const prepared = mcpServersSection.apply({ messages: initialMessages, tools: [...runtimeTools] });
        if (prepared.messages !== initialMessages) {
          initialMessages = prepared.messages;
          updateGenerationContextOptions(generationContextOptions, prepared);
        }
      }
      // Register once the transcript carries AGENTS.md, so the profile's
      // instruction baseline matches the prompt it captured.
      rememberChatContextProfile(params.chatId, generationContextOptions, {
        instructionRoots: agentsInstructionRoots,
        permission,
        toolsDisabled: runtime.provider.modelMetadata?.[model.id]?.overrides?.toolCall === false,
      });
      initialization.skillInvocation = undefined;
      initialization.skillPrompt = undefined;
      const agentRuntimeOptions = buildAgentRuntimeOptions(params.chatId, runtime);
      let attendedToolRecoveryRequested = false;
      if (canWarmForegroundChat({
        enabled: cacheWarmingEnabled,
        local: isLocalModelProvider(runtime.provider),
        bot: Boolean(preparedBotContext),
        owner,
        usageSource: options.usageSource,
        interactionSurface: options.interactionSurface,
        mode: authoritativeMode,
      })) {
        cacheWarmer = new PiCacheWarmer({
          signal: initialization.controller.signal,
          enabled: async () => (await configStore.getSettings()).cacheWarmingEnabled === true,
          isCurrent: () => {
            const generation = active.get(streamId) ?? initializing.get(streamId);
            return !!generation && generation.owner === owner && !generation.cancelRequested &&
              !generation.rendererDetached && !owner.isDestroyed();
          },
          resolveRuntime: (signal) => resolveModelRuntime(params.providerId, params.model, signal, params.chatId),
          recordUsage: async (message, freshRuntime) => {
            spendingMeter.count(message);
            await usageStore.record(assistantUsageRecord({ message, provider: freshRuntime.provider, model: freshRuntime.model, source: "cache-warm" }));
          },
          // A warming read restarts the provider's cache lifetime without a
          // new projection, so the countdown is re-sent from that request.
          onCacheRefreshed: (requestStartedAt) => {
            rememberPromptCacheRefresh(params.chatId, { provider: model.provider, model: model.id, requestStartedAt });
            const pressure = lastContextPressure;
            if (!pressure?.promptCache) return;
            lastContextPressure = { ...pressure, promptCache: { ...pressure.promptCache, lastRequestAt: requestStartedAt } };
            sendGeneration(streamId, "chat:context-pressure", { streamId, chatId: params.chatId, pressure: lastContextPressure });
          },
        });
      }
      initialization.stopCacheWarming = () => cacheWarmer?.dispose();
      const realStream = agentRuntimeOptions.streamFn!;
      const warmedStream = cacheWarmer ? withPiCacheWarming(realStream, cacheWarmer) : realStream;
      // Device-local pace: Pi calls the stream function once per model
      // response, right before the provider request, so the wrapper marks
      // each response's request start (see ModelPaceTimer for what TTFT covers).
      const pace = createModelPaceMeasurement({
        providerId: runtime.provider.id,
        agentHarness: harnessProvider,
        record: (key, sample) => modelPaceRecorder.record(key, sample),
        onError: (error) =>
          logger.debug("model-pace", `Could not measure pace for stream ${streamId}.`, error),
      });
      // Outermost, so a usage-limit wait is neither timed as pace nor warmed:
      // a request turned away before any reply waits and sends again, same model.
      const observedStream: typeof realStream = harnessProvider
        ? pace.wrap(warmedStream)
        : spendingMeter.wrap(
            withUsageLimitWait(
              pace.wrap(warmedStream),
              usageLimits.streamOptions({ kind: "chat", id: params.chatId }, runtime.provider.label),
            ),
          );
      const promptCacheTtl = promptCacheTtlMs(model);
      candidate = createGenerationHarness(generationProfile, {
        contributions: { ...runtimeContributions, tools: runtimeTools },
        deferredTools,
        contextPromptSections,
        // Servers that finished discovery after the turn started stay behind
        // codemode / tool_search too, under the same exclusions.
        ...(runtimeTools.some((tool) => tool.name === "codemode")
          ? {
              lateDeferredTools: () => [
                ...lateMcpDiscovery.tools().filter((tool) => !options.excludeToolNames?.has(tool.name)),
                ...onDemandCallable,
              ],
            }
          : {}),
        models: runtime.models,
        identity: {
          runId: streamId,
          sessionId: params.chatId,
          lane: "foreground",
        },
        onFault: ({ source, extensionId }) => {
          logger.warn(
            "pi",
            `Pi runtime fault (${source}${extensionId ? `:${extensionId}` : ""}) for stream ${streamId}.`,
          );
        },
        onContextProjection: (projection, projectionOptions) => {
          // The harness keeps these options current with host-disclosed tool
          // and prompt updates, so ambient reads reuse the live profile.
          rememberChatContextProfile(params.chatId, projectionOptions, {
            instructionRoots: agentsInstructionRoots,
            permission,
            toolsDisabled: runtime.provider.modelMetadata?.[model.id]?.overrides?.toolCall === false,
          });
          lastContextPressure = {
            ...chatContextPressureFromProjection(projection, projectionOptions),
            // Projections are emitted as each request is prepared, so the
            // cache window restarts now for models that declare one.
            ...(promptCacheTtl > 0 ? { promptCache: { ttlMs: promptCacheTtl, lastRequestAt: Date.now() } } : {}),
          };
          sendGeneration(streamId, "chat:context-pressure", {
            streamId,
            chatId: params.chatId,
            pressure: lastContextPressure,
          });
        },
        ...agentRuntimeOptions,
        streamFn: observedStream,
        convertToLlm,
        ...(params.providerId === GOOGLE_PROVIDER_ID &&
        runtime.apiKey &&
        workspaceId &&
        googleWorkspaceSnapshot
          ? {
              onPayload: geminiContextCache.onPayload({
                apiKey: runtime.apiKey,
                workspaceId,
                workspaceSnapshot: googleWorkspaceSnapshot,
              }),
            }
          : {}),
        ...(harnessProvider
          ? {}
          : {
              transformContext: createGenerationContextTransform(generationContextOptions, (result) => {
                logger.info("pi", `Compacted generation context for stream ${streamId}.`, {
                  model: model.id,
                  estimatedTokensBefore: result.estimatedTokensBefore,
                  estimatedTokensAfter: result.estimatedTokensAfter,
                  inputBudgetTokens: result.inputBudgetTokens,
                  truncatedToolResults: result.truncatedToolResults,
                  compactedToolResults: result.compactedToolResults,
                  removedHistoryMessages: result.removedHistoryMessages,
                  removedCurrentTurnMessages: result.removedCurrentTurnMessages,
                  usedContextFallback: result.usedContextFallback,
                });
              }),
            }),
        durability: {
          session: promptJournal,
          compaction: compactionOptions,
          compactionReserveTokens: compactionInputReserveTokens,
          signal: initialization.controller.signal,
          effects: { store: piRuntimeEffectStore, chatId: params.chatId },
          // Design HTML lives in the project store, never in the Pi journal (ADR-DS §10).
          ...(designWiring ? { appendMessages: designWiring.journalAppend } : {}),
          beforeQueuedUser: async (message, signal) => {
            if (message.role !== "user" || typeof message.content !== "string" || !message.content.trim()) {
              throw new Error("Queued guidance must contain text.");
            }
            // ChatStore writes are not abortable; never start one after Stop.
            if (signal.aborted) throw new Error("The response stopped before guidance was saved.");
            const chat = await chatStore.appendMessage(
              params.chatId,
              { role: "user", content: message.content, model: params.model },
              {
                providerId: params.providerId,
                model: params.model,
                expectedWorkspaceId: initialization.workspaceId,
              },
            );
            const visible = chat.messages[chat.messages.length - 1];
            if (!visible || visible.role !== "user") {
              throw new Error("Queued guidance was not saved in the visible chat.");
            }
            return visible.id;
          },
          ...(currentUser
            ? {
                appendInput: async () => {
                  await syncChatMessagesToPiSession(
                    promptJournal,
                    [currentUser],
                    model,
                    supportsImages,
                    contentOverrides,
                  );
                },
              }
            : {}),
          onJournalError: (error) => {
            // A Stop-interrupted write may still land, so the turn is recovered
            // from the visible chat either way. Only a real failure is an error.
            piJournalHealthy = false;
            if (isPiManagedCancellationError(error)) {
              if (!piJournalStopNoted) {
                piJournalStopNoted = true;
                logger.info(
                  "pi",
                  `Stop interrupted Pi session writes for stream ${streamId}; the visible turn will be recovered.`,
                );
              }
              return;
            }
            logger.error(
              "pi",
              `Could not append Pi session messages for stream ${streamId}.`,
              error,
            );
          },
        },
        initialState: {
          systemPrompt,
          model,
          thinkingLevel,
          tools: [...runtimeTools],
          messages: initialMessages,
        },
        finishTurn: async (turn) => {
          if (attendedAssistant) {
            const decision = endRunAfterIgnoredToolRecovery(() => attendedToolRecoveryRequested)(turn);
            if (decision) return decision;
          }
          // The step that crossed the spending limit has finished: end here, so
          // the chat shows its limit notice rather than a failed reply.
          if (harnessProvider) return undefined;
          await spendingMeter.settled();
          return (await spending.block(spendingOwner).catch(() => undefined)) ? { action: "end" } : undefined;
        },
        prepareNextTurnWithContext: createPiTurnContextPreparation({
          generationOptions: generationContextOptions,
          attended: attendedAssistant,
          prepareContext: async (context, requestSignal) => {
            let prepared = await prepareCustomModelToolContext(
              context,
              browserDiscovery || onDemandTools
                ? async (current) => {
                    const withBrowser = browserDiscovery ? await browserDiscovery.prepare(current) : current;
                    return onDemandTools ? onDemandTools.prepare(withBrowser) : withBrowser;
                  }
                : undefined,
              runtime.provider.modelMetadata?.[model.id]?.overrides,
            );
            if (agentsInstructions) prepared = await agentsInstructions.apply(prepared, requestSignal);
            return mcpServersSection.apply(prepared);
          },
          onRecovery: () => {
            attendedToolRecoveryRequested = true;
            logger.warn(
              "pi",
              `Stopped attended Assistant tool retries for stream ${streamId} and requested a text-only recovery.`,
            );
          },
        }),
        // Computer Use asks once per chat. Folder mutations pause in "ask" mode.
        beforeToolCall: async (context, signal) => {
          timeline.toolStarted(context.toolCall.id, context.toolCall.name, context.args);
          let summary: string;
          let approvalDetails: ToolApprovalDetails | undefined;
          let formFillApproval: FormFillApprovalDescriptor | undefined;
          /** Commands digest an allowed workspace_artifact card showed. */
          let artifactApprovalDigest: string | undefined;
          let attendedScheduleApproval = false;
          let browserFileApproval: PreparedBrowserFile | undefined;
          let browserActionApproval: BrowserToolApproval | undefined;
          let scopedRuleTarget: ToolApprovalRuleTarget | undefined;
          // PreToolUse hooks (docs/plans/aiden-hooks-plan.md §5): deny blocks,
          // ask forces a card without a remember offer, and allow may only skip
          // a card a remembered approval scope could already skip.
          let hookAsk: string | undefined;
          let hookAllow = false;
          const runPreToolUseHooks = async () => {
            if (!chatHooks) return undefined;
            const hook = await chatHooks.preToolUse({
              toolCallId: context.toolCall.id,
              toolName: context.toolCall.name,
              args: context.args,
              tools: context.context.tools,
              signal,
            });
            if (hook.kind === "block") {
              if (!signal?.aborted) {
                deniedToolCalls.add(context.toolCall.id);
                timeline.toolFinished(context.toolCall.id, "blocked");
              }
              return { block: true, reason: hook.reason };
            }
            if (hook.kind === "ask") hookAsk = hook.reason;
            else if (hook.kind === "allow") hookAllow = true;
            return undefined;
          };
          const notifyApprovalWaiting = () =>
            chatHooks?.notify(
              `Aiden needs your permission to use ${context.toolCall.name}`,
              "permission_prompt",
            );
          // Computer Use and Form Fill check the chat's access first.
          if (
            context.toolCall.name !== COMPUTER_USE_TOOL_NAME &&
            context.toolCall.name !== FORM_FILL_TOOL_NAME
          ) {
            const hookBlock = await runPreToolUseHooks();
            if (hookBlock) return hookBlock;
          }
          if (
            context.toolCall.name === "browser_open" ||
            context.toolCall.name === "browser_navigate"
          ) {
            try {
              const file = browserLocalFileRequest(
                context.toolCall.name,
                context.args as Record<string, unknown>,
              );
              if (file && workspaceId) {
                const { browserFileService } = await import("./browser/files.js");
                browserFileApproval = await browserFileService.prepare(workspaceId, file.path, {
                  assetPaths: file.assetPaths,
                  signal,
                });
                if (!browserFileApproval.requiresApproval)
                  browserFileApprovals.set(context.toolCall.id, browserFileApproval);
              }
            } catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return {
                block: true,
                reason: error instanceof Error ? error.message : "Local preview access failed.",
              };
            }
          }
          let approvedScheduleMcpBindings: import("./types.js").ScheduledMcpServerBinding[] = [];
          if (context.toolCall.name === COMPUTER_USE_TOOL_NAME) {
            const blockComputerUse = (reason: string) => {
              if (!signal?.aborted) {
                deniedToolCalls.add(context.toolCall.id);
                timeline.toolFinished(context.toolCall.id, "blocked");
              }
              return { block: true, reason };
            };
            if (!computerUse) {
              return blockComputerUse("Computer Use is not enabled for this response.");
            }
            const access = await authorizeComputerUseAccess(context.toolCall.id, signal);
            if (!access.allowed) return blockComputerUse(access.reason);
            const hookBlock = await runPreToolUseHooks();
            if (hookBlock) return hookBlock;
            if (hookAsk) {
              // A hook asked: this one action needs its own card.
              const toolCallId = timeline.publicToolCallId(context.toolCall.id);
              if (!toolCallId) return blockComputerUse("The tool approval step was not initialized.");
              timeline.toolAwaitingApproval(context.toolCall.id);
              notifyApprovalWaiting();
              const hookOutcome = await approvals.request(
                {
                  streamId,
                  toolCallId,
                  toolName: context.toolCall.name,
                  summary: `${summarizeToolCall(context.toolCall.name, context.args)}\n\n${hookAsk}`,
                },
                signal,
                owner.documentId,
              );
              if (hookOutcome !== "allowed") {
                return blockComputerUse(toolApprovalBlockReason(hookOutcome, false));
              }
            }
            // The chat is allowed, so input actions run without a per-action card.
            try {
              await authorizeAllowedComputerUseAction(
                computerUse,
                context.toolCall.id,
                context.args as ComputerUseArgs,
                signal,
              );
            } catch (error) {
              return blockComputerUse(
                error instanceof Error ? error.message : "Computer Use rejected this action.",
              );
            }
            timeline.toolRunning(context.toolCall.id);
            return undefined;
          } else if (context.toolCall.name === FORM_FILL_TOOL_NAME) {
            if (!formFill) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return {
                block: true,
                reason: "The Form Fill Specialist is not enabled or its model is not ready.",
              };
            }
            // Form Fill drives the computer, so it needs the same chat access.
            const access = await authorizeComputerUseAccess(context.toolCall.id, signal);
            if (!access.allowed) {
              if (!signal?.aborted) {
                deniedToolCalls.add(context.toolCall.id);
                timeline.toolFinished(context.toolCall.id, "blocked");
              }
              return { block: true, reason: access.reason };
            }
            // Form Fill always shows its card; a hook's ask adds its reason there.
            const hookBlock = await runPreToolUseHooks();
            if (hookBlock) return hookBlock;
            try {
              const descriptor = await formFill.approvalFor(context.args, signal);
              formFillApproval = descriptor;
              summary = descriptor.summary;
              approvalDetails = descriptor.details;
            } catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return {
                block: true,
                reason:
                  error instanceof Error ? error.message : "Form fill could not prepare a plan.",
              };
            }
          } else {
            const createScheduleApproval =
              context.toolCall.name === SCHEDULE_TOOL_NAME &&
              scheduleToolRequiresApproval(context.args);
            const editScheduleApproval = context.toolCall.name === EDIT_AUTOMATION_TOOL_NAME;
            const scheduleApproval = createScheduleApproval || editScheduleApproval;
            const workspaceApproval =
              permission === "ask" &&
              (APPROVAL_TOOL_NAMES.has(context.toolCall.name) ||
                BROWSER_MUTATION_TOOL_NAMES.has(context.toolCall.name) ||
                deviceToolRequiresApproval(context.toolCall.name, context.args) ||
                backgroundJobRequiresApproval(context.toolCall.name, context.args));
            const disclosureApproval = DISCLOSURE_APPROVAL_TOOL_NAMES.has(context.toolCall.name);
            const memoryApproval =
              context.toolCall.name === REMEMBER_MEMORY_TOOL_NAME ||
              context.toolCall.name === FORGET_MEMORY_TOOL_NAME;
            const botMcpApproval = botMutatingToolNames.has(context.toolCall.name);
            let artifactApproval: WorkspaceArtifactCallApproval | undefined;
            if (context.toolCall.name === WORKSPACE_ARTIFACT_TOOL_NAME && workspaceId) {
              try {
                artifactApproval = await workspaceArtifactCallApproval(context.args, {
                  workspaceId,
                  permission: permission === "read-only" ? "none" : permission,
                  store: workspaceArtifactStore,
                });
              } catch (error) {
                deniedToolCalls.add(context.toolCall.id);
                timeline.toolFinished(context.toolCall.id, "blocked");
                return {
                  block: true,
                  reason: error instanceof Error ? error.message : "The artifact could not be read for approval.",
                };
              }
            }
            if (artifactApproval?.required) artifactApprovalDigest = artifactApproval.digest;
            attendedScheduleApproval = scheduleApproval && attendedAssistant;
            let preparedStandardScheduleSummary: string | undefined;
            if (
              !scheduleApproval &&
              !workspaceApproval &&
              !disclosureApproval &&
              !memoryApproval &&
              !botMcpApproval &&
              !artifactApproval?.required &&
              !browserFileApproval?.requiresApproval &&
              !hookAsk
            ) {
              // The question card itself is the wait; hooks hear about it.
              if (context.toolCall.name === ASK_USER_QUESTION_TOOL_NAME) {
                chatHooks?.notify("Aiden is asking you a question", "elicitation_dialog");
              }
              timeline.toolRunning(context.toolCall.id);
              return undefined;
            }
            // Only the parent's plain workspace tools can be remembered, and
            // never for Bot-bound turns whose authority is policy-owned.
            // A hook's ask never offers or uses a remembered approval.
            if (
              workspaceApproval &&
              !hookAsk &&
              !preparedBotContext &&
              APPROVAL_TOOL_NAMES.has(context.toolCall.name)
            ) {
              scopedRuleTarget = toolApprovalRuleTarget(
                context.toolCall.name,
                context.args,
                workspaceId,
              );
              if (scopedRuleTarget && hookAllow && !signal?.aborted) {
                // A remembered scope could cover this call, so a hook may too.
                timeline.toolRunning(context.toolCall.id);
                return undefined;
              }
              if (scopedRuleTarget) {
                let remembered: "chat" | "always" | undefined;
                try {
                  remembered = await toolApprovalRules.match(params.chatId, scopedRuleTarget);
                } catch (error) {
                  logger.warn("pi", "Could not read remembered tool approvals; asking instead.", error);
                }
                if (remembered && !signal?.aborted) {
                  timeline.toolRunning(context.toolCall.id);
                  return undefined;
                }
              }
            }
            if (scheduleApproval && attendedAssistant) {
              try {
                const proposal = editScheduleApproval
                  ? await prepareAssistantEditAutomationProposal(context.args)
                  : await repairAssistantScheduleMcpTarget(context.args);
                if (createScheduleApproval) {
                  const canonicalArgs = context.args as Record<string, unknown>;
                  if (proposal.input.workspaceId) canonicalArgs.workspaceId = proposal.input.workspaceId;
                  else delete canonicalArgs.workspaceId;
                  canonicalArgs.permission = proposal.input.permission;
                  canonicalArgs.mcpServerIds = proposal.input.mcpServerIds;
                }
                const [project, mcpResolution, liveSettings] = await Promise.all([
                  resolveAssistantScheduleProject(proposal),
                  resolveAssistantScheduleMcpServers(proposal),
                  configStore.getSettings(),
                ]);
                if (signal?.aborted) {
                  throw new Error("Automation change was cancelled.");
                }
                const { mcpServerBindings, ...mcpServers } = mcpResolution;
                approvedScheduleMcpBindings = mcpServerBindings;
                approvalDetails = {
                  ...proposal.details,
                  ...project,
                  ...mcpServers,
                  ...approvalModelSelection,
                  // Consent reflects the current scheduler state at the point
                  // the prompt is published, not the generation-start snapshot.
                  schedulerEnabled: liveSettings.scheduledTasksEnabled !== false,
                };
              } catch (error) {
                deniedToolCalls.add(context.toolCall.id);
                timeline.toolFinished(context.toolCall.id, "blocked");
                return {
                  block: true,
                  reason:
                    error instanceof Error
                      ? error.message
                      : "Aiden rejected this automation change.",
                };
              }
            } else if (createScheduleApproval) {
              try {
                const prepared = await prepareStandardScheduleApproval(
                  context.args,
                  approvalModelSelection,
                  undefined,
                  workspaceId,
                );
                if (signal?.aborted) throw new Error("Scheduled task action was cancelled.");
                preparedStandardScheduleSummary = prepared.summary;
                approvalDetails = prepared.details;
              } catch (error) {
                deniedToolCalls.add(context.toolCall.id);
                timeline.toolFinished(context.toolCall.id, "blocked");
                return {
                  block: true,
                  reason:
                    error instanceof Error
                      ? error.message
                      : "Aiden rejected this scheduled task action.",
                };
              }
            }
            if (memoryApproval) {
              timeline.toolAwaitingApproval(context.toolCall.id);
              let memoryCardShown = false;
              const requestMemoryApproval = async (
                summary: string,
                approvalSignal?: AbortSignal,
              ) => {
                const toolCallId = timeline.publicToolCallId(context.toolCall.id);
                if (!toolCallId) throw new Error("The tool approval step was not initialized.");
                memoryCardShown = true;
                notifyApprovalWaiting();
                return approvals.request(
                  {
                    streamId,
                    toolCallId,
                    toolName: context.toolCall.name,
                    summary: hookAsk ? `${summary}\n\n${hookAsk}` : summary,
                    details: approvalDetails,
                  },
                  approvalSignal,
                  owner.documentId,
                );
              };
              const memoryDecision =
                context.toolCall.name === FORGET_MEMORY_TOOL_NAME
                  ? await authorizeMemoryRemoval(
                      context.args,
                      memoryApprovalContext,
                      async (scope, factId) =>
                        (await memoryStore.list(scope)).find(
                          (fact) => fact.id === factId && fact.state === "active",
                        ),
                      requestMemoryApproval,
                      signal,
                    )
                  : await authorizeMemoryProposal(
                      context.args,
                      memoryApprovalContext,
                      requestMemoryApproval,
                      signal,
                    );
              if (!memoryDecision.allowed) {
                deniedToolCalls.add(context.toolCall.id);
                if (!signal?.aborted) timeline.toolFinished(context.toolCall.id, "blocked");
                return {
                  block: true,
                  reason: memoryDecision.reason,
                };
              }
              if (hookAsk && !memoryCardShown) {
                // Memory allowed this without asking; the hook's ask still shows a card.
                const hookOutcome = await requestMemoryApproval(
                  summarizeToolCall(context.toolCall.name, context.args),
                  signal,
                );
                if (hookOutcome !== "allowed") {
                  if (!signal?.aborted) {
                    deniedToolCalls.add(context.toolCall.id);
                    timeline.toolFinished(context.toolCall.id, "blocked");
                  }
                  return { block: true, reason: toolApprovalBlockReason(hookOutcome, false) };
                }
              }
              timeline.toolRunning(context.toolCall.id);
              return undefined;
            } else if (artifactApproval?.required)
              summary = artifactApproval.summary ?? "Save this artifact.";
            else
              summary = editScheduleApproval
                ? summarizeEditAutomationToolCall(context.args)
                : preparedStandardScheduleSummary
                  ? preparedStandardScheduleSummary
                  : scheduleApproval
                    ? summarizeScheduleToolCall(context.args)
                    : isBrowserToolName(context.toolCall.name)
                      ? browserToolApprovalSummary(context.toolCall.name)
                      : isDeviceToolName(context.toolCall.name)
                        ? deviceToolApprovalSummary(
                            context.toolCall.name,
                            context.args as Record<string, unknown>,
                          )
                        : summarizeToolCall(context.toolCall.name, context.args);
          }
          if (context.toolCall.name === "classify") {
            try {
              const providerId = (context.args as { provider?: unknown }).provider;
              const provider = typeof providerId === "string" ? await configStore.getProvider(providerId) : undefined;
              approvalDetails = classifierApprovalFor(context.args, provider?.label ?? (typeof providerId === "string" ? providerRegistry.builtinProvider(providerId)?.label : undefined));
              summary += ". Review the complete state and questions on the owning desktop before allowing. Full classification inputs are available only in the desktop approval.";
            } catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return { block: true, reason: error instanceof Error ? error.message : "Classification inputs could not be reviewed." };
            }
          }
          if (context.toolCall.name === "generate_image") {
            try { summary += await modelImageReferences.disclosure(context.args, signal); }
            catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return { block: true, reason: error instanceof Error ? error.message : "Reference images could not be verified." };
            }
          }
          if (browserFileApproval?.requiresApproval) {
            summary = `Open this exact local document and its listed assets in Aiden's browser:\n${browserFileApproval.displayPaths.join("\n")}`;
          }
          if (workspaceId && BROWSER_MUTATION_TOOL_NAMES.has(context.toolCall.name)) {
            try {
              const { browserService } = await import("./browser/service.js");
              if (!browserSelection.initialized) {
                const state = await browserService.getState(workspaceId);
                browserSelection.tabId = state.activeTabId ?? undefined;
                browserSelection.initialized = true;
              }
              const args = context.args as Record<string, unknown>;
              const tabId = typeof args.tabId === "string" ? args.tabId : browserSelection.tabId;
              if (!tabId)
                throw new Error("No current browser tab is available. Call browser_open first.");
              browserActionApproval = prepareBrowserToolApproval(
                context.toolCall.name,
                args,
                browserService.getApprovalTarget(workspaceId, tabId),
              );
              args.tabId = browserActionApproval.target.tabId;
              summary = browserActionApproval.summary;
            } catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return {
                block: true,
                reason:
                  error instanceof Error
                    ? error.message
                    : "Browser approval target is unavailable.",
              };
            }
          }
          if (hookAsk) summary = `${summary}\n\n${hookAsk}`;
          timeline.toolAwaitingApproval(context.toolCall.id);
          notifyApprovalWaiting();
          const approvalOutcome = await approvals.request(
            (() => {
              const toolCallId = timeline.publicToolCallId(context.toolCall.id);
              if (!toolCallId) throw new Error("The tool approval step was not initialized.");
              return {
                streamId,
                toolCallId,
                toolName: context.toolCall.name,
                summary,
                details: approvalDetails,
                ...(() => {
                  const preview = approvalDetails ? undefined : toolApprovalPreview(context.toolCall.name, context.args);
                  return preview ? { preview } : {};
                })(),
                ...(scopedRuleTarget ? { scopes: SCOPED_APPROVAL_OFFER } : {}),
              };
            })(),
            signal,
            owner.documentId,
          );
          const allowed = approvalOutcome === "allowed";
          if (allowed && context.toolCall.name === WORKSPACE_ARTIFACT_TOOL_NAME && artifactApprovalDigest) {
            const calls = approvedWorkspaceArtifactCalls.get(streamId) ?? new Map<string, string>();
            calls.set(context.toolCall.id, artifactApprovalDigest);
            approvedWorkspaceArtifactCalls.set(streamId, calls);
          }
          if (allowed && scopedRuleTarget) {
            const toolCallId = timeline.publicToolCallId(context.toolCall.id);
            const scope = toolCallId
              ? approvals.takeDecisionPayload(streamId, toolCallId)?.scope
              : undefined;
            if (scope === "chat" || scope === "always") {
              try {
                const workspaceLabel =
                  scope === "always"
                    ? (await configStore.getWorkspace(scopedRuleTarget.workspaceId))?.name
                    : undefined;
                await toolApprovalRules.grant(scope, params.chatId, scopedRuleTarget, workspaceLabel);
              } catch (error) {
                // The user already allowed this call; a failed remember only
                // means the next identical call asks again.
                logger.warn("pi", "Could not remember a scoped tool approval.", error);
              }
            }
          }
          if (!allowed && !signal?.aborted) deniedToolCalls.add(context.toolCall.id);
          if (allowed && (browserFileApproval || browserActionApproval)) {
            try {
              signal?.throwIfAborted();
              if (browserFileApproval) {
                (await import("./browser/files.js")).browserFileService.approve(
                  browserFileApproval,
                );
                browserFileApprovals.set(context.toolCall.id, browserFileApproval);
              }
              if (browserActionApproval && workspaceId) {
                const { browserService } = await import("./browser/service.js");
                const args = context.args as Record<string, unknown>;
                assertBrowserToolApproval(
                  browserActionApproval,
                  context.toolCall.name,
                  args,
                  browserService.getApprovalTarget(workspaceId, browserActionApproval.target.tabId),
                );
                browserActionApprovals.set(context.toolCall.id, {
                  approval: browserActionApproval,
                  args,
                });
              }
            } catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return {
                block: true,
                reason: error instanceof Error ? error.message : "Browser approval expired.",
              };
            }
          }
          if (allowed && attendedScheduleApproval) {
            attachAssistantScheduleMcpApproval(context.args, approvedScheduleMcpBindings);
          }
          if (allowed) timeline.toolRunning(context.toolCall.id);
          else if (!signal?.aborted) timeline.toolFinished(context.toolCall.id, "blocked");
          if (allowed && formFill && context.toolCall.name === FORM_FILL_TOOL_NAME) {
            try {
              if (!formFillApproval) throw new Error("The form-fill approval was not prepared.");
              const toolCallId = timeline.publicToolCallId(context.toolCall.id);
              const payload = toolCallId
                ? approvals.takeDecisionPayload(streamId, toolCallId)
                : undefined;
              formFill.authorize(
                context.toolCall.id,
                formFillApproval.planId,
                formFillApproval.digest,
                payload?.formFillExcludedOrders ?? [],
              );
            } catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return {
                block: true,
                reason: error instanceof Error ? error.message : "Form-fill approval expired.",
              };
            }
          }
          return allowed
            ? undefined
            : {
                block: true,
                reason: toolApprovalBlockReason(approvalOutcome, attendedScheduleApproval),
              };
        },
      });

      candidate.subscribe(async (event) => {
        pace.observe(event);
        switch (event.type) {
          case "agent_end":
            cacheWarmer?.dispose();
            visualDrafts.dispose();
            break;
          case "message_start":
            if (event.message.role === "assistant") {
              requestUsage.started();
              currentAssistantTurnHadVisibleText = false;
              currentAssistantTurnHadReasoningDelta = false;
              currentAssistantTurnContinuesCutOff = continuingCutOffReply;
              currentAssistantTurnStart = {
                full: full.length,
                reasoning: reasoning.length,
                steps: timeline.beginAssistantMessage(),
              };
            }
            break;
          case "message_update": {
            const e = event.assistantMessageEvent;
            // Reasoning time is timed against the host clock: pi reports the
            // block boundaries but never a duration. Recorded even when the
            // provider's reasoning text stays hidden, since only the elapsed
            // time is shown.
            if (e.type === "thinking_start") {
              timeline.thinkingStarted();
              noteModelBecameReady();
            } else if (e.type === "thinking_end") timeline.thinkingEnded();
            if (e.type === "toolcall_start") {
              // Tool-call arguments can stream for a long while (a full HTML
              // artifact for render_artifact) before execution begins. Open the
              // pending step now so the transcript shows live activity through
              // that window for every provider; execution events upgrade it.
              // Some OpenAI-compatible backends stream an empty id first and
              // backfill it later, so wait for a usable one.
              const block = e.partial.content[e.contentIndex];
              if (
                block?.type === "toolCall" &&
                typeof block.id === "string" &&
                block.id &&
                typeof block.name === "string"
              ) {
                timeline.toolStarted(block.id, block.name, {});
              }
            }
            if (e.type === "toolcall_delta" || e.type === "toolcall_end") {
              // Stream a render_artifact call's partial HTML to a draft preview.
              const block = e.partial.content[e.contentIndex];
              if (block?.type === "toolCall" && typeof block.id === "string" && block.id) {
                if (e.type === "toolcall_delta") {
                  visualDrafts.delta(block.id, block.name, block.arguments);
                } else {
                  visualDrafts.end(block.id);
                }
              }
            }
            if (e.type === "text_delta") {
              const separator = !currentAssistantTurnHadVisibleText && !currentAssistantTurnContinuesCutOff
                ? assistantTurnTextSeparator(full, e.delta)
                : "";
              const delta = `${separator}${e.delta}`;
              full += delta;
              if (e.delta.trim()) currentAssistantTurnHadVisibleText = true;
              timeline.setContentOffset(full.length);
              noteModelBecameReady();
              sendGeneration(streamId, "chat:delta", {
                streamId,
                delta,
              });
            } else if (e.type === "thinking_delta" && exposeReasoning) {
              const separator =
                !currentAssistantTurnHadReasoningDelta && reasoning.trim() ? "\n\n" : "";
              const delta = `${separator}${e.delta}`;
              reasoning += delta;
              timeline.reasoningDelta(reasoning.length - e.delta.length, reasoning.length);
              currentAssistantTurnHadReasoningDelta = true;
              noteModelBecameReady();
              sendGeneration(streamId, "chat:reasoning-delta", {
                streamId,
                delta,
              });
            }
            break;
          }
          case "message_end": {
            if (event.message.role === "user") return;
            if (event.message.role === "assistant") {
              requestUsage.ended();
              lastAssistantMessage = event.message;
              turnUsage = addTurnUsage(turnUsage, reportedTokens(event.message.usage));
              try {
                await usageStore.record(
                  assistantUsageRecord({
                    message: event.message,
                    provider: runtime.provider,
                    model,
                    source: options.usageSource ?? "chat",
                  }),
                );
              } catch (error) {
                logger.warn(
                  "usage",
                  `Could not record provider usage for stream ${streamId}.`,
                  error,
                );
              }
            }
            if (event.message.role === "assistant") {
              if (event.message.stopReason === "error") {
                failedAssistantTurnStart = {
                  full: currentAssistantTurnStart.full,
                  reasoning: currentAssistantTurnStart.reasoning,
                };
              } else if (event.message.stopReason !== "aborted") {
                continuingCutOffReply = false;
              }
            }
            const streamedTurn = full.slice(currentAssistantTurnStart.full);
            const projection = reconcileTerminalAssistantProjection(
              { full, reasoning },
              currentAssistantTurnStart,
              event.message,
              exposeReasoning,
              currentAssistantTurnContinuesCutOff,
            );
            if (projection.changed) {
              full = projection.full;
              reasoning = projection.reasoning;
              // Rebuild the whole visible projection after provider block
              // interleaving or a terminal-only response.
              sendGeneration(streamId, "chat:delta", {
                streamId,
                delta: "",
                reset: true,
              });
              if (full) {
                sendGeneration(streamId, "chat:delta", {
                  streamId,
                  delta: full,
                });
              }
              if (reasoning) {
                sendGeneration(streamId, "chat:reasoning-delta", {
                  streamId,
                  delta: reasoning,
                });
              }
            }
            const canonicalTurn = full.slice(currentAssistantTurnStart.full);
            const anchors = terminalAssistantActivityAnchors(event.message);
            timeline.reconcileContentOffset(
              currentAssistantTurnStart.full,
              streamedTurn,
              canonicalTurn,
              anchors ? {
                stepStart: currentAssistantTurnStart.steps,
                textStart: canonicalTurn.length - terminalAssistantText(event.message).length,
                ...anchors,
              } : undefined,
            );
            if (exposeReasoning) {
              const segments = terminalAssistantThinkingSegments(event.message);
              if (segments !== null) {
                const terminalReasoning = terminalAssistantReasoning(event.message);
                const base = reasoning.length - terminalReasoning.length;
                timeline.reconcileReasoningSegments(
                  currentAssistantTurnStart.steps,
                  segments.map((span) => ({ start: base + span.start, end: base + span.end })),
                  reasoning.length,
                );
              }
            }
            break;
          }
          case "tool_execution_start":
            timeline.toolStarted(event.toolCallId, event.toolName, event.args);
            sendGeneration(streamId, "chat:tool", {
              streamId,
              phase: "call",
              toolName: event.toolName,
            });
            break;
          case "tool_execution_update":
            timeline.toolRunning(event.toolCallId);
            break;
          case "tool_execution_end": {
            // Nested calls emit their own events; the enclosing codemode usage
            // includes these again, so only the actual paid operation counts.
            turnUsage = addTurnUsage(turnUsage, reportedTokens(piModelOperationUsage(event.toolName, event.result)));
            const denied = deniedToolCalls.delete(event.toolCallId);
            const terminalStatus = generationCancelRequested()
              ? "cancelled"
              : denied
                ? "blocked"
                : event.isError
                  ? "failed"
                  : "completed";
            // Retract the call's draft whatever the outcome: a successful call
            // has already presented (and a same-title replace presents under
            // the first call's id, so its own draft would otherwise linger).
            visualDrafts.cancel(event.toolCallId);
            if (
              attendedAssistant &&
              event.isError &&
              (event.toolName === SCHEDULE_TOOL_NAME ||
                event.toolName === EDIT_AUTOMATION_TOOL_NAME) &&
              Array.isArray(event.result?.content)
            ) {
              const reason = event.result.content.find(
                (item: { type?: unknown; text?: unknown }) =>
                  item.type === "text" && typeof item.text === "string",
              )?.text;
              logger.warn("pi", `Attended schedule proposal failed for stream ${streamId}.`, {
                reason: typeof reason === "string" ? reason.slice(0, 320) : "Unknown error.",
              });
            }
            timeline.toolFinished(
              event.toolCallId,
              terminalStatus,
              terminalStatus === "completed"
                ? event.result?.details
                : safeToolIssueDetails(event.toolName, terminalStatus, event.result),
            );
            sendGeneration(streamId, "chat:tool", {
              streamId,
              phase: denied ? "blocked" : event.isError ? "error" : "result",
              toolName: event.toolName,
            });
            // A failed command may still have written files, so only a denied call is skipped.
            if (!denied) notifyWorkspaceFilesTouched(workspaceId, event.toolName);
            break;
          }
          default:
            break;
        }
      });
    } catch (error) {
      cacheWarmer?.dispose();
      visualDrafts.dispose();
      if (candidate) resetGenerationAgent(candidate, streamId);
      endLoadMonitor(initialization, streamId, false);
      formFill?.revoke();
      await computerUse?.close().catch(() => {});
      if (initialization.cancelRequested || initialization.controller.signal.aborted) {
        await persistInitializationTerminal("cancelled", initialization.cancellationOrigin);
        sendGeneration(streamId, "chat:done", {
          streamId,
          content: "",
          cancelled: true,
          cancellationOrigin: initialization.cancellationOrigin,
        });
        releaseGenerationSkillReservation(initialization);
        releaseGenerationBotAuthority(initialization);
        approvedWorkspaceArtifactCalls.delete(streamId);
        initializing.delete(streamId);
        initialization.removeOwnerInvalidation();
        approvals.releaseStream(streamId);
        questionnaires.releaseStream(streamId);
        broadcastChatSettled(
          streamId,
          params.chatId,
          initialization.workspaceId,
          params.workspaceId,
        );
        return false;
      }
      await persistInitializationTerminal("failed");
      releaseGenerationSkillReservation(initialization);
      releaseGenerationBotAuthority(initialization);
      approvedWorkspaceArtifactCalls.delete(streamId);
      initializing.delete(streamId);
      initialization.removeOwnerInvalidation();
      approvals.releaseStream(streamId);
      questionnaires.releaseStream(streamId);
      broadcastChatSettled(streamId, params.chatId, initialization.workspaceId, params.workspaceId);
      throw error;
    }
    const agent = candidate;
    if (!agent || !piSession) {
      await persistInitializationTerminal("failed");
      endLoadMonitor(initialization, streamId, false);
      releaseGenerationSkillReservation(initialization);
      releaseGenerationBotAuthority(initialization);
      approvedWorkspaceArtifactCalls.delete(streamId);
      initializing.delete(streamId);
      initialization.removeOwnerInvalidation();
      approvals.releaseStream(streamId);
      questionnaires.releaseStream(streamId);
      broadcastChatSettled(streamId, params.chatId, initialization.workspaceId, params.workspaceId);
      throw new Error("Could not initialize the generation agent.");
    }
    const piJournal = piSession;
    let piTurnLease: PiVisibleTurnLease | undefined;
    let pendingPiDurabilitySettlement: Promise<void> | undefined;
    let reconcileAbandonedVisibleAssistant = false;
    let quarantineSessionFailureWithoutLease = false;
    const quarantineFailedPiRecovery = (message: string, error: unknown) => {
      piJournalHealthy = false;
      logger.error("pi", message, error);
      if (!piJournalless) {
        piCompactionSessionStore.quarantineChatUntilRecovered(
          params.chatId,
          Promise.reject(new Error("Pi journal recovery requires application restart.")),
        );
      }
    };
    const finalizePiTurnPersistence = async (persisted: {
      chat: Chat | undefined;
      error: string | undefined;
      messageId: string | undefined;
    }) => {
      const detachedSettlement = pendingPiDurabilitySettlement;
      if (detachedSettlement) {
        piJournalHealthy = false;
        pendingPiDurabilitySettlement = undefined;
        const recovery = detachedSettlement.then(async () => {
          const detachedLease = piTurnLease;
          if (!detachedLease) return;
          await detachedLease.rollback();
          if (persisted.chat) {
            const messagesBeforeAssistant = persisted.chat.messages.filter(
              (message) => message.id !== persisted.messageId,
            );
            await syncChatMessagesToPiSession(
              piJournal,
              messagesBeforeAssistant,
              model,
              supportsImages,
              journalContentOverrides,
            );
          }
          await agent.reconcileDurableEvidenceAfterRollback();
          const visibleAssistant = persisted.chat?.messages.find(
            (message) => message.id === persisted.messageId,
          );
          if (visibleAssistant) {
            await syncChatMessagesToPiSession(piJournal, [visibleAssistant], model, supportsImages);
          }
        });
        if (!piJournalless) {
          piCompactionSessionStore.quarantineChatUntilRecovered(params.chatId, recovery);
        }
        return;
      }
      const turnLease = piTurnLease;
      if (!turnLease) {
        piJournalHealthy = false;
        if (quarantineSessionFailureWithoutLease) {
          quarantineFailedPiRecovery(
            `A pre-lease Pi session failure quarantined stream ${streamId}.`,
            new Error("The Pi session failed before its visible-turn lease opened."),
          );
        }
        return;
      }
      if (persisted.error) {
        try {
          await turnLease.rollback();
          await agent.reconcileDurableEvidenceAfterRollback();
        } catch (error) {
          quarantineFailedPiRecovery(
            `Could not roll back an unpersisted Pi turn for stream ${streamId}.`,
            error,
          );
        }
        piJournalHealthy = false;
        return;
      }
      if (!persisted.messageId) {
        try {
          await turnLease.rollback();
        } catch (error) {
          quarantineFailedPiRecovery(
            `Could not roll back an assistant-less Pi turn for stream ${streamId}.`,
            error,
          );
        }
        return;
      }
      const reconcileVisibleAssistant = async () => {
        await turnLease.rollback();
        await agent.reconcileDurableEvidenceAfterRollback();
        const visible = persisted.chat?.messages.find(
          (message) => message.id === persisted.messageId,
        );
        if (!visible) {
          throw new Error("The persisted assistant could not be found for Pi journal recovery.");
        }
        await syncChatMessagesToPiSession(piJournal, [visible], model, supportsImages);
      };
      if (!piJournalHealthy) {
        try {
          await reconcileVisibleAssistant();
        } catch (recoveryError) {
          quarantineFailedPiRecovery(
            `Could not reconcile the persisted assistant after a Pi batch failure for stream ${streamId}.`,
            recoveryError,
          );
        }
        return;
      }
      try {
        if (reconcileAbandonedVisibleAssistant) {
          const visible = persisted.chat?.messages.find(
            (message) => message.id === persisted.messageId,
          );
          if (!visible) {
            throw new Error("The persisted assistant could not be found before Pi journal commit.");
          }
          // Recovery removed this failed Pi message. Reconcile only its safe
          // visible partial; healthy tool loops already have canonical
          // multi-message history and must not gain an aggregate duplicate.
          await syncChatMessagesToPiSession(piJournal, [visible], model, supportsImages);
        }
        await turnLease.commit(persisted.messageId, {
          markerAlreadyPersisted: reconcileAbandonedVisibleAssistant,
        });
        try {
          if (!piJournalless) {
            await piRuntimeEffectStore.acknowledgeChatEffectsDurable(params.chatId);
          }
        } catch (error) {
          // The Pi turn is already durable. Leaving the effect unacknowledged
          // makes startup install a conservative no-repeat boundary.
          logger.warn("pi", `Could not acknowledge durable effects for stream ${streamId}.`, error);
        }
      } catch (error) {
        logger.warn(
          "pi",
          `Could not mark persisted assistant message for stream ${streamId}.`,
          error,
        );
        try {
          await reconcileVisibleAssistant();
        } catch (recoveryError) {
          quarantineFailedPiRecovery(
            `Could not reconcile the persisted assistant after a Pi marker failure for stream ${streamId}.`,
            recoveryError,
          );
        }
      }
    };
    subagentSupervisor?.observePendingUserGuidance(() => agent.hasUndeliveredSteer());
    const activeGeneration: ActiveGeneration = {
      agent,
      chatId: params.chatId,
      owner,
      removeOwnerInvalidation: initialization.removeOwnerInvalidation,
      stopCacheWarming: initialization.stopCacheWarming,
      workspaceId: initialization.workspaceId,
      cancelRequested: initialization.cancelRequested,
      cancellationOrigin: initialization.cancellationOrigin,
      rendererDetached: initialization.rendererDetached,
      computerUse,
      formFill,
      inputClosed: designWiring?.inputClosed ?? false,
      ...(chatHooks
        ? {
            inputHooks: {
              screen: async ({ text, messageId }) => {
                try {
                  const screening = await screenRunInputWithHooks({
                    dispatch: chatHooks.dispatch,
                    text,
                    idempotencyKey: `UserPromptSubmit:${params.chatId}:${streamId}:${messageId}`,
                    signal: initialization.controller.signal,
                  });
                  if ("blocked" in screening) {
                    sendGeneration(streamId, "chat:status", {
                      streamId,
                      phase: "hook_messages",
                      messages: [screening.blocked],
                    });
                  }
                  return screening;
                } catch (error) {
                  // The same as a failed dispatch at the start of a turn: no outcome.
                  logger.error("hooks", "UserPromptSubmit for run input failed.", error);
                  return {};
                }
              },
              attachContext: hookInputContexts.attach,
            },
          }
        : {}),
      ...(subagentSupervisor
        ? {
            stopSubagentsForGuidance: () => {
              subagentSupervisor.stopLiveChildrenForGuidance();
            },
          }
        : {}),
      completion: null,
      loadMonitor: initialization.loadMonitor,
      releaseSkillReservation: initialization.releaseSkillReservation,
      releaseBotAuthority: initialization.releaseBotAuthority,
    };
    initialization.releaseSkillReservation = () => {};
    initialization.releaseBotAuthority = () => {};
    initialization.loadMonitor = undefined;
    loadHost = activeGeneration;
    // Publish the active owner before removing initialization so cancellation
    // cannot fall into a map-transition gap and leave a privileged run alive.
    active.set(streamId, activeGeneration);
    initializing.delete(streamId);
    if (initialization.cancelRequested || activeGeneration.cancelRequested) {
      await persistInitializationTerminal("cancelled", activeGeneration.cancellationOrigin);
      await piTurnLease?.rollback().catch((error) => {
        logger.error(
          "pi",
          `Could not roll back the cancelled Pi turn for stream ${streamId}.`,
          error,
        );
      });
      cacheWarmer?.dispose();
      visualDrafts.dispose();
      resetGenerationAgent(agent, streamId);
      endLoadMonitor(activeGeneration, streamId, false);
      formFill?.revoke();
      await computerUse?.close().catch(() => {});
      sendGeneration(streamId, "chat:done", {
        streamId,
        content: "",
        cancelled: true,
        cancellationOrigin: activeGeneration.cancellationOrigin,
      });
      releaseGenerationSkillReservation(activeGeneration);
      releaseGenerationBotAuthority(activeGeneration);
      approvedWorkspaceArtifactCalls.delete(streamId);
      active.delete(streamId);
      activeGeneration.removeOwnerInvalidation();
      approvals.releaseStream(streamId);
      questionnaires.releaseStream(streamId);
      broadcastChatSettled(
        streamId,
        params.chatId,
        activeGeneration.workspaceId,
        params.workspaceId,
      );
      return false;
    }

    if (generationChat.computerUsePendingContinue === true) {
      // A new turn that actually started supersedes the post-restart Continue
      // callout. Cleared only now, so a start that fails keeps it.
      try {
        await chatStore.setComputerUsePendingContinue(params.chatId, false);
      } catch (error) {
        logger.warn("pi", "Could not clear the chat's Computer Use continue marker.", error);
      }
    }

    // Accepted steer input that Pi never emitted into the visible chat (Stop,
    // a terminal before the next step, or a failed projection). It rides on
    // the terminal event so the renderer can restore it instead of losing it.
    // Collection never waits on host storage: a projection that Stop stopped
    // waiting for is returned later, only if its visible save did not land.
    let undeliveredGuidance: string[] = [];
    let undeliveredGuidanceCollected = false;
    const collectUndeliveredGuidance = () => {
      if (undeliveredGuidanceCollected) return;
      undeliveredGuidanceCollected = true;
      try {
        const taken = agent.takeUndeliveredQueuedMessages();
        undeliveredGuidance = queuedGuidanceText(taken.messages);
        if (taken.late) {
          const owner = ownerForStream(streamId);
          void taken.late.then(
            (messages) =>
              returnLateGuidance(owner, params.chatId, streamId, queuedGuidanceText(messages)),
            (error: unknown) => {
              logger.warn("pi", `Could not settle late guidance for stream ${streamId}.`, error);
            },
          );
        }
      } catch (error) {
        logger.warn("pi", `Could not collect undelivered guidance for stream ${streamId}.`, error);
      }
    };
    const withUndeliveredGuidance = <T extends object>(payload: T) =>
      undeliveredGuidance.length > 0 ? { ...payload, undeliveredGuidance } : payload;
    const unregisterAcpHost =
      harnessProvider &&
      canHostAcpHarness({
        rendererOwner: owner.id !== 0,
        remoteOwner: owner.kind === "remote",
        bot: preparedBotContext !== undefined,
        assistant: authoritativeMode !== undefined,
        usageSource: options.usageSource,
        interactionSurface: options.interactionSurface,
      })
        ? acpHosts.register(
            createAcpGenerationHost({
              chatId: params.chatId,
              streamId,
              label: runtime.provider.label,
              folderPath,
              // Bind file access to this exact directory for the whole turn.
              ...(folderPath
                ? {
                    folderIdentity: await captureRootIdentity(folderPath).catch((error: unknown) => {
                      // No identity means no agent file access this turn.
                      logger.warn("acp", "Could not capture the chat folder identity; agent file access is off.", error);
                      return undefined;
                    }),
                  }
                : {}),
              scratchDir: await acpScratch.directoryFor(params.chatId),
              permission: () => permission,
              timeline,
              requestApproval: (prompt, approvalSignal) => approvals.request(prompt, approvalSignal, owner.documentId),
              takeApprovalScope: (approvalStreamId, toolCallId) =>
                approvals.takeDecisionPayload(approvalStreamId, toolCallId)?.scope,
              requestQuestion: (toolCallId, questions, questionSignal) =>
                questionnaires.request({ streamId, toolCallId, questions }, owner.documentId, questionSignal),
            }),
          )
        : undefined;
    // A throw before the outcome is known is Aiden's failure, not the provider's.
    let designOutcome: DesignRunOutcome = "host_failed";
    const completion = (async () => {
      try {
        const fullLengthBeforeAttempt = full.length;
        const reasoningLengthBeforeAttempt = reasoning.length;
        const runtimeOutcome = await agent.runManaged(
          currentPromptMessage
            ? { kind: "append-and-run", message: currentPromptMessage }
            : { kind: "continue-durable-tail" },
          {
            beforeDurableTurn: async (signal) => {
              const lease = await beginPiVisibleTurnLease(piJournal, (error) => {
                logger.warn(
                  "pi",
                  `Could not begin the crash-recovery envelope for stream ${streamId}.`,
                  error,
                );
              });
              if (signal.aborted) {
                await lease.rollback();
                return;
              }
              piTurnLease = lease;
              if (!lease.started) {
                piJournalHealthy = false;
                throw new Error("The Pi visible-turn transaction did not start.");
              }
            },
            onRetry: (retry) => {
              // A dropped stream's text stays when the next try continues it.
              // Otherwise only the failed turn's text goes: earlier turns of
              // this run stay in the model's context, so they stay visible too.
              if (!retry.keepsPartial) {
                full = full.slice(0, Math.max(fullLengthBeforeAttempt, failedAssistantTurnStart?.full ?? 0));
                reasoning = reasoning.slice(
                  0,
                  Math.max(reasoningLengthBeforeAttempt, failedAssistantTurnStart?.reasoning ?? 0),
                );
                timeline.rewindContentOffset(full.length);
                timeline.rewindReasoningOffset(reasoning.length);
                sendGeneration(streamId, "chat:delta", {
                  streamId,
                  delta: "",
                  reset: true,
                });
                if (full) sendGeneration(streamId, "chat:delta", { streamId, delta: full });
                if (reasoning) sendGeneration(streamId, "chat:reasoning-delta", { streamId, delta: reasoning });
              }
              // The working row counts down to the next try; Stop cancels the wait.
              if (retry.reason === "provider") {
                sendGeneration(streamId, "chat:status", {
                  streamId,
                  phase: "retrying",
                  retry: {
                    attempt: retry.attempt,
                    maxAttempts: retry.maxAttempts,
                    retryAt: Date.now() + retry.delayMs,
                  },
                });
              }
            },
            maxCutOffContinuations: MAX_CUT_OFF_CONTINUATIONS,
            onContinue: () => {
              continuingCutOffReply = true;
            },
            // A Stop hook may keep the person's turn going, at most
            // MAX_STOP_HOOK_CONTINUATIONS times. The harness never asks after
            // an abort, an error or the person's Stop; a spending block wins.
            ...(chatHooks
              ? {
                  onStop: async (event: PiRuntimeStopEvent) => {
                    await spendingMeter.settled();
                    if (await spending.block(spendingOwner).catch(() => undefined)) return undefined;
                    return chatHooks.onStop(event);
                  },
                  maxStopContinuations: MAX_STOP_HOOK_CONTINUATIONS,
                }
              : {}),
          },
        );
        pendingPiDurabilitySettlement = agent.pendingDurabilitySettlement();
        collectUndeliveredGuidance();
        reconcileAbandonedVisibleAssistant = runtimeOutcome.finalMessageWasAbandoned === true;
        quarantineSessionFailureWithoutLease =
          runtimeOutcome.kind === "host_failed" && runtimeOutcome.faultKind === "session";
        lastAssistantMessage = runtimeOutcome.finalMessage ?? lastAssistantMessage;
        const wasCancelled =
          runtimeOutcome.kind === "app_cancelled" || activeGeneration.cancelRequested;
        if (wasCancelled && requestUsage.takeUnreportedCancellation()) {
          try {
            await usageStore.record(
              unreportedUsageRecord({
                source: options.usageSource ?? "chat",
                providerId: runtime.provider.id,
                providerLabel: runtime.provider.label,
                modelId: model.id,
                modelLabel: model.name,
                local: isLocalProviderDeployment(runtime.provider),
                status: "cancelled",
              }),
            );
          } catch (error) {
            logger.warn(
              "usage",
              `Could not record cancelled provider request for stream ${streamId}.`,
              error,
            );
          }
        }
        const emergencyError = generationEmergencyUserError(runtimeOutcome.emergencyProjection);
        let replyNotSaved = false;
        const finalError =
          emergencyError ??
          (runtimeOutcome.kind === "provider_failed"
            ? runtimeOutcome.reason === "output-limit"
              ? "The model reached its output limit."
              : runtimeOutcome.reason === "context-overflow"
                ? "The model context was too large to recover safely."
                : runtimeOutcome.reason === "compaction-failed"
                  ? "The model context could not be compacted safely."
                  : runtimeOutcome.reason === "interrupted"
                    ? "The provider interrupted the response."
                    : "The model could not complete this response."
            : runtimeOutcome.kind === "host_failed"
              ? "The local agent runtime could not complete this response safely."
              : null);
        if (finalError) {
          const finalTimeline = attachClaimCheck(timeline.finish("failed"), full, claimCheckOptions);
          const persisted = await persistAssistant(
            full,
            reasoning,
            finalTimeline,
            runtimeOutcome.kind === "provider_failed" ? runtimeOutcome.providerFailure : undefined,
          );
          await finalizePiTurnPersistence(persisted);
          sendGeneration(streamId, "chat:error", withUndeliveredGuidance({
            streamId,
            message: persisted.error
              ? `${finalError} The partial response could not be saved: ${persisted.error}`
              : finalError,
            content: full || undefined,
            reasoning: reasoning || undefined,
            timeline: finalTimeline,
            chat: chatForRenderer(persisted.chat ?? null) ?? undefined,
          }));
        } else if (
          !generationHasVisibleOutput(
            full,
            uniqueResponseImages(sharedImages, displayedImages).length +
              displayedHtmlArtifacts.length +
              displayedUiVisuals.length +
              (designRun?.acceptedCount() ?? 0),
          ) &&
          !wasCancelled
        ) {
          const finalTimeline = attachClaimCheck(timeline.finish("failed"), full, claimCheckOptions);
          const persisted = await persistAssistant(full, reasoning, finalTimeline);
          await finalizePiTurnPersistence(persisted);
          sendGeneration(streamId, "chat:error", withUndeliveredGuidance({
            streamId,
            message: persisted.error
              ? `The model returned an empty response, and its steps could not be saved: ${persisted.error}`
              : "The model returned an empty response. Try again.",
            reasoning: reasoning || undefined,
            timeline: finalTimeline,
            chat: chatForRenderer(persisted.chat ?? null) ?? undefined,
          }));
        } else {
          // Covers both normal completion and user abort (partial `full`).
          const finalTimeline = attachClaimCheck(
            timeline.finish(
              wasCancelled ? "cancelled" : "completed",
              wasCancelled ? activeGeneration.cancellationOrigin : undefined,
            ),
            full,
            claimCheckOptions,
          );
          const persisted = await persistAssistant(full, reasoning, finalTimeline);
          await finalizePiTurnPersistence(persisted);
          replyNotSaved = Boolean(persisted.error);
          if (persisted.error) {
            sendGeneration(streamId, "chat:error", withUndeliveredGuidance({
              streamId,
              message: `The response completed but could not be saved: ${persisted.error}`,
              content: full || undefined,
              reasoning: reasoning || undefined,
              timeline: finalTimeline,
            }));
          } else {
            sendGeneration(streamId, "chat:done", withUndeliveredGuidance({
              streamId,
              content: full,
              reasoning: reasoning || undefined,
              timeline: finalTimeline,
              chat: chatForRenderer(persisted.chat ?? null) ?? undefined,
            }));
          }
        }
        // Only after persistence: a reply that throws while saving stays host_failed.
        designOutcome = designRunOutcome({
          runtimeKind: runtimeOutcome.kind,
          emergency: Boolean(emergencyError),
          cancelled: wasCancelled,
          cancellationOrigin: activeGeneration.cancellationOrigin,
          persistenceFailed: replyNotSaved,
        });
      } catch (error) {
        pendingPiDurabilitySettlement ??= agent.pendingDurabilitySettlement();
        collectUndeliveredGuidance();
        logger.error("pi", `Generation failed for stream ${streamId}`, error);
        const finalTimeline = attachClaimCheck(timeline.finish("failed"), full, claimCheckOptions);
        const persisted = await persistAssistant(full, reasoning, finalTimeline);
        await finalizePiTurnPersistence(persisted);
        sendGeneration(streamId, "chat:error", withUndeliveredGuidance({
          streamId,
          message: persisted.error
            ? `The local agent runtime failed, and the partial response could not be saved: ${persisted.error}`
            : "The local agent runtime failed.",
          content: full || undefined,
          reasoning: reasoning || undefined,
          timeline: finalTimeline,
          chat: chatForRenderer(persisted.chat ?? null) ?? undefined,
        }));
      } finally {
        try {
          endLoadMonitor(activeGeneration, streamId, false);
          cacheWarmer?.dispose();
          visualDrafts.dispose();
          resetGenerationAgent(agent, streamId);
          formFill?.revoke();
          await computerUse?.close().catch(() => {});
        } finally {
          // A run that ended for any reason (failure included) owns no more
          // child work; nothing may keep acting for it after it settles.
          subagentRuntimeRegistry.abortGeneration(streamId);
          unregisterAcpHost?.();
          invalidateChatContextJournal(params.chatId);
          releaseGenerationSkillReservation(activeGeneration);
          releaseGenerationBotAuthority(activeGeneration);
          approvedWorkspaceArtifactCalls.delete(streamId);
          active.delete(streamId);
          activeGeneration.removeOwnerInvalidation();
          approvals.releaseStream(streamId);
          questionnaires.releaseStream(streamId);
          broadcastChatSettled(
            streamId,
            params.chatId,
            activeGeneration.workspaceId,
            params.workspaceId,
          );
          // Exactly once per started run; pre-run failures reach DesignRunService through start().
          designRun?.onSettled(designOutcome);
        }
      }
    })();
    activeGeneration.completion = completion;
    void completion;
    return true;
  },

  /** Resolve a pending tool-approval request from the UI. */
  approve(
    approvalId: string,
    decision: ApprovalDecision,
    ownerDocumentId?: string,
    payload?: ToolApprovalDecisionPayload,
  ): boolean {
    return (
      approvals.decide(approvalId, decision === "allow", ownerDocumentId, payload) ||
      // Bot approvals are owned by the profile, not a renderer document, and
      // are identified by their durable `waitId`.
      botApprovals.decide(approvalId, decision)
    );
  },

  /**
   * Host-authority approval for a paired controller holding `runs:control`.
   * No owner-document check; the decision is still one-shot, so this returns
   * false when the host UI, a phone or another controller already answered.
   */
  approveAsHost(
    approvalId: string,
    decision: ApprovalDecision,
    payload?: ToolApprovalDecisionPayload,
  ): boolean {
    return (
      approvals.decideAsHost(approvalId, decision === "allow", payload) ||
      botApprovals.decide(approvalId, decision)
    );
  },

  /** Host-authority questionnaire answer; same one-shot rule as `approveAsHost`. */
  answerQuestionnaireAsHost(promptId: string, response: unknown): AskUserQuestionRespondOutcome {
    return questionnaires.respondAsHost(promptId, response);
  },

  answerQuestionnaire(promptId: string, response: unknown, ownerDocumentId: string): boolean {
    return questionnaires.respond(promptId, response, ownerDocumentId);
  },

  /** Desktop answer path: distinguishes an expired prompt from a foreign one. */
  answerQuestionnaireWithOutcome(
    promptId: string,
    response: unknown,
    ownerDocumentId: string,
  ): AskUserQuestionRespondOutcome {
    return questionnaires.respondWithOutcome(promptId, response, ownerDocumentId);
  },

  /**
   * Release renderer-owned interaction surfaces without stopping the
   * main-owned model operation. Terminal chat state is reconciled by the
   * detached-stream listener in the renderer shell.
   */
  detachRenderer(streamId: string, ownerDocumentId?: string): boolean {
    const initialization = initializing.get(streamId);
    const generation = active.get(streamId);
    const owner = initialization?.owner ?? generation?.owner;
    if (!owner || (ownerDocumentId !== undefined && owner.documentId !== ownerDocumentId)) {
      return false;
    }
    if (initialization?.rendererDetached || generation?.rendererDetached) {
      return false;
    }
    if (initialization) initialization.rendererDetached = true;
    if (generation) generation.rendererDetached = true;
    const runtimeOwner = generation ?? initialization;
    if (!runtimeOwner) return false;
    runtimeOwner.stopCacheWarming?.();
    endLoadMonitor(runtimeOwner, streamId, false);
    runtimeOwner.formFill?.revoke();
    void runtimeOwner.computerUse?.close();
    approvals.detachStream(streamId);
    questionnaires.detachStream(streamId);
    logger.info("pi", `Renderer detached from generation ${streamId}; work remains main-owned.`);
    return true;
  },

  cancel(
    streamId: string,
    origin: GenerationCancellationOrigin,
    ownerDocumentId?: string,
  ): boolean {
    const initialization = initializing.get(streamId);
    const generation = active.get(streamId);
    const owner = initialization?.owner ?? generation?.owner;
    if (!owner || (ownerDocumentId !== undefined && owner.documentId !== ownerDocumentId)) {
      return false;
    }
    if (initialization?.cancelRequested || generation?.cancelRequested) {
      // Quitting after Stop re-issues the abort for a turn that is still
      // unwinding (and any child it started meanwhile). The person's Stop
      // origin stays, so the reply is not offered for resume.
      if (origin === "application_shutdown") {
        generation?.agent.abort();
        subagentRuntimeRegistry.abortGeneration(streamId);
        approvals.cancelStream(streamId);
      }
      return false;
    }
    if (initialization) {
      initialization.cancelRequested = true;
      initialization.cancellationOrigin = origin;
      initialization.stopCacheWarming?.();
      initialization.controller.abort(new Error("Chat initialization cancelled."));
      endLoadMonitor(initialization, streamId, false);
      initialization.formFill?.revoke();
      void initialization.computerUse?.close();
    }
    if (generation) {
      generation.cancelRequested = true;
      generation.cancellationOrigin = origin;
      generation.stopCacheWarming?.();
      // A quit leaves the reply resumable on the next launch; Stop does not.
      if (origin === "application_shutdown") generation.agent.abortForShutdown();
      else generation.agent.abort();
      endLoadMonitor(generation, streamId, false);
      generation.formFill?.revoke();
      void generation.computerUse?.close();
    }
    subagentRuntimeRegistry.abortGeneration(streamId);
    approvals.cancelStream(streamId);
    logger.info("pi", `Generation ${streamId} cancellation requested (${origin}).`);
    return true;
  },

  /**
   * Shared foreground admission for mid-flight user input. Remote API
   * `POST /streams/{id}/inputs` and the desktop IPC surface both enter the Pi
   * runtime queues through this boundary so transcript persistence and
   * owner/cancel validation stay main-owned.
   */
  admitChatRunInput(
    input: ChatRunInputAdmissionRequest,
  ): Promise<ChatRunInputAdmissionResult> {
    return runInputAdmission.admit(input);
  },

  /**
   * Queue a follow-up notice into the chat's running generation, whoever owns
   * it. Null when nothing is running there that takes input.
   */
  async admitAgentNotice(
    chatId: string,
    input: { text: string; notice: AgentNoticeV1 },
  ): Promise<ChatRunInputAdmissionResult | null> {
    const streamId = [...active.entries()].find(
      ([, entry]) => entry.chatId === chatId && !entry.cancelRequested && !entry.inputClosed,
    )?.[0];
    if (!streamId) return null;
    return runInputAdmission.admit({
      streamId,
      chatId,
      mode: "queue",
      text: input.text,
      notice: input.notice,
    });
  },

  /**
   * Any work on the chat, including a cancelled subagent still draining (it
   * may be inside a tool call), so deletion, copy, export and workspace moves
   * wait for it.
   */
  isChatBusy(chatId: string): boolean {
    return chatTurnIsHeld(chatId) || subagentRuntimeRegistry.hasChatChildren(chatId);
  },

  /** Whether this exact generation is still starting or running, whoever owns it. */
  isGenerationLive(streamId: string): boolean {
    return active.has(streamId) || initializing.has(streamId);
  },

  /** Detect only orphaned renderer ownership; normal visible generations never delay reads. */
  isChatOwnedByInactiveRenderer(chatId: string): boolean {
    return (
      [...initializing.values()].some(
        (entry) => entry.chatId === chatId && entry.owner.id !== 0 && entry.owner.isDestroyed(),
      ) ||
      [...active.values()].some(
        (entry) => entry.chatId === chatId && entry.owner.id !== 0 && entry.owner.isDestroyed(),
      )
    );
  },

  /**
   * Wait for terminal persistence without cancelling work owned by another
   * document. Only the turn matters here, so a draining child never holds the
   * queue or a waiting send.
   */
  async waitForChatIdle(chatId: string): Promise<boolean> {
    return waitForChatSettlement(chatId, () => chatTurnIsHeld(chatId));
  },

  /** Stop and drain foreground work before cross-store chat deletion begins. */
  async cancelChat(chatId: string): Promise<void> {
    await btwService.forget(chatId);
    cancelChatGenerations(chatId, "chat_deletion");
    if (!(await waitForChatSettlement(chatId, () => this.isChatBusy(chatId)))) {
      throw new Error("Aiden could not stop this chat before deletion.");
    }
  },

  /**
   * Stop a chat's foreground work and keep the chat, for a Bot the person
   * paused (plan §7): its starting and running generations end as a Stop,
   * with their tools and subagents, and this waits until nothing runs on the
   * chat. Side questions are kept. Never throws: `false` means work was still
   * settling when the grace ran out.
   */
  async stopChatWork(chatId: string): Promise<boolean> {
    cancelChatGenerations(chatId, "user_stop");
    return waitForChatSettlement(chatId, () => this.isChatBusy(chatId));
  },

  /** Remove a deleted chat's agent scratch directory. Never throws. */
  forgetDeletedChat(chatId: string): Promise<void> {
    // SessionEnd for a chat whose hooks ran in this process; never awaited.
    endWorkspaceChatSession(chatId, undefined, {
      onMessages: (lines) => logger.warn("hooks", `SessionEnd hooks for a deleted chat: ${lines.join("\n")}`),
    });
    return acpScratch.forget(chatId);
  },

  /** Close generation admission before chat deletion performs its first await. */
  beginChatDeletion(chatId: string): () => void {
    const finish = chatDeletionGate.begin(chatId);
    chatTurnAdmission.releaseChat(chatId);
    return finish;
  },

  beginChatWorkspaceChange(chatId: string): (() => void) | null {
    if (chatDeletionGate.isDeleting(chatId)) return null;
    return chatWorkspaceMutationGate.tryBegin(chatId, this.isChatBusy(chatId));
  },

  beginChatCopy(chatId: string): (() => void) | null {
    if (chatDeletionGate.isDeleting(chatId)) return null;
    return chatCopyGate.tryBegin(chatId, this.isChatBusy(chatId));
  },

  beginChatExport(chatId: string): (() => void) | null {
    if (chatDeletionGate.isDeleting(chatId)) return null;
    return chatCopyGate.tryBegin(chatId, this.isChatBusy(chatId));
  },

  /** Claim one append-to-generation turn before its first persistence await. */
  beginChatTurn(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null {
    if (
      !turnId ||
      !ownerId ||
      chatTurnAdmission.requiresAppendReconciliation(ownerId) ||
      chatDeletionGate.isDeleting(chatId) ||
      chatCopyGate.isChanging(chatId) ||
      chatWorkspaceMutationGate.isChanging(chatId)
    ) {
      return null;
    }
    // Foreground admission and BTW reservation fence each other: an existing
    // side question is aborted here, while a concurrent BTW start rechecks
    // isChatBusy after it reserves its per-chat slot. These calls are adjacent
    // and synchronous on Electron's main thread, so no reservation can enter
    // between the abort and the foreground claim.
    btwOperationRegistry.abortForForeground(chatId);
    return chatTurnAdmission.tryBegin(chatId, turnId, ownerId, chatHasGenerationOwnership(chatId));
  },

  markAppendReconciliationRequired(ownerId: string): void {
    chatTurnAdmission.markAppendReconciliationRequired(ownerId);
  },

  requiresAppendReconciliation(ownerId: string): boolean {
    return chatTurnAdmission.requiresAppendReconciliation(ownerId);
  },

  clearAppendReconciliationRequired(ownerId: string): void {
    chatTurnAdmission.clearAppendReconciliationRequired(ownerId);
  },

  abandonChatTurn(chatId: string, turnId: string, ownerId: string): boolean {
    return chatTurnAdmission.releaseMatching(chatId, turnId, ownerId);
  },

  /** Discard active snapshots when the user disables skills across the app. */
  /** Closing the global gate cancels every snapshot that could race the setting change. */
  cancelComputerUseGenerations(): void {
    computerUseGenerationGate.close();
    const activated = new Set([
      ...activatedComputerUseStreamIds(initializing),
      ...activatedComputerUseStreamIds(active),
    ]);
    for (const streamId of activated) {
      this.cancel(streamId, "computer_use_disabled");
    }
  },

  async cancelComputerUseGenerationsAndSettle(): Promise<void> {
    await cancelComputerUseAndSettle({
      gate: computerUseGenerationGate,
      initializations: () => initializing,
      active: () => active,
      cancel: (streamId) => { this.cancel(streamId, "computer_use_disabled"); },
      timeoutMs: WORKSPACE_CANCEL_SETTLEMENT_GRACE_MS,
    });
  },

  /** Stop and drain generations before a workspace authority boundary changes. */
  async cancelWorkspaceAndSettle(workspaceId: string): Promise<void> {
    await cancelWorkspaceGenerationsAndSettle({
      workspaceId,
      initializations: () => initializing,
      active: () => active,
      cancel: (streamId) => {
        this.cancel(streamId, "workspace_authority_change");
      },
      abortChildren: (targetWorkspaceId) => {
        subagentRuntimeRegistry.abortWorkspace(targetWorkspaceId);
      },
      hasChildren: (targetWorkspaceId) =>
        subagentRuntimeRegistry.hasWorkspaceChildren(targetWorkspaceId),
      timeoutMessage: "Aiden could not stop this workspace before changing its access.",
      timeoutMs: WORKSPACE_CANCEL_SETTLEMENT_GRACE_MS,
    });
    await geminiContextCache.invalidateWorkspace(workspaceId);
  },

  abortAll(): void {
    btwService.shutdown();
    chatTurnAdmission.releaseAll();
    for (const [streamId] of initializing) this.cancel(streamId, "application_shutdown");
    for (const [streamId] of active) this.cancel(streamId, "application_shutdown");
    approvals.shutdown();
    questionnaires.shutdown();
  },

  async shutdown(): Promise<boolean> {
    this.abortAll();
    const deadline = Date.now() + SHUTDOWN_GENERATION_GRACE_MS;
    const generations = [...active.values()];
    const activeSettled = await settleGenerationCleanup(
      generations.map((entry) => ({
        reset: () => entry.agent.reset(),
        close: entry.computerUse ? () => entry.computerUse!.close() : undefined,
        completion: entry.completion,
      })),
      Math.max(0, deadline - Date.now()),
      (error) => logger.warn("pi", "Could not clear one generation during shutdown.", error),
    );
    // A parent can still be preparing when shutdown begins. Its controller was
    // aborted above, but do not report a clean lifecycle until it leaves the
    // initializing map (or its late active handoff does) within the same bound.
    const parentStateCleared =
      activeSettled &&
      (await waitForGenerationStateClear(
        () => initializing.size > 0 || active.size > 0,
        () => [...active.values()].map((entry) => entry.completion),
        deadline,
      ));
    await geminiContextCache.shutdown();
    return activeSettled && parentStateCleared;
  },
};
