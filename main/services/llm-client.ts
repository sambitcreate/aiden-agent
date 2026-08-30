// Chat generation via pi's embedded agent loop (@earendil-works/pi-agent-core +
// pi-ai). A fresh Agent runs per generation: it owns multi-step tool calling
// (folder-scoped coding tools, Exa search, Agent Skills, MCP servers) and
// streams assistant text. Text, local-model reasoning, and tool activity are
// pushed to the exact renderer document that owns the generation.
//
// Workspaces bind a folder + a permission level. In "ask" mode the agent pauses
// before any mutating tool (write/edit/run_command) via pi's `beforeToolCall`
// hook and waits for the user to Allow or Deny in the UI.

import {
  convertToLlm,
  type AgentHarnessResources,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { access } from "node:fs/promises";
import { ipcMain, logger } from "../platform.js";
import { buildAgentTools, buildSchedulingTools } from "./tools.js";
import { webSearchService } from "./web-search-main.js";
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
import { gitInfo } from "./git.js";
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
import {
  botManagedWorkspace,
  resolveBotRuntimeMcpConnectionIdentities,
  resolveBotRuntimeSkills,
} from "./bot-capability-services-main.js";
import {
  exactBotMcpToolNames,
  exactBotSkillToolNames,
  filterExactBotSubagentMcpInventory,
  filterBotSkillSnapshot,
  protectAdmittedBotTool,
} from "./bot-tool-authority.js";
import { mcpAgentToolName } from "./mcp-tool-identity.js";
import { createShareImageTool, SHARE_IMAGE_TOOL_NAME } from "./share-image-tool.js";
import { formatAvailableSkills, type SkillRegistrySnapshot } from "./skill-registry.js";
import { skillRegistry } from "./skill-registry-main.js";
import {
  assistantTurnTextSeparator,
  buildAgentRuntimeOptions,
  reconcileTerminalAssistantProjection,
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
import {
  AssistantRequestUsageTracker,
  assistantUsageRecord,
  unreportedUsageRecord,
} from "./usage-accounting.js";
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
} from "./types.js";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import type { UsageRequestSource } from "./usage-store-core.js";
import type { ProviderFailureV1 } from "../../renderer/shared/provider-failure.js";
import { compactionFailureLogMetadata } from "./provider-failure.js";
import type {
  ComputerUseApprovalDescriptor,
  ComputerUseController,
} from "./computer-use/controller.js";
import type { ComputerUseArgs } from "./computer-use/schema.js";
import { COMPUTER_USE_TOOL_NAME } from "./computer-use/tool.js";
import {
  EDIT_AUTOMATION_TOOL_NAME,
  SCHEDULE_TOOL_NAME,
  attachAssistantScheduleMcpApproval,
  prepareAssistantEditAutomationProposal,
  repairAssistantScheduleMcpTarget,
  resolveAssistantScheduleMcpServers,
  resolveAssistantScheduleProject,
  scheduleToolRequiresApproval,
  summarizeEditAutomationToolCall,
  summarizeScheduleToolCall,
} from "./schedule-tool.js";
import { ToolApprovalCoordinator } from "./tool-approval.js";
import { chatMessageToPiMessage, chatUserTextWithAttachments } from "./generation-messages.js";
import { createPiCompactionModels, type PiCompactionEvent } from "./pi-compaction-core.js";
import { PI_CHAT_SYSTEM_PROMPT } from "./response-format-guidance.js";
import {
  beginPiVisibleTurnLease,
  piCompactionSessionStore,
  recordPiEffectRecoveryBoundary,
  syncChatMessagesToPiSession,
  type PiVisibleTurnLease,
} from "./pi-compaction-session-store.js";
import { piRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { createComputerUseController } from "./computer-use/runtime.js";
import { computerUseStatus } from "./computer-use/status.js";
import { computerUseSupported } from "./computer-use/platform.js";
import { GenerationTimelineProjector } from "./generation-timeline.js";
import { advisorRuntime } from "./advisor-runtime-main.js";
import { ADVISOR_TOOL_NAME } from "./advisor-runtime.js";
import { snapshotAdvisorRuntimeMessages } from "./advisor-context.js";
import { persistGenerationInitializationTerminal } from "./generation-initialization-terminal.js";
import type { GenerationCancellationOrigin } from "../../renderer/shared/generation-timeline.js";
import {
  assertGenerationContextCapacity,
  createGenerationContextTransform,
} from "./generation-context.js";
import { buildGeminiWorkspaceSnapshot, GeminiContextCache } from "./gemini-context-cache.js";
import { attachClaimCheck } from "../../renderer/shared/claim-check.js";
import {
  MAX_ATTACHMENT_INLINE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../renderer/shared/attachment-contract.js";
import { listWorkspaceFiles } from "./workspace-files.js";
import { assertManagedWorktreeAdmission } from "./managed-worktree-admission.js";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import {
  activatedComputerUseStreamIds,
  ChatComputerUseMutationGate,
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
  assertScheduledProviderFingerprint,
  scheduledProviderFingerprint,
} from "./schedule-provider-binding.js";
import {
  advanceAttendedToolErrorState,
  recoverAttendedToolErrorContext,
} from "./assistant/tool-loop-guard.js";
import type { ToolApprovalDetails } from "../../renderer/shared/assistant.js";
import { DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS } from "./subagents/subagent-child-runner.js";
import { SETTINGS_SECTIONS } from "../../renderer/lib/settings-section.js";
import { SubagentSupervisor } from "./subagents/subagent-supervisor.js";
import { chatActivityRegistry } from "./chat-activity.js";
import { createSubagentTool } from "./subagents/subagent-tool.js";
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
import { SUBAGENT_PARENT_SECURITY_GUIDANCE } from "./subagents/role-catalog.js";
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
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { btwOperationRegistry, btwService } from "./rpiv-btw/service.js";
import {
  PiAgentRuntimeHarness,
  piAgentRuntimeExtensions,
  resolvePiAgentRuntimeContributionSnapshot,
  resolvePiAgentRuntimeStaticContributions,
  type PiAgentRuntimeExtension,
} from "./pi-agent-runtime-harness.js";
import {
  createDisplayImageExtensionRuntime,
  displayedAssistantImageUsage,
  DISPLAY_IMAGE_TOOL_NAME,
  shouldEnableDisplayImageExtension,
} from "./display-image-extension.js";
import { CHAT_ARTIFACT_EVENT_VERSION, type ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import {
  MAX_HTML_ARTIFACTS_PER_RESPONSE,
} from "../../renderer/shared/generative-ui.js";
import { displayImageArtifactStore } from "./display-image-artifact-store.js";
import {
  createGenerativeUiExtensionRuntime,
  displayedAssistantHtmlUsage,
  GENERATIVE_UI_TOOL_NAME,
  shouldEnableGenerativeUiExtension,
} from "./generative-ui-extension.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { generationHasVisibleOutput } from "./generation-visible-output.js";
import {
  createAskUserQuestionExtension,
  shouldEnableAskUserQuestionExtension,
} from "./ask-user-question-extension.js";
import { AskUserQuestionCoordinator } from "./ask-user-question-coordinator.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../renderer/shared/ask-user-question.js";
import {
  createTodoExtension,
  shouldEnableTodoExtension,
} from "./rpiv-todo/extension.js";
import { TODO_TOOL_NAME } from "./rpiv-todo/contract.js";
import { isTodoSnapshotFailure, replayTodoState } from "./rpiv-todo/replay.js";
import {
  todoSnapshotForRenderer,
  unavailableTodoSnapshot,
} from "../../renderer/shared/todo.js";

subagentRuntimeRegistry.setHealthMetrics(subagentHealthMetrics);
subagentRuntimeRegistry.setRuntimeFaultReporter((source) => {
  logger.warn("subagents", `Pi child runtime fault (${source}).`);
});

type GenerationPermission = WorkspacePermission | "read-only";

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

function piResourcesForSkillSnapshot(
  snapshot: SkillRegistrySnapshot | undefined,
): AgentHarnessResources {
  if (!snapshot) return {};
  return {
    // Pi resources promise a truthful filePath. Configured database skills
    // keep their existing leased invocation path until Pi supports in-memory
    // resource locations.
    skills: snapshot.available
      .filter((skill) => Boolean(skill.path))
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        content: skill.instructions,
        filePath: skill.path!,
      })),
  };
}

export interface GenerationExecutionOptions {
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
  /** Main-owned stable principal used for the versioned Bot Full Access notice. */
  botAudienceId?: string;
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
  workspaceId?: string;
  cancelRequested: boolean;
  cancellationOrigin?: GenerationCancellationOrigin;
  rendererDetached: boolean;
  computerUse?: ComputerUseController;
  completion: Promise<void> | null;
  loadMonitor?: LoadMonitorState;
  releaseSkillReservation: () => void;
  releaseBotAuthority: () => void;
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
    workspaceId?: string;
    cancelRequested: boolean;
    cancellationOrigin?: GenerationCancellationOrigin;
    rendererDetached: boolean;
    controller: AbortController;
    computerUse?: ComputerUseController;
    loadMonitor?: LoadMonitorState;
    releaseSkillReservation: () => void;
    releaseBotAuthority: () => void;
  }
>();
const computerUseGenerationGate = new ComputerUseGenerationGate();
const chatComputerUseMutationGate = new ChatComputerUseMutationGate();
const chatDeletionGate = new ChatDeletionGate();
const chatWorkspaceMutationGate = new ChatWorkspaceMutationGate();
const chatCopyGate = new ChatWorkspaceMutationGate();
const chatTurnAdmission = new ChatTurnAdmission();
const geminiContextCache = new GeminiContextCache({
  onWarning: (message, error) => logger.warn("pi", message, error),
});

function chatHasGenerationOwnership(chatId: string): boolean {
  return (
    [...initializing.values()].some((entry) => entry.chatId === chatId) ||
    [...active.values()].some((entry) => entry.chatId === chatId) ||
    subagentRuntimeRegistry.hasChatChildren(chatId)
  );
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
  kind: "web" | "browser" | "computer_use" | "schedules" | "subagents",
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

function broadcastChatSettled(
  streamId: string,
  chatId: string,
  workspaceId: string | undefined,
  fallbackWorkspaceId: string | undefined,
): void {
  chatActivityRegistry.settle(streamId);
  const normalizedWorkspaceId = persistedChatWorkspaceId(workspaceId ?? fallbackWorkspaceId);
  if (!isSafeSubagentIdentifier(chatId) || !isSafeSubagentIdentifier(normalizedWorkspaceId)) {
    return;
  }
  ipcMain.broadcast("chats:settled", {
    chatId,
    workspaceId: normalizedWorkspaceId,
  });
}

function ownerForStream(streamId: string): ChatGenerationOwner | undefined {
  return active.get(streamId)?.owner ?? initializing.get(streamId)?.owner;
}

function sendGeneration(streamId: string, channel: NotificationChannel, payload: unknown): boolean {
  const owner = ownerForStream(streamId);
  if (!owner || owner.isDestroyed()) return false;
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

const approvals = new ToolApprovalCoordinator((prompt) => {
  if (!sendGeneration(prompt.streamId, "chat:approval", prompt)) {
    throw new Error("The generation's renderer document is no longer active.");
  }
});
const questionnaires = new AskUserQuestionCoordinator((prompt) => {
  if (!sendGeneration(prompt.streamId, "chat:questionnaire", prompt)) {
    throw new Error("The generation's renderer document is no longer active.");
  }
});
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

async function buildSystemPrompt(
  folderPath: string | undefined,
  branch: string | undefined,
  permission: GenerationPermission,
  subagentsAvailable: boolean,
  skillsAvailable = true,
  skillSnapshot?: SkillRegistrySnapshot,
  availableToolNames?: ReadonlySet<string>,
): Promise<string> {
  const base = PI_CHAT_SYSTEM_PROMPT;
  const skillsText =
    skillsAvailable && skillSnapshot
      ? formatAvailableSkills(skillSnapshot, availableToolNames)
      : undefined;
  const skillsSuffix = skillsText ? `\n\n${skillsText}` : "";
  if (!folderPath || permission === "none") {
    return `${base} Call the available tools when they help answer the user's request.${skillsSuffix}`;
  }
  const git = branch ? ` It is a git repository on branch \`${branch}\`.` : "";
  const capability =
    permission === "read-only"
      ? "You have tools to read, search, and list files in this folder. You cannot edit files or run commands. "
      : "You have tools to read, search, list, and edit files and to run shell commands in this folder. ";
  const workflow =
    permission === "read-only"
      ? "All file paths are relative to this folder. If the request requires a mutation, explain that this scheduled run is read-only."
      : "All file paths are relative to this folder. Prefer editing existing files over creating new ones, read a file before editing it, and keep changes surgical. ";
  const delegation = subagentsAvailable
    ? ` Use the subagent tool for independent bounded investigation, comparison, planning, or fresh review—not trivial work—and always reconcile its ordered results yourself. ${SUBAGENT_PARENT_SECURITY_GUIDANCE}`
    : "";
  return (
    `${base}\n\n` +
    `You are working inside the folder: ${folderPath}.${git} ` +
    capability +
    workflow +
    (permission === "ask"
      ? "The user must approve each file write and shell command before it runs."
      : permission === "full"
        ? "You may make changes and run commands directly."
        : "") +
    delegation +
    skillsSuffix
  );
}

async function prepareGeneration(
  streamId: string,
  params: ChatStartParams & { workspaceId: string },
  chat: Chat,
  botContext: BotGenerationAuthorityContext | undefined,
  signal: AbortSignal,
  computerUseGateSnapshot: number,
  activatedComputerUse: (controller: ComputerUseController) => void,
  ownerDocumentId: string,
  rendererOwner: boolean,
  options: GenerationExecutionOptions,
) {
  const sharedImages: Attachment[] = [];
  const displayedImages: Attachment[] = [];
  const displayedImageIds = new Set<string>();
  const displayedHtmlArtifacts: ChatHtmlArtifactV1[] = [];
  const displayedHtmlIds = new Set<string>();
  const generationExtensions: PiAgentRuntimeExtension[] = [];
  const responseImages = () => uniqueResponseImages(sharedImages, displayedImages);
  const shareImage = (attachment: Attachment) => {
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
  };
  const runtime =
    botContext?.prepared.runtime ??
    (await resolveModelRuntime(params.providerId, params.model, signal));
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
      excluded: options.excludeToolNames?.has(ASK_USER_QUESTION_TOOL_NAME) ?? false,
    })
  ) {
    generationExtensions.push(
      createAskUserQuestionExtension({
        request: (toolCallId, questions, requestSignal) =>
          questionnaires.request(
            { streamId, toolCallId, questions },
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
  if (workspace && !botBound) await assertManagedWorktreeAdmission(workspace);
  const permission: GenerationPermission = options.permission ?? workspace?.permission ?? "ask";
  const folderPath = workspace?.folderPath;
  const git =
    folderPath && (!botContext || botContext.admission.authority.files.botHome)
      ? await gitInfo(folderPath)
      : { isRepo: false };
  // The resolved runtime model is the connection-bound capability authority.
  // Display metadata must not re-enable an input that Pi or discovery rejected.
  const model = runtime.model;
  if (assistantAutomationMode || params.mode === "assistant-unattended") {
    assertScheduledProviderFingerprint(runtime.provider, options.providerFingerprint);
  }
  const assistantModelSelection = {
    providerId: runtime.provider.id,
    providerName: runtime.provider.label,
    model: model.id,
    modelName: model.name,
    providerFingerprint: scheduledProviderFingerprint(runtime.provider),
  };
  const supportsImages = runtimeSupportsImages(model);
  const settings = await configStore.getSettings();
  const savedThinkingLevel =
    params.providerId === GOOGLE_PROVIDER_ID
      ? settings.googleThinkingByModel?.[params.model]
      : params.providerId === OPENAI_CODEX_PROVIDER_ID
        ? settings.codexThinkingByModel?.[params.model]
        : params.providerId === ANTHROPIC_PROVIDER_ID
          ? settings.anthropicThinkingByModel?.[params.model]
          : settings.providerThinkingByModel?.[params.providerId]?.[params.model];
  const thinkingLevel = resolveGenerationThinkingLevel(
    params.providerId,
    model,
    params.thinkingLevel ?? savedThinkingLevel,
  );
  let computerUse: ComputerUseController | undefined;
  if (
    computerUseSupported() &&
    options.allowComputerUse !== false &&
    (!botContext || botHasOrdinaryCapability(botContext, "computer_use")) &&
    settings.computerUseEnabled === true &&
    chat.computerUseEnabled === true &&
    computerUseGenerationGate.isCurrent(computerUseGateSnapshot)
  ) {
    const status = await computerUseStatus.status({ signal });
    if (
      computerUseGenerationGate.isCurrent(computerUseGateSnapshot) &&
      status.enabled &&
      !status.ready
    ) {
      throw new Error(`Computer Use is enabled for this chat but is not ready. ${status.detail}`);
    }
    if (computerUseGenerationGate.isCurrent(computerUseGateSnapshot) && status.ready) {
      computerUse = createComputerUseController(streamId, supportsImages);
      activatedComputerUse(computerUse);
    }
  }
  const toolPermission: WorkspacePermission = permission === "read-only" ? "full" : permission;
  const allowSubagents = subagentsAllowedForGeneration({
    assistantMode,
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
    : discoveredSubagentMcpInventory;
  const subagentShellBinary = resolveSubagentShellRunnerBinary();
  const subagentShellEnabled =
    allowSubagents &&
    childShellRollout &&
    subagentRunStore.selection === "v2" &&
    workspace?.permission !== "none" &&
    permission !== "none" &&
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
          writeEnabled: subagentWriteEnabled,
          webEnabled: subagentWebEnabled,
          mcpInventory: subagentMcpInventory,
          mcpMutationsEnabled: childMcpMutationsRollout,
          mcpMutationHost: productionSubagentMcpMutationHost,
          shellEnabled: subagentShellEnabled,
          shellBinary: subagentShellEnabled ? subagentShellBinary : undefined,
          delegationEnabled: subagentDelegationEnabled,
          requestApproval: (descriptor, approvalSignal, approvalOwnerDocumentId) =>
            approvals.request(descriptor, approvalSignal, approvalOwnerDocumentId),
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
  const subagentSupervisor =
    allowSubagents && folderPath && workspace?.id
      ? new SubagentSupervisor({
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
          healthMetrics: subagentHealthMetrics,
          projector: subagentProjector,
        })
      : undefined;
  // Assistant modes use positive allowlists: the dock gets safe metadata plus
  // scheduling, while an approved automation gets only its project tools and
  // exact MCP identities. Computer Use, skills, and delegation stay out.
  let skillSnapshot =
    !assistantMode && workspace ? await skillRegistry.snapshotResolved(workspace) : undefined;
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
  let tools = (
    await buildAgentTools({
      workspaceId: workspace?.id,
      workspaceRoot: folderPath,
      skillSnapshot,
      permission: toolPermission,
      computerUse,
      allowScheduling: schedulingAllowed,
      allowMcpTools: botContext
        ? options.allowMcpTools !== false && botConnectionIds!.length > 0
        : options.allowMcpTools,
      mcpServerIds: botContext ? botConnectionIds : options.mcpServerIds,
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
      assistantModelSelection: attendedAssistant ? assistantModelSelection : undefined,
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
            )
        : undefined,
      shareImage: folderPath ? shareImage : undefined,
      includeCodingTools: !botContext,
      imageInspectionTool:
        botContext && !supportsImages && botContext.admission.authority.visionProvider
          ? createVisionAnalysisTool({
              attachments: chat.messages.flatMap((message) => message.attachments ?? []),
              authority: {
                providerId: botContext.admission.authority.visionProvider.sourceProviderId,
                modelId: botContext.admission.authority.visionProvider.sourceModelId,
                revalidateBeforeEffect: () => botContext.admission.revalidateBeforeEffect(),
              },
            })
          : undefined,
    })
  ).filter((tool) => !options.excludeToolNames?.has(tool.name));
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
    const configuredServers = await configStore.listMcpServers();
    if (!botRuntimeCatalog) throw new Error("Bot runtime catalog was not prepared.");
    const mcpToolNames = exactBotMcpToolNames(
      authority,
      botRuntimeCatalog.resources.connections,
      (connectionSourceId, toolName) => {
        const server = configuredServers.find(({ id }) => id === connectionSourceId);
        if (!server) throw new Error("A selected Bot connection is no longer configured.");
        return mcpAgentToolName(server, toolName);
      },
    );
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
            ? true
            : tool.name === "web_search"
              ? webAllowed
              : tool.name === COMPUTER_USE_TOOL_NAME
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
  if (
    !botContext &&
    shouldEnableDisplayImageExtension({
      usageSource: options.usageSource,
      interactionSurface: options.interactionSurface,
      assistantMode,
      workspaceRoot: folderPath,
      permission,
      excluded: options.excludeToolNames?.has(DISPLAY_IMAGE_TOOL_NAME) ?? false,
    })
  ) {
    const artifactStoreAvailability = displayImageArtifactStore.availability();
    if (!artifactStoreAvailability.available) {
      throw new Error(
        `${artifactStoreAvailability.reason} Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair.`,
      );
    }
    const existingUsage = displayedAssistantImageUsage(chat.messages);
    const pendingUsage = await displayImageArtifactStore.usageByChat(params.chatId);
    if (pendingUsage.count > 0) {
      throw new Error(
        "A previous image response could not be recovered. Delete this chat to discard it before continuing.",
      );
    }
    const displayImageRuntime = createDisplayImageExtensionRuntime({
      workspaceRoot: folderPath!,
      artifactNamespace: streamId,
      existingChatImageBytes: existingUsage.bytes + pendingUsage.bytes,
      existingChatImageCount: existingUsage.count + pendingUsage.count,
      existingChatImagePixels: existingUsage.pixels + pendingUsage.pixels,
      onArtifact: async (artifact, dimensions) => {
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
        sendGeneration(streamId, "chat:artifact", {
          streamId,
          event: {
            version: CHAT_ARTIFACT_EVENT_VERSION,
            operation: "present",
            artifact,
          },
        });
        return true;
      },
    });
    generationExtensions.push(displayImageRuntime.extension);
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
      workspaceRoot: folderPath!,
      artifactNamespace: `${streamId}:html`,
      existingChatHtmlBytes: existingHtmlUsage.bytes + pendingHtmlAfterReconcile.bytes,
      existingChatHtmlCount: existingHtmlUsage.count + pendingHtmlAfterReconcile.count,
      preferArtifactThisTurn: visualize,
      onArtifact: async (artifact, html) => {
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
        sendGeneration(streamId, "chat:artifact", {
          streamId,
          event: {
            version: CHAT_ARTIFACT_EVENT_VERSION,
            operation: "present",
            artifact,
          },
        });
        return true;
      },
    });
    generationExtensions.push(generativeUiRuntime.extension);
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
    permission,
    folderPath,
    git,
    tools,
    generationExtensions,
    displayedImages,
    displayedHtmlArtifacts,
    supportsImages,
    thinkingLevel,
    computerUse,
    googleWorkspaceSnapshot,
    skillSnapshot,
    workspaceId: workspace?.id,
    subagentSupervisor,
    showLocalModelReasoning: settings.showLocalModelReasoning,
    sharedImages,
    botContext,
    botApprovedRoots,
    botMutatingToolNames,
    // The Aiden system prompt reads its approval posture from settings, which
    // are already loaded here; re-reading them at the prompt site would be a
    // second disk round trip inside the generation's hot path.
    assistantSettingsPermission: settings.assistant?.settingsPermission ?? "ask",
  };
}

export const llmClient = {
  async start(
    streamId: string,
    params: ChatStartParams,
    owner: ChatGenerationOwner,
    options: GenerationExecutionOptions = {},
  ): Promise<boolean> {
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
      if (chatComputerUseMutationGate.isChanging(params.chatId)) {
        throw new Error("Computer Use settings are changing for this chat. Try again in a moment.");
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
    initialization.removeOwnerInvalidation = owner.onInvalidated(() => {
      this.detachRenderer(streamId, owner.documentId);
    });
    if (initialization.controller.signal.aborted) initialization.removeOwnerInvalidation();
    let setup: Awaited<ReturnType<typeof prepareGeneration>>;
    let authoritativeChat: Chat | undefined;
    let authoritativeBot: BotDefinition | undefined;
    let botContext: BotGenerationAuthorityContext | undefined;
    let authoritativeMode: ChatStartParams["mode"];
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
      authoritativeChat = chat;
      authoritativeMode = authoritativeChatGenerationMode(chat.workspaceId, params.mode);
      if (chat.botId && !hostPlatformCapabilities().bots) {
        throw new Error("Bot chats are not available on this platform.");
      }
      authoritativeBot = await resolveBotForGeneration(chat, authoritativeMode, (botId) =>
        botStore.get(botId),
      );
      if (authoritativeBot) {
        const canonical = selectCanonicalBotChat(await chatStore.listByBot(authoritativeBot.id));
        if (canonical?.id !== chat.id) {
          throw new Error("This historical Bot chat is read-only. Open the Bot's current chat.");
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
      permission,
      folderPath,
      git,
      tools,
      generationExtensions,
      displayedImages,
      displayedHtmlArtifacts,
      supportsImages,
      thinkingLevel,
      computerUse,
      googleWorkspaceSnapshot,
      skillSnapshot,
      workspaceId,
      assistantSettingsPermission,
      subagentSupervisor,
      showLocalModelReasoning,
      sharedImages,
      botContext: preparedBotContext,
      botApprovedRoots,
      botMutatingToolNames,
    } = setup;
    const attendedAssistant = authoritativeMode === "assistant";
    initialization.computerUse = computerUse;
    const { model } = runtime;
    const approvalModelSelection = {
      providerId: runtime.provider.id,
      providerName: runtime.provider.label,
      model: model.id,
      modelName: model.name,
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
    let consecutiveAttendedToolErrorTurns = 0;
    const timeline = new GenerationTimelineProjector(streamId, (snapshot) => {
      sendGeneration(streamId, "chat:timeline", {
        streamId,
        timeline: snapshot,
      });
    });
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
        displayedHtmlArtifacts.length === 0
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
            pi: lastAssistantMessage ? storedPiAssistantMessage(lastAssistantMessage) : undefined,
            providerFailure,
            timeline:
              finalTimeline.steps.length || finalTimeline.status === "cancelled"
                ? finalTimeline
                : undefined,
            subagents,
            attachments: assistantAttachments.length > 0 ? assistantAttachments : undefined,
            htmlArtifacts:
              displayedHtmlArtifacts.length > 0 ? displayedHtmlArtifacts : undefined,
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
            logger.warn(
              "pi",
              `Could not commit HTML artifacts for stream ${streamId}.`,
              error,
            );
          }
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
    let currentAssistantTurnStart = { full: 0, reasoning: 0 };
    const requestUsage = new AssistantRequestUsageTracker();
    let activeCompactionStepId: string | undefined;
    let piSession: Awaited<ReturnType<typeof piCompactionSessionStore.openChat>> | undefined;
    let candidate: PiAgentRuntimeHarness | null = null;
    let currentPromptMessage: AgentMessage | undefined;
    let journalContentOverrides: ReadonlyMap<string, string> = new Map();
    let piJournalHealthy = true;
    try {
      piSession = await piCompactionSessionStore.openChat(params.chatId);
      if (
        shouldEnableTodoExtension({
          usageSource: options.usageSource,
          interactionSurface: options.interactionSurface,
          assistantMode: authoritativeMode !== undefined,
          botBound: preparedBotContext !== undefined,
          rendererOwner: owner.id !== 0,
          excluded: options.excludeToolNames?.has(TODO_TOOL_NAME) ?? false,
        })
      ) {
        try {
          const todoState = await replayTodoState(piSession);
          const publishTodo = (state: typeof todoState) => {
            sendGeneration(streamId, "chat:todo", {
              streamId,
              snapshot: todoSnapshotForRenderer(params.chatId, state),
            });
          };
          generationExtensions.push(
            createTodoExtension(todoState, { onDurableSnapshot: publishTodo }),
          );
          publishTodo(todoState);
        } catch (error) {
          if (!isTodoSnapshotFailure(error)) throw error;
          // Never log task content or fall back past a corrupt newer snapshot.
          // The ordinary chat remains usable, but todo stays unavailable until
          // its private journal is repaired or the chat is deleted.
          sendGeneration(streamId, "chat:todo", {
            streamId,
            snapshot: unavailableTodoSnapshot(params.chatId),
          });
          logger.warn("pi", `Disabled todo for chat ${params.chatId}: invalid durable snapshot.`);
        }
      }
      const runtimeExtensionSnapshot = piAgentRuntimeExtensions.snapshotWithRevision();
      // Runtime extensions are not yet represented in the exact Bot catalog.
      // Omit them from Bot prompts and tool schemas instead of granting an
      // unclassified capability through an alternate contribution path.
      const baseRuntimeExtensions: readonly PiAgentRuntimeExtension[] = preparedBotContext
        ? [
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
        : [...runtimeExtensionSnapshot.extensions, ...generationExtensions];
      const toolsBeforeAdvisor = resolvePiAgentRuntimeStaticContributions(
        "",
        tools,
        baseRuntimeExtensions,
      ).tools;
      const advisorExtension = await advisorRuntime.extensionForGeneration({
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
          candidate
            ? snapshotAdvisorRuntimeMessages(candidate.state, toolCallId)
            : [],
        ...(shouldEnableAskUserQuestionExtension({
          usageSource: options.usageSource,
          interactionSurface: options.interactionSurface,
          assistantMode: authoritativeMode !== undefined,
          botBound: preparedBotContext !== undefined,
          rendererOwner: owner.id !== 0,
          excluded: options.excludeToolNames?.has(ASK_USER_QUESTION_TOOL_NAME) ?? false,
        })
          ? {
              requestQuestionnaire: (
                toolCallId: string,
                questions: Parameters<typeof questionnaires.request>[0]["questions"],
                requestSignal?: AbortSignal,
              ) =>
                questionnaires.request(
                  { streamId, toolCallId, questions },
                  owner.documentId,
                  requestSignal,
                ),
            }
          : {}),
      });
      const runtimeExtensions: readonly PiAgentRuntimeExtension[] = advisorExtension
        ? [...baseRuntimeExtensions, advisorExtension]
        : baseRuntimeExtensions;
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
      const baseSystemPrompt =
        authoritativeMode === "assistant" || authoritativeMode === "assistant-unattended"
          ? buildAssistantSystemPrompt({
              settingsSections: SETTINGS_SECTIONS,
              settingsPermission: assistantSettingsPermission,
              availableTools: toolsWithRuntimeContributions.map((tool) => tool.name),
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
            : await buildSystemPrompt(
                folderPath,
                git.branch,
                permission,
                toolsWithRuntimeContributions.some((tool) => tool.name === "subagent"),
                true,
                skillSnapshot,
                new Set(toolsWithRuntimeContributions.map((tool) => tool.name)),
              );
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
      const runtimeContributions = resolvePiAgentRuntimeContributionSnapshot(
        botSystemPrompt,
        tools,
        piResourcesForSkillSnapshot(skillSnapshot),
        runtimeExtensions,
        runtimeExtensionSnapshot.revision,
      );
      const { systemPrompt, tools: runtimeTools } = runtimeContributions;
      assertGenerationContextCapacity({
        contextWindow: model.contextWindow,
        systemPrompt,
        tools: runtimeTools,
      });
      const onCompactionEvent = (event: PiCompactionEvent) => {
        if (event.type === "start") {
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
          );
          activeCompactionStepId = undefined;
        }
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
        models: createPiCompactionModels(runtime, (message) =>
          usageStore.record(
            assistantUsageRecord({
              message,
              provider: runtime.provider,
              model,
              source: "compaction",
            }),
          ),
        ),
        model,
        thinkingLevel,
        signal: initialization.controller.signal,
        onEvent: onCompactionEvent,
      };
      const promptJournal = piSession;

      const currentUser = [...generationChat.messages]
        .reverse()
        .find((message) => message.role === "user");
      const priorVisibleMessages = currentUser
        ? generationChat.messages.filter((message) => message.id !== currentUser.id)
        : generationChat.messages;
      const contentOverrides = new Map<string, string>();
      if (currentUser) {
        if (
          initialization.skillInvocation?.userMessageId === currentUser.id &&
          initialization.skillPrompt
        ) {
          if (preparedBotContext) {
            const allowedSkill = skillSnapshot?.available.find(
              (skill) =>
                skill.name === currentUser.skill?.name && skill.source === currentUser.skill.source,
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
        for (const effect of recoveryEffects) {
          await piRuntimeEffectStore.markRecoveryRecorded({
            effectId: effect.effectId,
            operationId: effect.operationId,
            runId: effect.runId,
            chatId: effect.chatId,
          });
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
      const initialMessages = (await promptJournal.buildContext()).messages;
      initialization.skillInvocation = undefined;
      initialization.skillPrompt = undefined;
      candidate = new PiAgentRuntimeHarness({
        contributions: runtimeContributions,
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
        ...buildAgentRuntimeOptions(params.chatId, runtime),
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
        transformContext: createGenerationContextTransform(
          {
            contextWindow: model.contextWindow,
            systemPrompt,
            tools: runtimeTools,
            supportsImages,
          },
          (result) => {
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
          },
        ),
        durability: {
          session: promptJournal,
          compaction: compactionOptions,
          signal: initialization.controller.signal,
          effects: { store: piRuntimeEffectStore, chatId: params.chatId },
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
            piJournalHealthy = false;
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
        prepareNextTurnWithContext: async ({ toolResults, context }) => {
          let nextContext = context;
          let changed = false;
          if (attendedAssistant) {
            const state = advanceAttendedToolErrorState(
              consecutiveAttendedToolErrorTurns,
              toolResults,
            );
            consecutiveAttendedToolErrorTurns = state.consecutiveErrorTurns;
            if (state.shouldStop) {
              logger.warn(
                "pi",
                `Stopped attended Assistant tool retries for stream ${streamId} and requested a text-only recovery.`,
              );
              nextContext = recoverAttendedToolErrorContext(context);
              changed = true;
            }
          }
          return changed ? { context: nextContext } : undefined;
        },
        // Computer Use mutations always pause. Folder mutations pause in "ask" mode.
        beforeToolCall: async (context, signal) => {
          timeline.toolStarted(context.toolCall.id, context.toolCall.name, context.args);
          let summary: string;
          let approvalDetails: ToolApprovalDetails | undefined;
          let computerUseApproval: ComputerUseApprovalDescriptor | undefined;
          let attendedScheduleApproval = false;
          let approvedScheduleMcpBindings: import("./types.js").ScheduledMcpServerBinding[] = [];
          if (context.toolCall.name === COMPUTER_USE_TOOL_NAME) {
            if (!computerUse) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return {
                block: true,
                reason: "Computer Use is not enabled for this response.",
              };
            }
            try {
              const descriptor = await computerUse.approvalFor(
                context.args as ComputerUseArgs,
                signal,
              );
              if (!descriptor) {
                timeline.toolRunning(context.toolCall.id);
                return undefined;
              }
              computerUseApproval = descriptor;
              summary = descriptor.summary;
            } catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return {
                block: true,
                reason:
                  error instanceof Error ? error.message : "Computer Use rejected this action.",
              };
            }
          } else {
            const createScheduleApproval =
              context.toolCall.name === SCHEDULE_TOOL_NAME &&
              scheduleToolRequiresApproval(context.args);
            const editScheduleApproval = context.toolCall.name === EDIT_AUTOMATION_TOOL_NAME;
            const scheduleApproval = createScheduleApproval || editScheduleApproval;
            const workspaceApproval =
              permission === "ask" && APPROVAL_TOOL_NAMES.has(context.toolCall.name);
            const disclosureApproval = DISCLOSURE_APPROVAL_TOOL_NAMES.has(context.toolCall.name);
            const botMcpApproval = botMutatingToolNames.has(context.toolCall.name);
            attendedScheduleApproval = scheduleApproval && attendedAssistant;
            if (!scheduleApproval && !workspaceApproval && !disclosureApproval && !botMcpApproval) {
              timeline.toolRunning(context.toolCall.id);
              return undefined;
            }
            if (scheduleApproval && attendedAssistant) {
              try {
                const proposal = editScheduleApproval
                  ? await prepareAssistantEditAutomationProposal(context.args)
                  : await repairAssistantScheduleMcpTarget(context.args);
                if (createScheduleApproval) {
                  const canonicalArgs = context.args as Record<string, unknown>;
                  canonicalArgs.workspaceId = proposal.input.workspaceId;
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
            }
            summary = editScheduleApproval
              ? summarizeEditAutomationToolCall(context.args)
              : scheduleApproval
                ? summarizeScheduleToolCall(context.args)
                : summarizeToolCall(context.toolCall.name, context.args);
          }
          timeline.toolAwaitingApproval(context.toolCall.id);
          const allowed = await approvals.request(
            (() => {
              const toolCallId = timeline.publicToolCallId(context.toolCall.id);
              if (!toolCallId) throw new Error("The tool approval step was not initialized.");
              return {
                streamId,
                toolCallId,
                toolName: context.toolCall.name,
                summary,
                details: approvalDetails,
              };
            })(),
            signal,
            owner.documentId,
          );
          if (!allowed && !signal?.aborted) deniedToolCalls.add(context.toolCall.id);
          if (allowed && attendedScheduleApproval) {
            attachAssistantScheduleMcpApproval(context.args, approvedScheduleMcpBindings);
          }
          if (allowed) timeline.toolRunning(context.toolCall.id);
          else if (!signal?.aborted) timeline.toolFinished(context.toolCall.id, "blocked");
          if (allowed && computerUse && context.toolCall.name === COMPUTER_USE_TOOL_NAME) {
            try {
              if (!computerUseApproval) throw new Error("Computer Use approval was not prepared.");
              computerUse.authorize(
                context.toolCall.id,
                context.args as ComputerUseArgs,
                computerUseApproval,
              );
            } catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              timeline.toolFinished(context.toolCall.id, "blocked");
              return {
                block: true,
                reason: error instanceof Error ? error.message : "Computer Use approval expired.",
              };
            }
          }
          return allowed
            ? undefined
            : {
                block: true,
                reason: attendedScheduleApproval
                  ? 'The user declined this automation. Do not retry it. Reply briefly, "Okay—what else should we do?" and wait for their direction.'
                  : "The user denied this action.",
              };
        },
      });

      candidate.subscribe(async (event) => {
        switch (event.type) {
          case "message_start":
            if (event.message.role === "assistant") {
              requestUsage.started();
              currentAssistantTurnHadVisibleText = false;
              currentAssistantTurnHadReasoningDelta = false;
              currentAssistantTurnStart = {
                full: full.length,
                reasoning: reasoning.length,
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
            if (e.type === "text_delta") {
              const separator = !currentAssistantTurnHadVisibleText
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
            if (event.message.role === "assistant") {
              requestUsage.ended();
              lastAssistantMessage = event.message;
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
            const projection = reconcileTerminalAssistantProjection(
              { full, reasoning },
              currentAssistantTurnStart,
              event.message,
              exposeReasoning,
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
            timeline.reconcileContentOffset(currentAssistantTurnStart.full, full.length);
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
            const denied = deniedToolCalls.delete(event.toolCallId);
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
              generationCancelRequested()
                ? "cancelled"
                : denied
                  ? "blocked"
                  : event.isError
                    ? "failed"
                    : "completed",
              event.result?.details,
            );
            sendGeneration(streamId, "chat:tool", {
              streamId,
              phase: denied ? "blocked" : event.isError ? "error" : "result",
              toolName: event.toolName,
            });
            break;
          }
          default:
            break;
        }
      });
    } catch (error) {
      if (candidate) resetGenerationAgent(candidate, streamId);
      endLoadMonitor(initialization, streamId, false);
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
      piCompactionSessionStore.quarantineChatUntilRecovered(
        params.chatId,
        Promise.reject(new Error("Pi journal recovery requires application restart.")),
      );
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
        piCompactionSessionStore.quarantineChatUntilRecovered(params.chatId, recovery);
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
          await piRuntimeEffectStore.acknowledgeChatEffectsDurable(params.chatId);
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
    const activeGeneration: ActiveGeneration = {
      agent,
      chatId: params.chatId,
      owner,
      removeOwnerInvalidation: initialization.removeOwnerInvalidation,
      workspaceId: initialization.workspaceId,
      cancelRequested: initialization.cancelRequested,
      cancellationOrigin: initialization.cancellationOrigin,
      rendererDetached: initialization.rendererDetached,
      computerUse,
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
      resetGenerationAgent(agent, streamId);
      endLoadMonitor(activeGeneration, streamId, false);
      await computerUse?.close().catch(() => {});
      sendGeneration(streamId, "chat:done", {
        streamId,
        content: "",
        cancelled: true,
        cancellationOrigin: activeGeneration.cancellationOrigin,
      });
      releaseGenerationSkillReservation(activeGeneration);
      releaseGenerationBotAuthority(activeGeneration);
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
            onRetry: () => {
              full = full.slice(0, fullLengthBeforeAttempt);
              reasoning = reasoning.slice(0, reasoningLengthBeforeAttempt);
              timeline.rewindContentOffset(full.length);
              sendGeneration(streamId, "chat:delta", {
                streamId,
                delta: "",
                reset: true,
              });
            },
          },
        );
        pendingPiDurabilitySettlement = agent.pendingDurabilitySettlement();
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
        const finalError =
          runtimeOutcome.kind === "provider_failed"
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
              : null;
        if (runtimeOutcome.kind === "provider_failed") {
          logger.warn("pi", `Provider generation failed for stream ${streamId}.`, {
            category: runtimeOutcome.providerFailure?.category ?? "unknown",
            attempts: runtimeOutcome.attempts,
            retryExhausted: runtimeOutcome.providerFailure?.retryExhausted ?? false,
          });
        }
        if (finalError) {
          const finalTimeline = attachClaimCheck(timeline.finish("failed"), full);
          const persisted = await persistAssistant(
            full,
            reasoning,
            finalTimeline,
            runtimeOutcome.kind === "provider_failed" ? runtimeOutcome.providerFailure : undefined,
          );
          await finalizePiTurnPersistence(persisted);
          sendGeneration(streamId, "chat:error", {
            streamId,
            message: persisted.error
              ? `${finalError} The partial response could not be saved: ${persisted.error}`
              : finalError,
            content: full || undefined,
            reasoning: reasoning || undefined,
            timeline: finalTimeline,
            chat: chatForRenderer(persisted.chat ?? null) ?? undefined,
          });
        } else if (
          !generationHasVisibleOutput(
            full,
            uniqueResponseImages(sharedImages, displayedImages).length +
              displayedHtmlArtifacts.length,
          ) &&
          !wasCancelled
        ) {
          const finalTimeline = attachClaimCheck(timeline.finish("failed"), full);
          const persisted = await persistAssistant(full, reasoning, finalTimeline);
          await finalizePiTurnPersistence(persisted);
          sendGeneration(streamId, "chat:error", {
            streamId,
            message: persisted.error
              ? `The model returned an empty response, and its steps could not be saved: ${persisted.error}`
              : "The model returned an empty response. Try again.",
            reasoning: reasoning || undefined,
            timeline: finalTimeline,
            chat: chatForRenderer(persisted.chat ?? null) ?? undefined,
          });
        } else {
          // Covers both normal completion and user abort (partial `full`).
          const finalTimeline = attachClaimCheck(
            timeline.finish(
              wasCancelled ? "cancelled" : "completed",
              wasCancelled ? activeGeneration.cancellationOrigin : undefined,
            ),
            full,
          );
          const persisted = await persistAssistant(full, reasoning, finalTimeline);
          await finalizePiTurnPersistence(persisted);
          if (persisted.error) {
            sendGeneration(streamId, "chat:error", {
              streamId,
              message: `The response completed but could not be saved: ${persisted.error}`,
              content: full || undefined,
              reasoning: reasoning || undefined,
              timeline: finalTimeline,
            });
          } else {
            sendGeneration(streamId, "chat:done", {
              streamId,
              content: full,
              reasoning: reasoning || undefined,
              timeline: finalTimeline,
              chat: chatForRenderer(persisted.chat ?? null) ?? undefined,
            });
          }
        }
      } catch (error) {
        pendingPiDurabilitySettlement ??= agent.pendingDurabilitySettlement();
        logger.error("pi", `Generation failed for stream ${streamId}`, error);
        const finalTimeline = attachClaimCheck(timeline.finish("failed"), full);
        const persisted = await persistAssistant(full, reasoning, finalTimeline);
        await finalizePiTurnPersistence(persisted);
        sendGeneration(streamId, "chat:error", {
          streamId,
          message: persisted.error
            ? `The local agent runtime failed, and the partial response could not be saved: ${persisted.error}`
            : "The local agent runtime failed.",
          content: full || undefined,
          reasoning: reasoning || undefined,
          timeline: finalTimeline,
          chat: chatForRenderer(persisted.chat ?? null) ?? undefined,
        });
      } finally {
        try {
          endLoadMonitor(activeGeneration, streamId, false);
          resetGenerationAgent(agent, streamId);
          await computerUse?.close().catch(() => {});
        } finally {
          releaseGenerationSkillReservation(activeGeneration);
          releaseGenerationBotAuthority(activeGeneration);
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
        }
      }
    })();
    activeGeneration.completion = completion;
    void completion;
    return true;
  },

  /** Resolve a pending tool-approval request from the UI. */
  approve(approvalId: string, decision: ApprovalDecision, ownerDocumentId?: string): boolean {
    return approvals.decide(approvalId, decision === "allow", ownerDocumentId);
  },

  answerQuestionnaire(promptId: string, response: unknown, ownerDocumentId: string): boolean {
    return questionnaires.respond(promptId, response, ownerDocumentId);
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
    endLoadMonitor(runtimeOwner, streamId, false);
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
    if (initialization?.cancelRequested || generation?.cancelRequested) return false;
    if (initialization) {
      initialization.cancelRequested = true;
      initialization.cancellationOrigin = origin;
      initialization.controller.abort(new Error("Chat initialization cancelled."));
      endLoadMonitor(initialization, streamId, false);
      void initialization.computerUse?.close();
    }
    if (generation) {
      generation.cancelRequested = true;
      generation.cancellationOrigin = origin;
      generation.agent.abort();
      endLoadMonitor(generation, streamId, false);
      void generation.computerUse?.close();
    }
    subagentRuntimeRegistry.abortGeneration(streamId);
    approvals.cancelStream(streamId);
    logger.info("pi", `Generation ${streamId} cancellation requested (${origin}).`);
    return true;
  },

  isChatBusy(chatId: string): boolean {
    return chatTurnAdmission.isAdmitted(chatId) || chatHasGenerationOwnership(chatId);
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

  /** Wait for terminal persistence without cancelling work owned by another document. */
  async waitForChatIdle(chatId: string): Promise<boolean> {
    const deadline = Date.now() + CHAT_CANCEL_SETTLEMENT_GRACE_MS;
    while (this.isChatBusy(chatId)) {
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
  },

  /** Stop and drain foreground work before cross-store chat deletion begins. */
  async cancelChat(chatId: string): Promise<void> {
    await btwService.forget(chatId);
    for (const [streamId, entry] of [...initializing.entries()]) {
      if (entry.chatId === chatId) this.cancel(streamId, "chat_deletion");
    }
    for (const [streamId, entry] of [...active.entries()]) {
      if (entry.chatId === chatId) this.cancel(streamId, "chat_deletion");
    }
    subagentRuntimeRegistry.abortChat(chatId);
    const deadline = Date.now() + CHAT_CANCEL_SETTLEMENT_GRACE_MS;
    while (this.isChatBusy(chatId)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Aiden could not stop this chat before deletion.");
      }
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
  },

  /** Close generation admission before chat deletion performs its first await. */
  beginChatDeletion(chatId: string): () => void {
    const finish = chatDeletionGate.begin(chatId);
    chatTurnAdmission.releaseChat(chatId);
    return finish;
  },

  beginComputerUseSettingChange(chatId: string): (() => void) | null {
    return chatComputerUseMutationGate.tryBegin(chatId, this.isChatBusy(chatId));
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
      chatWorkspaceMutationGate.isChanging(chatId) ||
      chatComputerUseMutationGate.isChanging(chatId)
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
