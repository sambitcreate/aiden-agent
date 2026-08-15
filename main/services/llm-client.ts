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
  Agent,
  convertToLlm,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { access } from "node:fs/promises";
import { ipcMain, logger } from "../platform.js";
import { buildAgentTools } from "./tools.js";
import { APPROVAL_TOOL_NAMES, summarizeToolCall } from "./coding-tools.js";
import { gitInfo } from "./git.js";
import { configStore } from "./config-store.js";
import { secrets } from "./secrets.js";
import { chatStore } from "./chat-store.js";
import {
  formatAvailableSkills,
  type SkillRegistrySnapshot,
} from "./skill-registry.js";
import { skillRegistry } from "./skill-registry-main.js";
import {
  assistantTurnTextSeparator,
  buildAgentRuntimeOptions,
  reconcileTerminalAssistantProjection,
  resolveGenerationThinkingLevel,
  runtimeSupportsImages,
  settleGenerationCleanup,
  shouldExposeReasoning,
  terminalGenerationError,
  terminalGenerationLengthError,
  terminalGenerationInterruptionError,
  terminalGenerationWasAborted,
  waitForAbortableDelay,
  waitForGenerationStateClear,
} from "./generation-runtime.js";
import { ANTHROPIC_PROVIDER_ID } from "./anthropic-provider.js";
import { resolveModelRuntime } from "./model-runtime.js";
import { assistantUsageRecord } from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";
import { storedPiAssistantMessage } from "./pi-message-storage.js";
import { chatForRenderer } from "./visible-chat-projection.js";
import { cancelWorkspaceGenerationsAndSettle } from "./workspace-mutation-gate.js";
import type {
  ApprovalDecision,
  Chat,
  ChatStartParams,
  WorkspacePermission,
} from "./types.js";
import type { UsageRequestSource } from "./usage-store-core.js";
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
import { chatMessageToPiMessage } from "./generation-messages.js";
import {
  createPiCompactionModels,
  needsImmediatePiCompaction,
  PiCompactionCoordinator,
  type PiCompactionEvent,
} from "./pi-compaction-core.js";
import {
  appendPiMessages,
  beginPiGenerationTurn,
  commitPiGenerationTurn,
  piCompactionSessionStore,
  syncChatMessagesToPiSession,
} from "./pi-compaction-session-store.js";
import { createComputerUseController } from "./computer-use/runtime.js";
import { computerUseStatus } from "./computer-use/status.js";
import { GenerationTimelineProjector } from "./generation-timeline.js";
import {
  assertGenerationContextCapacity,
  createGenerationContextTransform,
} from "./generation-context.js";
import {
  buildGeminiWorkspaceSnapshot,
  GeminiContextCache,
} from "./gemini-context-cache.js";
import { attachClaimCheck } from "../../renderer/shared/claim-check.js";
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
import {
  startLocalModelLoadMonitor,
  type LocalModelLoadMonitor,
} from "./local-runtime-status.js";
import { isLocalProviderDeployment } from "../../renderer/shared/provider-deployment.js";
import {
  buildAssistantSystemPrompt,
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
  type PreparedSkillInvocation,
} from "./skill-invocation-turn.js";
import { ChatDeletionGate } from "./chat-deletion-gate.js";
import {
  authoritativeChatGenerationMode,
  authoritativeChatWorkspaceId,
} from "./chat-workspace-authority.js";
import { ChatWorkspaceMutationGate } from "./chat-workspace-mutation-gate.js";
import { ChatTurnAdmission } from "./chat-turn-admission.js";
import type { ChatTurnLease } from "./chat-turn-admission.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";

subagentRuntimeRegistry.setHealthMetrics(subagentHealthMetrics);

type GenerationPermission = WorkspacePermission | "read-only";

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
}

interface LoadMonitorState {
  monitor: LocalModelLoadMonitor;
  readyEmitted: boolean;
}

interface ActiveGeneration {
  agent: Agent;
  compaction: PiCompactionCoordinator;
  chatId: string;
  owner: ChatGenerationOwner;
  removeOwnerInvalidation: () => void;
  workspaceId?: string;
  cancelRequested: boolean;
  computerUse?: ComputerUseController;
  completion: Promise<void> | null;
  loadMonitor?: LoadMonitorState;
  releaseSkillReservation: () => void;
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
    controller: AbortController;
    computerUse?: ComputerUseController;
    loadMonitor?: LoadMonitorState;
    releaseSkillReservation: () => void;
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

function releaseGenerationSkillReservation(entry: {
  releaseSkillReservation: () => void;
}): void {
  const release = entry.releaseSkillReservation;
  entry.releaseSkillReservation = () => {};
  release();
}

function broadcastChatSettled(
  chatId: string,
  workspaceId: string | undefined,
  fallbackWorkspaceId: string | undefined,
): void {
  const normalizedWorkspaceId = persistedChatWorkspaceId(
    workspaceId ?? fallbackWorkspaceId,
  );
  if (
    !isSafeSubagentIdentifier(chatId) ||
    !isSafeSubagentIdentifier(normalizedWorkspaceId)
  ) {
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

function sendGeneration(
  streamId: string,
  channel: NotificationChannel,
  payload: unknown,
): boolean {
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
// A parent can be waiting for a child that is still constructing its tools.
// Give the child's own bounded cancellation drain time to report a cleanup
// miss before the outer parent shutdown deadline can release a soak receipt.
const SHUTDOWN_GENERATION_GRACE_MS =
  DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS + 1_000;

function resetGenerationAgent(agent: Agent, streamId: string): void {
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
  const base =
    "You are Pi, a capable AI assistant. Respond clearly and concisely, using Markdown for formatting and fenced code blocks for code.";
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
  signal: AbortSignal,
  computerUseGateSnapshot: number,
  activatedComputerUse: (controller: ComputerUseController) => void,
  ownerDocumentId: string,
  options: GenerationExecutionOptions,
) {
  const runtime = await resolveModelRuntime(
    params.providerId,
    params.model,
    signal,
  );
  const attendedAssistant = params.mode === "assistant";
  const assistantPersonaMode =
    params.mode === "assistant" || params.mode === "assistant-unattended";
  const assistantAutomationMode = params.mode === "assistant-automation";
  const assistantMode = assistantPersonaMode || assistantAutomationMode;
  // The dock persona is never folder-scoped. Project automation mode is
  // main-only and reaches this branch only after the persisted approval profile
  // has bound the scheduled run to a workspace.
  const workspace =
    params.workspaceId && !assistantPersonaMode
      ? await configStore.getWorkspace(params.workspaceId)
      : undefined;
  if (workspace) await assertManagedWorktreeAdmission(workspace);
  const permission: GenerationPermission =
    options.permission ?? workspace?.permission ?? "ask";
  const folderPath = workspace?.folderPath;
  const git = folderPath ? await gitInfo(folderPath) : { isRepo: false };
  // The resolved runtime model is the connection-bound capability authority.
  // Display metadata must not re-enable an input that Pi or discovery rejected.
  const model = runtime.model;
  if (assistantAutomationMode || params.mode === "assistant-unattended") {
    assertScheduledProviderFingerprint(
      runtime.provider,
      options.providerFingerprint,
    );
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
          : undefined;
  const thinkingLevel = resolveGenerationThinkingLevel(
    params.providerId,
    model,
    params.thinkingLevel ?? savedThinkingLevel,
  );
  let computerUse: ComputerUseController | undefined;
  if (
    options.allowComputerUse !== false &&
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
      throw new Error(
        `Computer Use is enabled for this chat but is not ready. ${status.detail}`,
      );
    }
    if (
      computerUseGenerationGate.isCurrent(computerUseGateSnapshot) &&
      status.ready
    ) {
      computerUse = createComputerUseController(streamId, supportsImages);
      activatedComputerUse(computerUse);
    }
  }
  const toolPermission: WorkspacePermission =
    permission === "read-only" ? "full" : permission;
  const allowSubagents = subagentsAllowedForGeneration({
    assistantMode,
    allowSubagents: options.allowSubagents,
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
  const subagentWriteEnabled = subagentWorkspaceWriteAllowedForGeneration({
    subagentsAllowed: allowSubagents,
    childWriteRollout,
    v2StoreSelected: subagentRunStore.selection === "v2",
    workspacePermission: workspace?.permission,
    generationPermission: permission,
  });
  const subagentWebEnabled =
    allowSubagents &&
    childWebRollout &&
    settings.exaEnabled === true &&
    Boolean(await secrets.getKey("exa"));
  const subagentMcpInventory =
    allowSubagents && childMcpRollout && subagentRunStore.selection === "v2"
      ? await resolveProductionSubagentMcpInventory(signal)
      : [];
  const subagentShellBinary = resolveSubagentShellRunnerBinary();
  const subagentShellEnabled =
    allowSubagents &&
    childShellRollout &&
    subagentRunStore.selection === "v2" &&
    workspace?.permission !== "none" &&
    permission !== "none" &&
    (await access(subagentShellBinary).then(
      () => true,
      () => false,
    ));
  const subagentDelegationEnabled =
    allowSubagents &&
    childDelegationRollout &&
    subagentRunStore.selection === "v2" &&
    workspace?.permission !== "none" &&
    permission !== "none";
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
          requestApproval: (
            descriptor,
            approvalSignal,
            approvalOwnerDocumentId,
          ) =>
            approvals.request(
              descriptor,
              approvalSignal,
              approvalOwnerDocumentId,
            ),
          currentWorkspace: (workspaceId) =>
            configStore.getWorkspace(workspaceId),
          validateWorkspace: (candidate) =>
            assertManagedWorktreeAdmission(candidate),
          workspaceOperationRegistry,
          control:
            subagentRunStore.selection === "v2"
              ? subagentControlMainV2
              : undefined,
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
              throw new Error(
                "Subagent control projector state is unavailable.",
              );
            }
            return snapshot;
          },
          settleControlSnapshots: () =>
            subagentProjector?.flush() ??
            Promise.reject(
              new Error("Subagent control projector is unavailable."),
            ),
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
          inheritedCeiling: inheritedSubagentReadToolCeiling(
            options.excludeToolNames,
          ),
          loadPersistedChatForFork: async (forkSignal) => {
            if (subagentRunStore.selection !== "v2") {
              throw new Error(
                "Forked subagent context is unavailable during V1 rollback.",
              );
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
            if (
              !persisted ||
              persistedChatWorkspaceId(persisted.workspaceId) !== workspace.id
            ) {
              throw new Error(
                "Forked subagent context no longer belongs to this workspace.",
              );
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
  const skillSnapshot =
    !assistantMode && workspace
      ? await skillRegistry.snapshotResolved(workspace)
      : undefined;
  const tools = (
    await buildAgentTools({
      workspaceId: workspace?.id,
      workspaceRoot: folderPath,
      skillSnapshot,
      permission: toolPermission,
      computerUse,
      allowScheduling:
        (!assistantMode || attendedAssistant) &&
        !options.excludeToolNames?.has(SCHEDULE_TOOL_NAME),
      allowMcpTools: options.allowMcpTools,
      mcpServerIds: options.mcpServerIds,
      mcpServerBindings: options.mcpServerBindings,
      allowSubagents,
      mode: assistantPersonaMode
        ? "assistant"
        : assistantAutomationMode
          ? "assistant-automation"
          : undefined,
      assistantModelSelection: attendedAssistant
        ? assistantModelSelection
        : undefined,
      createSubagentTool: subagentSupervisor
        ? () =>
            createSubagentTool(
              subagentSupervisor,
              projectRequestableSubagentMcpInventoryV2(subagentMcpInventory),
              subagentWriteEnabled,
              childMcpMutationsRollout
                ? projectRequestableSubagentMcpMutationInventoryV2(
                    subagentMcpInventory,
                  )
                : [],
              subagentShellEnabled,
              subagentDelegationEnabled,
            )
        : undefined,
    })
  ).filter((tool) => !options.excludeToolNames?.has(tool.name));
  let googleWorkspaceSnapshot: string | undefined;
  if (
    params.providerId === GOOGLE_PROVIDER_ID &&
    workspace?.id &&
    folderPath &&
    permission !== "none"
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
    supportsImages,
    thinkingLevel,
    computerUse,
    googleWorkspaceSnapshot,
    skillSnapshot,
    workspaceId: workspace?.id,
    subagentSupervisor,
    // The Aiden system prompt reads its approval posture from settings, which
    // are already loaded here; re-reading them at the prompt site would be a
    // second disk round trip inside the generation's hot path.
    assistantSettingsPermission:
      settings.assistant?.settingsPermission ?? "ask",
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
        throw new Error(
          "This message turn expired before generation could start.",
        );
      }
      if (chatDeletionGate.isDeleting(params.chatId)) {
        throw new Error("This chat is being deleted.");
      }
      if (chatComputerUseMutationGate.isChanging(params.chatId)) {
        throw new Error(
          "Computer Use settings are changing for this chat. Try again in a moment.",
        );
      }
      if (chatWorkspaceMutationGate.isChanging(params.chatId)) {
        throw new Error(
          "This chat is changing workspaces. Try again in a moment.",
        );
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
        chatTurnAdmission.releaseMatching(
          params.chatId,
          turnId,
          owner.documentId,
        );
      }
      throw error;
    }
    const initialization = {
      chatId: params.chatId,
      owner,
      removeOwnerInvalidation: () => {},
      workspaceId: undefined as string | undefined,
      cancelRequested: false,
      controller: new AbortController(),
      computerUse: undefined as ComputerUseController | undefined,
      loadMonitor: undefined as LoadMonitorState | undefined,
      skillInvocation: undefined as PreparedSkillInvocation | undefined,
      skillPrompt: undefined as string | undefined,
      releaseSkillReservation: () => {},
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
          },
        );
    } catch (error) {
      if (turnId)
        chatTurnAdmission.releaseMatching(
          params.chatId,
          turnId,
          owner.documentId,
        );
      throw error;
    }
    if (!handedOff) {
      throw new Error(
        "This message turn expired before generation could start.",
      );
    }
    options.onTurnAccepted?.();
    initialization.removeOwnerInvalidation = owner.onInvalidated(() => {
      this.cancel(streamId);
    });
    if (initialization.controller.signal.aborted)
      initialization.removeOwnerInvalidation();
    let setup: Awaited<ReturnType<typeof prepareGeneration>>;
    let authoritativeChat!: Chat;
    let authoritativeMode: ChatStartParams["mode"];
    try {
      const chat = await chatStore.get(params.chatId);
      if (!chat) {
        throw new Error("This chat is no longer available.");
      }
      authoritativeChat = chat;
      authoritativeMode = authoritativeChatGenerationMode(
        chat.workspaceId,
        params.mode,
      );
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
        initialization.controller.signal,
        computerUseGateSnapshot,
        (computerUse) => {
          initialization.computerUse = computerUse;
        },
        owner.documentId,
        options,
      );
    } catch (error) {
      if (
        initialization.cancelRequested ||
        initialization.controller.signal.aborted
      ) {
        sendGeneration(streamId, "chat:done", { streamId, content: "" });
        releaseGenerationSkillReservation(initialization);
        initializing.delete(streamId);
        initialization.removeOwnerInvalidation();
        broadcastChatSettled(
          params.chatId,
          initialization.workspaceId,
          params.workspaceId,
        );
        return false;
      }
      releaseGenerationSkillReservation(initialization);
      initializing.delete(streamId);
      initialization.removeOwnerInvalidation();
      broadcastChatSettled(
        params.chatId,
        initialization.workspaceId,
        params.workspaceId,
      );
      throw error;
    }
    const {
      runtime,
      permission,
      folderPath,
      git,
      tools,
      supportsImages,
      thinkingLevel,
      computerUse,
      googleWorkspaceSnapshot,
      skillSnapshot,
      workspaceId,
      assistantSettingsPermission,
      subagentSupervisor,
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
    const exposeReasoning = shouldExposeReasoning(params.providerId);

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
      initialization.cancelRequested ||
      active.get(streamId)?.cancelRequested === true;
    const persistAssistant = async (
      content: string,
      reasoning: string,
      finalTimeline: ReturnType<GenerationTimelineProjector["snapshot"]>,
    ) => {
      const subagents = subagentMessageReference(
        streamId,
        subagentSupervisor?.snapshots() ?? [],
      );
      if (
        !content.trim() &&
        !reasoning.trim() &&
        finalTimeline.steps.length === 0 &&
        !subagents
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
              ? storedPiAssistantMessage(lastAssistantMessage)
              : undefined,
            timeline: finalTimeline.steps.length ? finalTimeline : undefined,
            subagents,
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
        return { chat, error: undefined, messageId };
      } catch (error) {
        logger.error(
          "pi",
          `Could not persist response for stream ${streamId}`,
          error,
        );
        return {
          chat: undefined,
          error: "local storage failed",
          messageId: undefined,
        };
      }
    };
    let full = "";
    let reasoning = "";
    let errored: string | null = null;
    let aborted = false;
    let currentAssistantTurnHadVisibleText = false;
    let currentAssistantTurnHadReasoningDelta = false;
    let currentAssistantTurnStart = { full: 0, reasoning: 0 };
    let pendingPiMessages: AgentMessage[] = [];
    let lastAssistantMessage: AssistantMessage | undefined;
    let emergencyContextReduction = false;
    let activeCompactionStepId: string | undefined;
    let generationJournalLeafId: string | null = null;
    let piSession:
      Awaited<ReturnType<typeof piCompactionSessionStore.openChat>> | undefined;
    let compaction: PiCompactionCoordinator | undefined;
    let candidate: Agent | null = null;
    let piJournalHealthy = true;
    let flushPiMessages: () => Promise<boolean> = async () =>
      pendingPiMessages.length === 0;
    try {
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
      const systemPrompt =
        authoritativeMode === "assistant" ||
        authoritativeMode === "assistant-unattended"
          ? buildAssistantSystemPrompt({
              settingsSections: SETTINGS_SECTIONS,
              settingsPermission: assistantSettingsPermission,
              availableTools: tools.map((tool) => tool.name),
              mcpServers: assistantMcpInventory.servers,
              mcpServerTotal: assistantMcpInventory.totalEnabledServers,
              mcpInventoryTruncated: assistantMcpInventory.truncated,
              mcpOmittedInvalidIdentities:
                assistantMcpInventory.omittedInvalidIdentities,
              unattended: authoritativeMode === "assistant-unattended",
            })
          : authoritativeMode === "assistant-automation"
            ? withUnattendedAssistantContract(
                await buildSystemPrompt(
                  folderPath,
                  git.branch,
                  permission,
                  false,
                  false,
                ),
              )
            : await buildSystemPrompt(
                folderPath,
                git.branch,
                permission,
                tools.some((tool) => tool.name === "subagent"),
                true,
                skillSnapshot,
                new Set(tools.map((tool) => tool.name)),
              );
      assertGenerationContextCapacity({
        contextWindow: model.contextWindow,
        systemPrompt,
        tools,
      });
      piSession = await piCompactionSessionStore.openChat(params.chatId);
      const onCompactionEvent = (event: PiCompactionEvent) => {
        if (event.type === "start") {
          activeCompactionStepId = timeline.compactionStarted();
          logger.info(
            "pi",
            `Started ${event.reason} compaction for stream ${streamId}.`,
            {
              model: model.id,
            },
          );
          return;
        }
        if (activeCompactionStepId) {
          timeline.compactionFinished(
            activeCompactionStepId,
            event.aborted ? "cancelled" : event.result ? "completed" : "failed",
          );
          activeCompactionStepId = undefined;
        }
        logger.info(
          "pi",
          `Finished ${event.reason} compaction for stream ${streamId}.`,
          {
            aborted: event.aborted,
            tokensBefore: event.result?.tokensBefore,
            estimatedTokensAfter: event.result?.estimatedTokensAfter,
            willRetry: event.willRetry,
          },
        );
        if (event.errorMessage) {
          logger.warn(
            "pi",
            `Compaction failed for stream ${streamId}: ${event.errorMessage}`,
          );
        }
      };
      compaction = new PiCompactionCoordinator({
        session: piSession,
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
      });
      const promptJournal = piSession;
      flushPiMessages = async (): Promise<boolean> => {
        if (pendingPiMessages.length === 0) return true;
        const batch = pendingPiMessages;
        pendingPiMessages = [];
        try {
          await appendPiMessages(promptJournal, batch);
          return true;
        } catch (error) {
          piJournalHealthy = false;
          pendingPiMessages = [...batch, ...pendingPiMessages];
          logger.error(
            "pi",
            `Could not append Pi session messages for stream ${streamId}.`,
            error,
          );
          return false;
        }
      };

      const currentUser = [...authoritativeChat.messages]
        .reverse()
        .find((message) => message.role === "user");
      const priorVisibleMessages = currentUser
        ? authoritativeChat.messages.filter(
            (message) => message.id !== currentUser.id,
          )
        : authoritativeChat.messages;
      await syncChatMessagesToPiSession(
        piSession,
        priorVisibleMessages,
        model,
        supportsImages,
      );
      const prePromptContext = await piSession.buildContext();
      const previousAssistant = [...prePromptContext.messages]
        .reverse()
        .find(
          (message): message is AssistantMessage =>
            message.role === "assistant",
        );
      let prePromptMessages = prePromptContext.messages;
      if (previousAssistant) {
        const prePromptCompaction = await compaction.check(previousAssistant, {
          includeAborted: true,
        });
        if (prePromptCompaction.messages) {
          prePromptMessages = [...prePromptCompaction.messages];
          const trailing = prePromptMessages[prePromptMessages.length - 1];
          if (
            prePromptCompaction.shouldRetry ||
            (trailing?.role === "assistant" && trailing.stopReason === "error")
          ) {
            prePromptMessages.pop();
          }
        }
      }
      let currentPromptMessages: AgentMessage[] | undefined;
      if (currentUser) {
        const contentOverrides = new Map<string, string>();
        if (
          initialization.skillInvocation?.userMessageId === currentUser.id &&
          initialization.skillPrompt
        ) {
          contentOverrides.set(currentUser.id, initialization.skillPrompt);
        }
        await syncChatMessagesToPiSession(
          piSession,
          authoritativeChat.messages,
          model,
          supportsImages,
          contentOverrides,
        );
        compaction.beginPrompt();
        const currentPromptCompaction = await compaction.checkContextPressure();
        if (currentPromptCompaction.messages) {
          currentPromptMessages = [...currentPromptCompaction.messages];
        }
      }
      const initialMessages =
        currentPromptMessages ??
        (currentUser
          ? [
              ...prePromptMessages,
              chatMessageToPiMessage(
                currentUser,
                model,
                supportsImages,
                initialization.skillInvocation?.userMessageId === currentUser.id
                  ? initialization.skillPrompt
                  : undefined,
              ),
            ]
          : (await piSession.buildContext()).messages);
      generationJournalLeafId = await piSession.getLeafId();
      initialization.skillInvocation = undefined;
      initialization.skillPrompt = undefined;
      if (!currentUser) compaction.beginPrompt();
      candidate = new Agent({
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
            tools,
            supportsImages,
          },
          (result) => {
            emergencyContextReduction = true;
            logger.info(
              "pi",
              `Compacted generation context for stream ${streamId}.`,
              {
                model: model.id,
                estimatedTokensBefore: result.estimatedTokensBefore,
                estimatedTokensAfter: result.estimatedTokensAfter,
                inputBudgetTokens: result.inputBudgetTokens,
                truncatedToolResults: result.truncatedToolResults,
                compactedToolResults: result.compactedToolResults,
                removedHistoryMessages: result.removedHistoryMessages,
                removedCurrentTurnMessages: result.removedCurrentTurnMessages,
                usedContextFallback: result.usedContextFallback,
              },
            );
          },
        ),
        initialState: {
          systemPrompt,
          model,
          thinkingLevel,
          tools,
          messages: initialMessages,
        },
        // Aiden tools can mutate the same workspace, scheduler, or external
        // service. Preserve model-authored ordering across the foreground run.
        toolExecution: "sequential",
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
          if (!(await flushPiMessages())) {
            return changed ? { context: nextContext } : undefined;
          }
          // Tool results are now durable, so estimate the complete journal
          // rather than the preceding assistant usage alone.
          const immediate = needsImmediatePiCompaction(
            toolResults,
            model.contextWindow,
          );
          const result = await compaction?.checkContextPressure({
            forceThreshold: immediate,
            sealCurrentTurnIfNeeded: immediate,
          });
          emergencyContextReduction = false;
          if (result?.messages) {
            // Pi's loop uses the returned context for this run; explicitly
            // install the checkpoint for the Agent's next prompt too.
            if (candidate) candidate.state.messages = [...result.messages];
            return {
              context: { ...nextContext, messages: [...result.messages] },
            };
          }
          return changed ? { context: nextContext } : undefined;
        },
        // Computer Use mutations always pause. Folder mutations pause in "ask" mode.
        beforeToolCall: async (context, signal) => {
          timeline.toolStarted(
            context.toolCall.id,
            context.toolCall.name,
            context.args,
          );
          let summary: string;
          let approvalDetails: ToolApprovalDetails | undefined;
          let computerUseApproval: ComputerUseApprovalDescriptor | undefined;
          let attendedScheduleApproval = false;
          let approvedScheduleMcpBindings: import("./types.js").ScheduledMcpServerBinding[] =
            [];
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
                  error instanceof Error
                    ? error.message
                    : "Computer Use rejected this action.",
              };
            }
          } else {
            const createScheduleApproval =
              context.toolCall.name === SCHEDULE_TOOL_NAME &&
              scheduleToolRequiresApproval(context.args);
            const editScheduleApproval =
              context.toolCall.name === EDIT_AUTOMATION_TOOL_NAME;
            const scheduleApproval =
              createScheduleApproval || editScheduleApproval;
            const workspaceApproval =
              permission === "ask" &&
              APPROVAL_TOOL_NAMES.has(context.toolCall.name);
            attendedScheduleApproval = scheduleApproval && attendedAssistant;
            if (!scheduleApproval && !workspaceApproval) {
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
                const [project, mcpResolution, liveSettings] =
                  await Promise.all([
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
                  schedulerEnabled:
                    liveSettings.scheduledTasksEnabled !== false,
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
              if (!toolCallId)
                throw new Error("The tool approval step was not initialized.");
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
          if (!allowed && !signal?.aborted)
            deniedToolCalls.add(context.toolCall.id);
          if (allowed && attendedScheduleApproval) {
            attachAssistantScheduleMcpApproval(
              context.args,
              approvedScheduleMcpBindings,
            );
          }
          if (allowed) timeline.toolRunning(context.toolCall.id);
          else if (!signal?.aborted)
            timeline.toolFinished(context.toolCall.id, "blocked");
          if (
            allowed &&
            computerUse &&
            context.toolCall.name === COMPUTER_USE_TOOL_NAME
          ) {
            try {
              if (!computerUseApproval)
                throw new Error("Computer Use approval was not prepared.");
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
                reason:
                  error instanceof Error
                    ? error.message
                    : "Computer Use approval expired.",
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
            if (e.type === "text_delta") {
              const separator =
                !currentAssistantTurnHadVisibleText
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
                !currentAssistantTurnHadReasoningDelta && reasoning.trim()
                  ? "\n\n"
                  : "";
              const delta = `${separator}${e.delta}`;
              reasoning += delta;
              currentAssistantTurnHadReasoningDelta = true;
              noteModelBecameReady();
              sendGeneration(streamId, "chat:reasoning-delta", {
                streamId,
                delta,
              });
            } else if (e.type === "error" && e.reason === "error") {
              errored = e.error.errorMessage ?? "Generation failed.";
            }
            break;
          }
          case "message_end": {
            pendingPiMessages.push(event.message);
            if (event.message.role === "assistant") {
              lastAssistantMessage = event.message;
              await usageStore.record(
                assistantUsageRecord({
                  message: event.message,
                  provider: runtime.provider,
                  model,
                  source: options.usageSource ?? "chat",
                }),
              );
            }
            const terminalError = terminalGenerationError(event.message);
            if (terminalError) errored = terminalError;
            const lengthError = terminalGenerationLengthError(event.message);
            if (lengthError) errored = lengthError;
            if (terminalGenerationWasAborted(event.message)) aborted = true;
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
            timeline.reconcileContentOffset(
              currentAssistantTurnStart.full,
              full.length,
            );
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
              logger.warn(
                "pi",
                `Attended schedule proposal failed for stream ${streamId}.`,
                {
                  reason:
                    typeof reason === "string"
                      ? reason.slice(0, 320)
                      : "Unknown error.",
                },
              );
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
      if (
        initialization.cancelRequested ||
        initialization.controller.signal.aborted
      ) {
        sendGeneration(streamId, "chat:done", { streamId, content: "" });
        releaseGenerationSkillReservation(initialization);
        initializing.delete(streamId);
        initialization.removeOwnerInvalidation();
        broadcastChatSettled(
          params.chatId,
          initialization.workspaceId,
          params.workspaceId,
        );
        return false;
      }
      releaseGenerationSkillReservation(initialization);
      initializing.delete(streamId);
      initialization.removeOwnerInvalidation();
      broadcastChatSettled(
        params.chatId,
        initialization.workspaceId,
        params.workspaceId,
      );
      throw error;
    }
    const agent = candidate;
    if (!agent || !piSession || !compaction) {
      endLoadMonitor(initialization, streamId, false);
      releaseGenerationSkillReservation(initialization);
      initializing.delete(streamId);
      initialization.removeOwnerInvalidation();
      broadcastChatSettled(
        params.chatId,
        initialization.workspaceId,
        params.workspaceId,
      );
      throw new Error("Could not initialize the generation agent.");
    }
    const piJournal = piSession;
    const piCoordinator = compaction;
    const piTurnStartLeafId = generationJournalLeafId;
    let generationTurnTransactionId: string | undefined;
    try {
      generationTurnTransactionId = await beginPiGenerationTurn(piJournal);
    } catch (error) {
      piJournalHealthy = false;
      logger.warn(
        "pi",
        `Could not begin the crash-recovery envelope for stream ${streamId}.`,
        error,
      );
    }
    const finalizePiTurnPersistence = async (persisted: {
      chat: Chat | undefined;
      error: string | undefined;
      messageId: string | undefined;
    }) => {
      if (persisted.error) {
        try {
          await piJournal.moveTo(piTurnStartLeafId);
        } catch (error) {
          logger.error(
            "pi",
            `Could not roll back an unpersisted Pi turn for stream ${streamId}.`,
            error,
          );
        }
        piJournalHealthy = false;
        generationTurnTransactionId = undefined;
        return;
      }
      if (!persisted.messageId) {
        await piJournal.moveTo(piTurnStartLeafId).catch(() => undefined);
        generationTurnTransactionId = undefined;
        return;
      }
      const reconcileVisibleAssistant = async () => {
        await piJournal.moveTo(piTurnStartLeafId);
        const visible = persisted.chat?.messages.find(
          (message) => message.id === persisted.messageId,
        );
        if (!visible) {
          throw new Error(
            "The persisted assistant could not be found for Pi journal recovery.",
          );
        }
        await syncChatMessagesToPiSession(
          piJournal,
          [visible],
          model,
          supportsImages,
        );
        generationTurnTransactionId = undefined;
      };
      if (!piJournalHealthy) {
        try {
          await reconcileVisibleAssistant();
        } catch (recoveryError) {
          logger.error(
            "pi",
            `Could not reconcile the persisted assistant after a Pi batch failure for stream ${streamId}.`,
            recoveryError,
          );
        }
        return;
      }
      try {
        await appendPiMessages(piJournal, [], persisted.messageId);
        if (generationTurnTransactionId) {
          await commitPiGenerationTurn(
            piJournal,
            generationTurnTransactionId,
          );
          generationTurnTransactionId = undefined;
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
          logger.error(
            "pi",
            `Could not reconcile the persisted assistant after a Pi marker failure for stream ${streamId}.`,
            recoveryError,
          );
        }
      }
    };
    const runWithPiCompaction = async () => {
      for (;;) {
        const fullLengthBeforeAttempt = full.length;
        const reasoningLengthBeforeAttempt = reasoning.length;
        lastAssistantMessage = undefined;
        try {
          await agent.continue();
        } catch (error) {
          await flushPiMessages();
          throw error;
        }
        const journalFlushed = await flushPiMessages();
        if (!journalFlushed) return;
        const completedAssistant = lastAssistantMessage as
          AssistantMessage | undefined;
        if (!completedAssistant) return;
        const result = await piCoordinator.check(completedAssistant, {
          forceThreshold: emergencyContextReduction,
        });
        emergencyContextReduction = false;
        if (result.errorMessage && completedAssistant.stopReason === "error") {
          errored = result.errorMessage;
        }
        if (!result.messages) return;

        agent.state.messages = [...result.messages];
        if (!result.shouldRetry) return;
        full = full.slice(0, fullLengthBeforeAttempt);
        reasoning = reasoning.slice(0, reasoningLengthBeforeAttempt);
        timeline.rewindContentOffset(full.length);
        errored = null;
        aborted = false;
        sendGeneration(streamId, "chat:delta", {
          streamId,
          delta: "",
          reset: true,
        });
        await waitForAbortableDelay(
          result.retryDelayMs ?? 0,
          initialization.controller.signal,
        );
      }
    };

    const activeGeneration: ActiveGeneration = {
      agent,
      compaction: piCoordinator,
      chatId: params.chatId,
      owner,
      removeOwnerInvalidation: initialization.removeOwnerInvalidation,
      workspaceId: initialization.workspaceId,
      cancelRequested: false,
      computerUse,
      completion: null,
      loadMonitor: initialization.loadMonitor,
      releaseSkillReservation: initialization.releaseSkillReservation,
    };
    initialization.releaseSkillReservation = () => {};
    initialization.loadMonitor = undefined;
    loadHost = activeGeneration;
    // Publish the active owner before removing initialization so cancellation
    // cannot fall into a map-transition gap and leave a privileged run alive.
    active.set(streamId, activeGeneration);
    initializing.delete(streamId);
    if (initialization.cancelRequested || activeGeneration.cancelRequested) {
      resetGenerationAgent(agent, streamId);
      endLoadMonitor(activeGeneration, streamId, false);
      await computerUse?.close().catch(() => {});
      sendGeneration(streamId, "chat:done", { streamId, content: "" });
      releaseGenerationSkillReservation(activeGeneration);
      active.delete(streamId);
      activeGeneration.removeOwnerInvalidation();
      broadcastChatSettled(
        params.chatId,
        activeGeneration.workspaceId,
        params.workspaceId,
      );
      return false;
    }

    const completion = (async () => {
      try {
        await runWithPiCompaction();
        const wasCancelled = activeGeneration.cancelRequested;
        const finalError = wasCancelled
          ? null
          : (terminalGenerationInterruptionError(aborted, wasCancelled) ??
            errored ??
            agent.state.errorMessage?.trim() ??
            null);
        if (finalError) {
          const finalTimeline = attachClaimCheck(
            timeline.finish("failed"),
            full,
          );
          const persisted = await persistAssistant(
            full,
            reasoning,
            finalTimeline,
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
        } else if (!full.trim() && !wasCancelled) {
          const finalTimeline = attachClaimCheck(
            timeline.finish("failed"),
            full,
          );
          const persisted = await persistAssistant(
            full,
            reasoning,
            finalTimeline,
          );
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
            timeline.finish(wasCancelled ? "cancelled" : "completed"),
            full,
          );
          const persisted = await persistAssistant(
            full,
            reasoning,
            finalTimeline,
          );
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
        const message = error instanceof Error ? error.message : String(error);
        logger.error("pi", `Generation failed for stream ${streamId}`, error);
        const finalTimeline = attachClaimCheck(timeline.finish("failed"), full);
        const persisted = await persistAssistant(
          full,
          reasoning,
          finalTimeline,
        );
        await finalizePiTurnPersistence(persisted);
        sendGeneration(streamId, "chat:error", {
          streamId,
          message: persisted.error
            ? `${message} The partial response could not be saved: ${persisted.error}`
            : message,
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
          active.delete(streamId);
          activeGeneration.removeOwnerInvalidation();
          broadcastChatSettled(
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
  approve(
    approvalId: string,
    decision: ApprovalDecision,
    ownerDocumentId?: string,
  ): boolean {
    return approvals.decide(approvalId, decision === "allow", ownerDocumentId);
  },

  cancel(streamId: string, ownerDocumentId?: string): boolean {
    const initialization = initializing.get(streamId);
    const generation = active.get(streamId);
    const owner = initialization?.owner ?? generation?.owner;
    if (
      !owner ||
      (ownerDocumentId !== undefined && owner.documentId !== ownerDocumentId)
    ) {
      return false;
    }
    if (initialization) {
      initialization.cancelRequested = true;
      initialization.controller.abort(
        new Error("Chat initialization cancelled."),
      );
      endLoadMonitor(initialization, streamId, false);
      void initialization.computerUse?.close();
    }
    if (generation) {
      generation.cancelRequested = true;
      generation.compaction.abort();
      generation.agent.abort();
      endLoadMonitor(generation, streamId, false);
      void generation.computerUse?.close();
    }
    subagentRuntimeRegistry.abortGeneration(streamId);
    approvals.cancelStream(streamId);
    return true;
  },

  isChatBusy(chatId: string): boolean {
    return (
      chatTurnAdmission.isAdmitted(chatId) || chatHasGenerationOwnership(chatId)
    );
  },

  /** Detect only orphaned renderer ownership; normal visible generations never delay reads. */
  isChatOwnedByInactiveRenderer(chatId: string): boolean {
    return (
      [...initializing.values()].some(
        (entry) =>
          entry.chatId === chatId &&
          entry.owner.id !== 0 &&
          entry.owner.isDestroyed(),
      ) ||
      [...active.values()].some(
        (entry) =>
          entry.chatId === chatId &&
          entry.owner.id !== 0 &&
          entry.owner.isDestroyed(),
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
      const pause = new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(25, remaining)),
      );
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
    for (const [streamId, entry] of [...initializing.entries()]) {
      if (entry.chatId === chatId) this.cancel(streamId);
    }
    for (const [streamId, entry] of [...active.entries()]) {
      if (entry.chatId === chatId) this.cancel(streamId);
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
      const pause = new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(25, remaining)),
      );
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
    return chatComputerUseMutationGate.tryBegin(
      chatId,
      this.isChatBusy(chatId),
    );
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
  beginChatTurn(
    chatId: string,
    turnId: string,
    ownerId: string,
  ): ChatTurnLease | null {
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
    return chatTurnAdmission.tryBegin(
      chatId,
      turnId,
      ownerId,
      chatHasGenerationOwnership(chatId),
    );
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
      this.cancel(streamId);
    }
  },

  /** Stop and drain generations before a workspace authority boundary changes. */
  async cancelWorkspaceAndSettle(workspaceId: string): Promise<void> {
    await cancelWorkspaceGenerationsAndSettle({
      workspaceId,
      initializations: () => initializing,
      active: () => active,
      cancel: (streamId) => {
        this.cancel(streamId);
      },
      abortChildren: (targetWorkspaceId) => {
        subagentRuntimeRegistry.abortWorkspace(targetWorkspaceId);
      },
      hasChildren: (targetWorkspaceId) =>
        subagentRuntimeRegistry.hasWorkspaceChildren(targetWorkspaceId),
      timeoutMessage:
        "Aiden could not stop this workspace before changing its access.",
      timeoutMs: WORKSPACE_CANCEL_SETTLEMENT_GRACE_MS,
    });
    await geminiContextCache.invalidateWorkspace(workspaceId);
  },

  abortAll(): void {
    chatTurnAdmission.releaseAll();
    for (const [streamId] of initializing) this.cancel(streamId);
    for (const [streamId] of active) this.cancel(streamId);
    approvals.shutdown();
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
      (error) =>
        logger.warn(
          "pi",
          "Could not clear one generation during shutdown.",
          error,
        ),
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
