// Chat generation via pi's embedded agent loop (@earendil-works/pi-agent-core +
// pi-ai). A fresh Agent runs per generation: it owns multi-step tool calling
// (folder-scoped coding tools, Exa search, Agent Skills, MCP servers) and
// streams assistant text. Text deltas and tool activity are pushed to the
// renderer as broadcasts.
//
// Workspaces bind a folder + a permission level. In "ask" mode the agent pauses
// before any mutating tool (write/edit/run_command) via pi's `beforeToolCall`
// hook and waits for the user to Allow or Deny in the UI.

import { Agent } from "@earendil-works/pi-agent-core";
import { ipcMain, logger } from "../platform.js";
import { buildAgentTools } from "./tools.js";
import { APPROVAL_TOOL_NAMES, summarizeToolCall } from "./coding-tools.js";
import { gitInfo } from "./git.js";
import { providerModelInfo } from "./provider-model-info.js";
import { configStore } from "./config-store.js";
import {
  buildAgentRuntimeOptions,
  effectiveModelForGeneration,
  settleGenerationCleanup,
  terminalAssistantTextFallback,
  terminalGenerationError,
  terminalGenerationInterruptionError,
  terminalGenerationWasAborted,
} from "./generation-runtime.js";
import { resolveModelRuntime } from "./model-runtime.js";
import { assistantUsageRecord } from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";
import type { ApprovalDecision, ChatStartParams, WorkspacePermission } from "./types.js";
import type {
  ComputerUseApprovalDescriptor,
  ComputerUseController,
} from "./computer-use/controller.js";
import type { ComputerUseArgs } from "./computer-use/schema.js";
import { COMPUTER_USE_TOOL_NAME } from "./computer-use/tool.js";
import { ToolApprovalCoordinator } from "./tool-approval.js";
import { toPiMessages } from "./generation-messages.js";

interface ActiveGeneration {
  agent: Agent;
  workspaceId?: string;
  cancelRequested: boolean;
  computerUse?: ComputerUseController;
  completion: Promise<void> | null;
}

const active = new Map<string, ActiveGeneration>();
const initializing = new Map<
  string,
  {
    workspaceId?: string;
    cancelRequested: boolean;
    controller: AbortController;
    computerUse?: ComputerUseController;
  }
>();
const approvals = new ToolApprovalCoordinator((prompt) => {
  ipcMain.broadcast("chat:approval", prompt);
});
const SHUTDOWN_GENERATION_GRACE_MS = 5_000;

function disabledComputerUseController(): ComputerUseController | undefined {
  return undefined;
}

function resetGenerationAgent(agent: Agent, streamId: string): void {
  try {
    agent.reset();
  } catch (error) {
    logger.warn("pi", `Could not eagerly reset stream ${streamId}.`, error);
  }
}

function buildSystemPrompt(
  folderPath: string | undefined,
  branch: string | undefined,
  permission: WorkspacePermission,
): string {
  const base =
    "You are Pi, a capable AI assistant. Respond clearly and concisely, using Markdown for formatting and fenced code blocks for code.";
  if (!folderPath || permission === "none") {
    return `${base} Call the available tools when they help answer the user's request.`;
  }
  const git = branch ? ` It is a git repository on branch \`${branch}\`.` : "";
  return (
    `${base}\n\n` +
    `You are working inside the folder: ${folderPath}.${git} ` +
    "You have tools to read, search, list, and edit files and to run shell commands in this folder. " +
    "All file paths are relative to this folder. Prefer editing existing files over creating new ones, " +
    "read a file before editing it, and keep changes surgical. " +
    (permission === "ask"
      ? "The user must approve each file write and shell command before it runs."
      : "You may make changes and run commands directly.")
  );
}

async function prepareGeneration(_streamId: string, params: ChatStartParams, signal: AbortSignal) {
  const runtime = await resolveModelRuntime(params.providerId, params.model, signal);
  const workspace = params.workspaceId
    ? await configStore.getWorkspace(params.workspaceId)
    : undefined;
  const permission: WorkspacePermission = workspace?.permission ?? "ask";
  const folderPath = workspace?.folderPath;
  const git = folderPath ? await gitInfo(folderPath) : { isRepo: false };
  // Capability metadata is local: Pi owns Codex facts and the release snapshot
  // owns legacy-provider facts, so chat startup never waits on a public catalog.
  const modelInfo = await providerModelInfo.info(runtime.provider.id, params.model);
  const model = effectiveModelForGeneration(runtime.model, modelInfo.vision);
  const supportsImages = model.input.includes("image");
  // Phase 3 supplies a generation-owned controller only after the persisted
  // beta setting and permission/status UX are present. Keeping this undefined
  // makes Phase 2's adapter unreachable from production while fully testable.
  const computerUse = disabledComputerUseController();
  const tools = await buildAgentTools({ workspaceRoot: folderPath, permission, computerUse });
  return {
    runtime: { ...runtime, model },
    permission,
    folderPath,
    git,
    tools,
    supportsImages,
    computerUse,
  };
}

export const llmClient = {
  async start(streamId: string, params: ChatStartParams): Promise<boolean> {
    if (initializing.has(streamId) || active.has(streamId)) {
      throw new Error("A generation with this stream id is already running.");
    }
    const initialization = {
      workspaceId: params.workspaceId,
      cancelRequested: false,
      controller: new AbortController(),
      computerUse: undefined as ComputerUseController | undefined,
    };
    initializing.set(streamId, initialization);
    let setup: Awaited<ReturnType<typeof prepareGeneration>>;
    try {
      setup = await prepareGeneration(streamId, params, initialization.controller.signal);
    } catch (error) {
      initializing.delete(streamId);
      if (initialization.cancelRequested || initialization.controller.signal.aborted) {
        ipcMain.broadcast("chat:done", { streamId, content: "" });
        return false;
      }
      throw error;
    }
    const { runtime, permission, folderPath, git, tools, supportsImages, computerUse } = setup;
    initialization.computerUse = computerUse;
    const { model } = runtime;

    const deniedToolCalls = new Set<string>();
    let full = "";
    let errored: string | null = null;
    let aborted = false;
    let currentAssistantTurnHadTextDelta = false;
    let candidate: Agent | null = null;
    try {
      candidate = new Agent({
        ...buildAgentRuntimeOptions(params.chatId, runtime),
        initialState: {
          systemPrompt: buildSystemPrompt(folderPath, git.branch, permission),
          model,
          tools,
          messages: toPiMessages(params, model, supportsImages),
        },
        // Computer Use mutations always pause. Folder mutations pause in "ask" mode.
        beforeToolCall: async (context, signal) => {
          let summary: string;
          let computerUseApproval: ComputerUseApprovalDescriptor | undefined;
          if (context.toolCall.name === COMPUTER_USE_TOOL_NAME) {
            if (!computerUse) {
              deniedToolCalls.add(context.toolCall.id);
              return { block: true, reason: "Computer Use is not enabled for this response." };
            }
            try {
              const descriptor = await computerUse.approvalFor(
                context.args as ComputerUseArgs,
                signal,
              );
              if (!descriptor) return undefined;
              computerUseApproval = descriptor;
              summary = descriptor.summary;
            } catch (error) {
              deniedToolCalls.add(context.toolCall.id);
              return {
                block: true,
                reason:
                  error instanceof Error ? error.message : "Computer Use rejected this action.",
              };
            }
          } else {
            if (permission !== "ask" || !APPROVAL_TOOL_NAMES.has(context.toolCall.name))
              return undefined;
            summary = summarizeToolCall(context.toolCall.name, context.args);
          }
          const allowed = await approvals.request(
            { streamId, toolName: context.toolCall.name, summary },
            signal,
          );
          if (!allowed && !signal?.aborted) deniedToolCalls.add(context.toolCall.id);
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
            if (event.message.role === "assistant") currentAssistantTurnHadTextDelta = false;
            break;
          case "message_update": {
            const e = event.assistantMessageEvent;
            if (e.type === "text_delta") {
              full += e.delta;
              currentAssistantTurnHadTextDelta = true;
              ipcMain.broadcast("chat:delta", { streamId, delta: e.delta });
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
                  source: "chat",
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
            }
            break;
          }
          case "tool_execution_start":
            ipcMain.broadcast("chat:tool", { streamId, phase: "call", toolName: event.toolName });
            break;
          case "tool_execution_end": {
            const denied = deniedToolCalls.delete(event.toolCallId);
            ipcMain.broadcast("chat:tool", {
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
      initializing.delete(streamId);
      if (candidate) resetGenerationAgent(candidate, streamId);
      await computerUse?.close().catch(() => {});
      if (initialization.cancelRequested || initialization.controller.signal.aborted) {
        ipcMain.broadcast("chat:done", { streamId, content: "" });
        return false;
      }
      throw error;
    }
    const agent = candidate;
    if (!agent) throw new Error("Could not initialize the generation agent.");

    const activeGeneration: ActiveGeneration = {
      agent,
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
      active.delete(streamId);
      resetGenerationAgent(agent, streamId);
      await computerUse?.close().catch(() => {});
      ipcMain.broadcast("chat:done", { streamId, content: "" });
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
          ipcMain.broadcast("chat:error", {
            streamId,
            message: finalError,
            content: full || undefined,
          });
        } else if (!full.trim() && !wasCancelled) {
          ipcMain.broadcast("chat:error", {
            streamId,
            message: "The model returned an empty response. Try again.",
          });
        } else {
          // Covers both normal completion and user abort (partial `full`).
          ipcMain.broadcast("chat:done", { streamId, content: full });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("pi", `Generation failed for stream ${streamId}`, error);
        ipcMain.broadcast("chat:error", { streamId, message, content: full || undefined });
      } finally {
        try {
          resetGenerationAgent(agent, streamId);
          await computerUse?.close().catch(() => {});
        } finally {
          active.delete(streamId);
        }
      }
    })();
    activeGeneration.completion = completion;
    void completion;
    return true;
  },

  /** Resolve a pending tool-approval request from the UI. */
  approve(approvalId: string, decision: ApprovalDecision): void {
    approvals.decide(approvalId, decision === "allow");
  },

  cancel(streamId: string): void {
    const initialization = initializing.get(streamId);
    if (initialization) {
      initialization.cancelRequested = true;
      initialization.controller.abort(new Error("Chat initialization cancelled."));
      void initialization.computerUse?.close();
    }
    const generation = active.get(streamId);
    if (generation) {
      generation.cancelRequested = true;
      generation.agent.abort();
      void generation.computerUse?.close();
    }
    approvals.cancelStream(streamId);
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
  },
};
