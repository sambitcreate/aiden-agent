// Chat generation via pi's embedded agent loop (@earendil-works/pi-agent-core +
// pi-ai). A fresh Agent runs per generation: it owns multi-step tool calling
// (folder-scoped coding tools, Exa search, Agent Skills, MCP servers) and
// streams assistant text. Text, local-model reasoning, and tool activity are
// pushed to the exact renderer document that owns the generation.
//
// Workspaces bind a folder + a permission level. In "ask" mode the agent pauses
// before any mutating tool (write/edit/run_command) via pi's `beforeToolCall`
// hook and waits for the user to Allow or Deny in the UI.

import { Agent } from "@earendil-works/pi-agent-core";
import { logger } from "../platform.js";
import { buildAgentTools, skillToolKey } from "./tools.js";
import { APPROVAL_TOOL_NAMES, summarizeToolCall } from "./coding-tools.js";
import { gitInfo } from "./git.js";
import { configStore } from "./config-store.js";
import { chatStore } from "./chat-store.js";
import { discoverSkills } from "./skills-discovery.js";
import {
  buildAgentRuntimeOptions,
  resolveGenerationThinkingLevel,
  runtimeSupportsImages,
  settleGenerationCleanup,
  shouldExposeReasoning,
  terminalAssistantReasoningFallback,
  terminalAssistantTextFallback,
  terminalGenerationError,
  terminalGenerationInterruptionError,
  terminalGenerationWasAborted,
} from "./generation-runtime.js";
import { ANTHROPIC_PROVIDER_ID } from "./anthropic-provider.js";
import { resolveModelRuntime } from "./model-runtime.js";
import { assistantUsageRecord } from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";
import type {
  ApprovalDecision,
  ChatStartParams,
  DiscoveredSkill,
  Skill,
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
  SCHEDULE_TOOL_NAME,
  scheduleToolRequiresApproval,
  summarizeScheduleToolCall,
} from "./schedule-tool.js";
import { ToolApprovalCoordinator } from "./tool-approval.js";
import { toPiMessages } from "./generation-messages.js";
import { createComputerUseController } from "./computer-use/runtime.js";
import { computerUseStatus } from "./computer-use/status.js";
import { GenerationTimelineProjector } from "./generation-timeline.js";
import {
  assertGenerationContextCapacity,
  createGenerationContextTransform,
} from "./generation-context.js";
import { buildGeminiWorkspaceSnapshot, GeminiContextCache } from "./gemini-context-cache.js";
import { attachClaimCheck } from "../../renderer/shared/claim-check.js";
import { listWorkspaceFiles } from "./workspace-files.js";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import {
  activatedComputerUseStreamIds,
  ChatComputerUseMutationGate,
  ComputerUseGenerationGate,
} from "./computer-use/generation-gate.js";
import type { NotificationChannel } from "../../renderer/preload-channels.js";

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
}

interface ActiveGeneration {
  agent: Agent;
  chatId: string;
  owner: ChatGenerationOwner;
  removeOwnerInvalidation: () => void;
  workspaceId?: string;
  cancelRequested: boolean;
  computerUse?: ComputerUseController;
  completion: Promise<void> | null;
}

const active = new Map<string, ActiveGeneration>();
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
  }
>();
const computerUseGenerationGate = new ComputerUseGenerationGate();
const chatComputerUseMutationGate = new ChatComputerUseMutationGate();
const geminiContextCache = new GeminiContextCache({
  onWarning: (message, error) => logger.warn("pi", message, error),
});

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

const approvals = new ToolApprovalCoordinator((prompt) => {
  if (!sendGeneration(prompt.streamId, "chat:approval", prompt)) {
    throw new Error("The generation's renderer document is no longer active.");
  }
});
const SHUTDOWN_GENERATION_GRACE_MS = 5_000;

function resetGenerationAgent(agent: Agent, streamId: string): void {
  try {
    agent.reset();
  } catch (error) {
    logger.warn("pi", `Could not eagerly reset stream ${streamId}.`, error);
  }
}

/** Escape text interpolated into the XML-ish skill listing (skill files are untrusted input). */
function escapeSkillXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatAvailableSkills(
  configured: Skill[],
  discovered: DiscoveredSkill[],
): string | undefined {
  // Keyed by the same tool key buildAgentTools uses, so every listed skill
  // maps to an actual tool and collisions resolve the same way.
  const byTool = new Map<string, { name: string; description: string; tool: string; location: string }>();
  for (const skill of discovered) {
    byTool.set(skillToolKey(skill), {
      name: skill.name,
      description: skill.description,
      tool: skillToolKey(skill),
      location: skill.path,
    });
  }
  // Configured (enabled) skills take precedence over discovered skills with the same tool key.
  for (const skill of configured) {
    if (!skill.enabled) continue;
    byTool.set(skillToolKey(skill), {
      name: skill.name,
      description: skill.description,
      tool: skillToolKey(skill),
      location: "configured",
    });
  }

  const list = [...byTool.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0) return undefined;

  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "When a request matches a skill's description, call its skill tool to load the instructions.",
    "<available_skills>",
    ...list.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeSkillXml(skill.name)}</name>`,
      ...(skill.description ? [`    <description>${escapeSkillXml(skill.description)}</description>`] : []),
      `    <tool>${skill.tool}</tool>`,
      `    <location>${escapeSkillXml(skill.location)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

async function buildSystemPrompt(
  folderPath: string | undefined,
  branch: string | undefined,
  permission: GenerationPermission,
): Promise<string> {
  const base =
    "You are Pi, a capable AI assistant. Respond clearly and concisely, using Markdown for formatting and fenced code blocks for code.";
  const skillsText = formatAvailableSkills(
    await configStore.listSkills(),
    await discoverSkills(folderPath),
  );
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
    skillsSuffix
  );
}

async function prepareGeneration(
  streamId: string,
  params: ChatStartParams,
  signal: AbortSignal,
  computerUseGateSnapshot: number,
  activatedComputerUse: (controller: ComputerUseController) => void,
  options: GenerationExecutionOptions,
) {
  const runtime = await resolveModelRuntime(params.providerId, params.model, signal);
  const workspace = params.workspaceId
    ? await configStore.getWorkspace(params.workspaceId)
    : undefined;
  const permission: GenerationPermission = options.permission ?? workspace?.permission ?? "ask";
  const folderPath = workspace?.folderPath;
  const git = folderPath ? await gitInfo(folderPath) : { isRepo: false };
  // The resolved runtime model is the connection-bound capability authority.
  // Display metadata must not re-enable an input that Pi or discovery rejected.
  const model = runtime.model;
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
  const chat = settings.computerUseEnabled ? await chatStore.get(params.chatId) : null;
  let computerUse: ComputerUseController | undefined;
  if (
    options.allowComputerUse !== false &&
    settings.computerUseEnabled === true &&
    chat?.computerUseEnabled === true &&
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
  const tools = (
    await buildAgentTools({
      workspaceId: workspace?.id,
      workspaceRoot: folderPath,
      permission: toolPermission,
      computerUse,
      allowScheduling: !options.excludeToolNames?.has("schedule_task"),
      allowMcpTools: options.allowMcpTools,
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
    workspaceId: workspace?.id,
  };
}

export const llmClient = {
  async start(
    streamId: string,
    params: ChatStartParams,
    owner: ChatGenerationOwner,
    options: GenerationExecutionOptions = {},
  ): Promise<boolean> {
    if (chatComputerUseMutationGate.isChanging(params.chatId)) {
      throw new Error("Computer Use settings are changing for this chat. Try again in a moment.");
    }
    if (initializing.has(streamId) || active.has(streamId)) {
      throw new Error("A generation with this stream id is already running.");
    }
    if (this.isChatBusy(params.chatId)) {
      throw new Error("This chat already has a response in progress.");
    }
    const initialization = {
      chatId: params.chatId,
      owner,
      removeOwnerInvalidation: () => {},
      workspaceId: params.workspaceId,
      cancelRequested: false,
      controller: new AbortController(),
      computerUse: undefined as ComputerUseController | undefined,
    };
    const computerUseGateSnapshot = computerUseGenerationGate.snapshot();
    initializing.set(streamId, initialization);
    initialization.removeOwnerInvalidation = owner.onInvalidated(() => {
      this.cancel(streamId);
    });
    if (initialization.controller.signal.aborted) initialization.removeOwnerInvalidation();
    let setup: Awaited<ReturnType<typeof prepareGeneration>>;
    try {
      setup = await prepareGeneration(
        streamId,
        params,
        initialization.controller.signal,
        computerUseGateSnapshot,
        (computerUse) => {
          initialization.computerUse = computerUse;
        },
        options,
      );
    } catch (error) {
      if (initialization.cancelRequested || initialization.controller.signal.aborted) {
        sendGeneration(streamId, "chat:done", { streamId, content: "" });
        initializing.delete(streamId);
        initialization.removeOwnerInvalidation();
        return false;
      }
      initializing.delete(streamId);
      initialization.removeOwnerInvalidation();
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
      workspaceId,
    } = setup;
    initialization.computerUse = computerUse;
    const { model } = runtime;
    const exposeReasoning = shouldExposeReasoning(params.providerId);

    const deniedToolCalls = new Set<string>();
    const timeline = new GenerationTimelineProjector(streamId, (snapshot) => {
      sendGeneration(streamId, "chat:timeline", {
        streamId,
        timeline: snapshot,
      });
    });
    const generationCancelRequested = () =>
      initialization.cancelRequested || active.get(streamId)?.cancelRequested === true;
    const persistAssistant = async (
      content: string,
      reasoning: string,
      finalTimeline: ReturnType<GenerationTimelineProjector["snapshot"]>,
    ) => {
      if (!content.trim() && !reasoning.trim() && finalTimeline.steps.length === 0) {
        return { chat: undefined, error: undefined };
      }
      try {
        const chat = await chatStore.appendMessage(
          params.chatId,
          {
            role: "assistant",
            content,
            model: params.model,
            reasoning: reasoning.trim() ? reasoning : undefined,
            timeline: finalTimeline.steps.length ? finalTimeline : undefined,
          },
          { providerId: params.providerId, model: params.model },
        );
        return { chat, error: undefined };
      } catch (error) {
        logger.error("pi", `Could not persist response for stream ${streamId}`, error);
        return {
          chat: undefined,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };
    let full = "";
    let reasoning = "";
    let errored: string | null = null;
    let aborted = false;
    let currentAssistantTurnHadTextDelta = false;
    let currentAssistantTurnHadReasoningDelta = false;
    let candidate: Agent | null = null;
    try {
      const systemPrompt = await buildSystemPrompt(folderPath, git.branch, permission);
      assertGenerationContextCapacity({
        contextWindow: model.contextWindow,
        systemPrompt,
        tools,
      });
      candidate = new Agent({
        ...buildAgentRuntimeOptions(params.chatId, runtime),
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
        initialState: {
          systemPrompt,
          model,
          thinkingLevel,
          tools,
          messages: toPiMessages(params, model, supportsImages),
        },
        // Computer Use mutations always pause. Folder mutations pause in "ask" mode.
        beforeToolCall: async (context, signal) => {
          timeline.toolStarted(context.toolCall.id, context.toolCall.name, context.args);
          let summary: string;
          let computerUseApproval: ComputerUseApprovalDescriptor | undefined;
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
            const scheduleApproval =
              context.toolCall.name === SCHEDULE_TOOL_NAME &&
              scheduleToolRequiresApproval(context.args);
            const workspaceApproval =
              permission === "ask" && APPROVAL_TOOL_NAMES.has(context.toolCall.name);
            if (!scheduleApproval && !workspaceApproval) {
              timeline.toolRunning(context.toolCall.id);
              return undefined;
            }
            summary = scheduleApproval
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
              };
            })(),
            signal,
            owner.documentId,
          );
          if (!allowed && !signal?.aborted) deniedToolCalls.add(context.toolCall.id);
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
          return allowed ? undefined : { block: true, reason: "The user denied this action." };
        },
      });

      candidate.subscribe(async (event) => {
        switch (event.type) {
          case "message_start":
            if (event.message.role === "assistant") {
              currentAssistantTurnHadTextDelta = false;
              currentAssistantTurnHadReasoningDelta = false;
            }
            break;
          case "message_update": {
            const e = event.assistantMessageEvent;
            if (e.type === "text_delta") {
              full += e.delta;
              currentAssistantTurnHadTextDelta = true;
              sendGeneration(streamId, "chat:delta", {
                streamId,
                delta: e.delta,
              });
            } else if (e.type === "thinking_delta" && exposeReasoning) {
              const separator =
                !currentAssistantTurnHadReasoningDelta && reasoning.trim() ? "\n\n" : "";
              const delta = `${separator}${e.delta}`;
              reasoning += delta;
              currentAssistantTurnHadReasoningDelta = true;
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
            if (event.message.role === "assistant") {
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
            if (terminalGenerationWasAborted(event.message)) aborted = true;
            if (!terminalError) {
              // Pi may finish any assistant turn without preceding text_delta
              // events. Fall back per turn so a later tool-followup is retained
              // without duplicating normally streamed text.
              full += terminalAssistantTextFallback(
                event.message,
                currentAssistantTurnHadTextDelta,
              );
              if (exposeReasoning) {
                const fallback = terminalAssistantReasoningFallback(
                  event.message,
                  currentAssistantTurnHadReasoningDelta,
                );
                if (fallback) reasoning += `${reasoning.trim() ? "\n\n" : ""}${fallback}`;
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
            const denied = deniedToolCalls.delete(event.toolCallId);
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
      await computerUse?.close().catch(() => {});
      if (initialization.cancelRequested || initialization.controller.signal.aborted) {
        sendGeneration(streamId, "chat:done", { streamId, content: "" });
        initializing.delete(streamId);
        initialization.removeOwnerInvalidation();
        return false;
      }
      initializing.delete(streamId);
      initialization.removeOwnerInvalidation();
      throw error;
    }
    const agent = candidate;
    if (!agent) {
      initializing.delete(streamId);
      initialization.removeOwnerInvalidation();
      throw new Error("Could not initialize the generation agent.");
    }

    const activeGeneration: ActiveGeneration = {
      agent,
      chatId: params.chatId,
      owner,
      removeOwnerInvalidation: initialization.removeOwnerInvalidation,
      workspaceId: params.workspaceId,
      cancelRequested: false,
      computerUse,
      completion: null,
    };
    // Publish the active owner before removing initialization so cancellation
    // cannot fall into a map-transition gap and leave a privileged run alive.
    active.set(streamId, activeGeneration);
    initializing.delete(streamId);
    if (initialization.cancelRequested || activeGeneration.cancelRequested) {
      resetGenerationAgent(agent, streamId);
      await computerUse?.close().catch(() => {});
      sendGeneration(streamId, "chat:done", { streamId, content: "" });
      active.delete(streamId);
      activeGeneration.removeOwnerInvalidation();
      return false;
    }

    const completion = (async () => {
      try {
        await agent.continue();
        const wasCancelled = activeGeneration.cancelRequested;
        const finalError = wasCancelled
          ? null
          : (terminalGenerationInterruptionError(aborted, wasCancelled) ??
            errored ??
            agent.state.errorMessage?.trim() ??
            null);
        if (finalError) {
          const finalTimeline = attachClaimCheck(timeline.finish("failed"), full);
          const persisted = await persistAssistant(full, reasoning, finalTimeline);
          sendGeneration(streamId, "chat:error", {
            streamId,
            message: persisted.error
              ? `${finalError} The partial response could not be saved: ${persisted.error}`
              : finalError,
            content: full || undefined,
            reasoning: reasoning || undefined,
            timeline: finalTimeline,
            chat: persisted.chat,
          });
        } else if (!full.trim() && !wasCancelled) {
          const finalTimeline = attachClaimCheck(timeline.finish("failed"), full);
          const persisted = await persistAssistant(full, reasoning, finalTimeline);
          sendGeneration(streamId, "chat:error", {
            streamId,
            message: persisted.error
              ? `The model returned an empty response, and its steps could not be saved: ${persisted.error}`
              : "The model returned an empty response. Try again.",
            reasoning: reasoning || undefined,
            timeline: finalTimeline,
            chat: persisted.chat,
          });
        } else {
          // Covers both normal completion and user abort (partial `full`).
          const finalTimeline = attachClaimCheck(
            timeline.finish(wasCancelled ? "cancelled" : "completed"),
            full,
          );
          const persisted = await persistAssistant(full, reasoning, finalTimeline);
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
              chat: persisted.chat,
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("pi", `Generation failed for stream ${streamId}`, error);
        const finalTimeline = attachClaimCheck(timeline.finish("failed"), full);
        const persisted = await persistAssistant(full, reasoning, finalTimeline);
        sendGeneration(streamId, "chat:error", {
          streamId,
          message: persisted.error
            ? `${message} The partial response could not be saved: ${persisted.error}`
            : message,
          content: full || undefined,
          reasoning: reasoning || undefined,
          timeline: finalTimeline,
          chat: persisted.chat,
        });
      } finally {
        try {
          resetGenerationAgent(agent, streamId);
          await computerUse?.close().catch(() => {});
        } finally {
          active.delete(streamId);
          activeGeneration.removeOwnerInvalidation();
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

  cancel(streamId: string, ownerDocumentId?: string): boolean {
    const initialization = initializing.get(streamId);
    const generation = active.get(streamId);
    const owner = initialization?.owner ?? generation?.owner;
    if (!owner || (ownerDocumentId !== undefined && owner.documentId !== ownerDocumentId)) {
      return false;
    }
    if (initialization) {
      initialization.cancelRequested = true;
      initialization.controller.abort(new Error("Chat initialization cancelled."));
      void initialization.computerUse?.close();
    }
    if (generation) {
      generation.cancelRequested = true;
      generation.agent.abort();
      void generation.computerUse?.close();
    }
    approvals.cancelStream(streamId);
    return true;
  },

  isChatBusy(chatId: string): boolean {
    return (
      [...initializing.values()].some((entry) => entry.chatId === chatId) ||
      [...active.values()].some((entry) => entry.chatId === chatId)
    );
  },

  beginComputerUseSettingChange(chatId: string): (() => void) | null {
    return chatComputerUseMutationGate.tryBegin(chatId, this.isChatBusy(chatId));
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

  /** Stop generations whose tool set was snapshotted from this workspace. */
  cancelWorkspace(workspaceId: string): void {
    for (const initialization of initializing.values()) {
      if (initialization.workspaceId === workspaceId) {
        initialization.cancelRequested = true;
        initialization.controller.abort(new Error("Workspace generation cancelled."));
        void initialization.computerUse?.close();
      }
    }
    for (const entry of active.values()) {
      if (entry.workspaceId === workspaceId) {
        entry.cancelRequested = true;
        entry.agent.abort();
        void entry.computerUse?.close();
      }
    }
    void geminiContextCache.invalidateWorkspace(workspaceId);
  },

  abortAll(): void {
    for (const [streamId] of initializing) this.cancel(streamId);
    for (const [streamId] of active) this.cancel(streamId);
    approvals.shutdown();
  },

  async shutdown(): Promise<void> {
    this.abortAll();
    const generations = [...active.values()];
    await settleGenerationCleanup(
      generations.map((entry) => ({
        reset: () => entry.agent.reset(),
        close: entry.computerUse ? () => entry.computerUse!.close() : undefined,
        completion: entry.completion,
      })),
      SHUTDOWN_GENERATION_GRACE_MS,
      (error) => logger.warn("pi", "Could not clear one generation during shutdown.", error),
    );
    await geminiContextCache.shutdown();
  },
};
