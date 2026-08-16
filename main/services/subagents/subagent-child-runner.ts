import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { performance } from "node:perf_hooks";
import {
  terminalAssistantText,
  terminalGenerationError,
  terminalGenerationLengthError,
  terminalGenerationWasAborted,
} from "../generation-runtime.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import { piRuntimePrivateFailure } from "../pi-runtime-failure.js";
import type { WorkspacePermission } from "../types.js";
import {
  MAX_SUBAGENT_SUMMARY_CHARS,
  parseSubagentToolRequest,
  type SubagentTaskRequest,
  type SubagentTaskResult,
} from "./contracts.js";
import { subagentRoleSystemPrompt, subagentTaskPrompt } from "./role-catalog.js";
import {
  subagentRuntimeRegistry,
  type SubagentRuntimeAuthority,
  type SubagentRuntimeChild,
} from "./child-agent-runtime.js";
import type { SubagentReadToolName } from "./capability-profile.js";
import {
  captureLiveSubagentContext,
  type SubagentContextCapture,
  type SubagentContextMode,
} from "./forked-context.js";
import { sanitizeSubagentText } from "./safe-text.js";
import type { SubagentAuthorityV2 } from "./authority-v2.js";
import { createSubagentTool } from "./subagent-tool.js";
import type { SubagentSupervisor } from "./subagent-supervisor.js";
import {
  projectRequestableSubagentMcpInventoryV2,
  projectRequestableSubagentMcpMutationInventoryV2,
} from "./request-capabilities-v2.js";
import type { SubagentOutboundToolBindingV2 } from "./outbound-approval-v2.js";
import type { SubagentOutboundApprovalGateV2 } from "./outbound-approval-v2.js";
import type {
  SubagentWorkspaceWriteApprovalGateV2,
  SubagentWorkspaceWriteToolBindingV2,
} from "./subagent-workspace-write.js";
import type {
  SubagentMcpMutationBindingV2,
  SubagentMcpMutationGateV2,
} from "./subagent-mcp-mutation.js";
import type { SubagentShellGateV2, SubagentShellToolBindingV2 } from "./subagent-shell.js";

export const DEFAULT_SUBAGENT_CHILD_DEADLINE_MS = 10 * 60_000;
export const DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS = 5_000;
export const MAX_SUBAGENT_CHILD_TURNS = 24;
export const MAX_SUBAGENT_CHILD_TOOL_CALLS = 64;
export const MAX_SUBAGENT_CHILD_EVENTS = 512;
export const MAX_SUBAGENT_CHILD_OUTPUT_CHARS = 120_000;
export const MAX_SUBAGENT_CHILD_PROTOCOL_CHARS = 512_000;
const SAFE_CHILD_PROVIDER_FAILURE = "The child model could not complete this task.";

export interface SubagentChildRunnerPolicy {
  deadlineMs?: number;
  cancellationGraceMs?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  maxEvents?: number;
  maxOutputChars?: number;
  maxProtocolChars?: number;
}

export interface SubagentChildRunnerDependencies {
  createChild?: (input: {
    authority: SubagentRuntimeAuthority;
    runId?: string;
    groupId: string;
    childId?: string;
    runtime: ResolvedModelRuntime;
    thinkingLevel: ThinkingLevel;
    systemPrompt: string;
    tools: AgentTool[];
    initialMessages: AgentMessage[];
    beforeToolCall?: (
      context: BeforeToolCallContext,
      signal?: AbortSignal,
    ) => Promise<BeforeToolCallResult | undefined>;
    onStarting?: () => void;
  }) => SubagentRuntimeChild;
  buildTools?: (input: {
    workspaceRoot: string;
    permission: WorkspacePermission;
    role: string;
    inheritedCeiling: readonly SubagentReadToolName[];
    authority?: SubagentAuthorityV2;
    currentAuthority?: () => SubagentAuthorityV2 | undefined;
    consumeNetworkOperation?: (authority: SubagentAuthorityV2) => boolean;
    signal?: AbortSignal;
  }) => Promise<AgentTool[] | SubagentChildToolAssembly>;
  recordUsage?: (message: AssistantMessage, runtime: ResolvedModelRuntime) => Promise<void>;
}

export interface SubagentChildToolAssembly {
  tools: AgentTool[];
  outboundApprovalBindings: SubagentOutboundToolBindingV2[];
  workspaceWriteApprovalBindings: SubagentWorkspaceWriteToolBindingV2[];
  mcpMutationApprovalBindings: SubagentMcpMutationBindingV2[];
  shellApprovalBindings: SubagentShellToolBindingV2[];
}

export interface RunSubagentChildInput {
  authority: SubagentRuntimeAuthority;
  runId?: string;
  childId?: string;
  groupId: string;
  runtime: ResolvedModelRuntime;
  thinkingLevel: ThinkingLevel;
  workspaceRoot: string;
  permission: WorkspacePermission;
  inheritedCeiling: readonly SubagentReadToolName[];
  /** Exact private V2 ceiling; absent only on the V1 rollback path. */
  v2Authority?: SubagentAuthorityV2;
  currentV2Authority?: () => SubagentAuthorityV2 | undefined;
  consumeNetworkOperation?: (authority: SubagentAuthorityV2) => boolean;
  prepareOutboundApproval?: (
    bindings: readonly SubagentOutboundToolBindingV2[],
  ) => SubagentOutboundApprovalGateV2;
  prepareWorkspaceWriteApproval?: (
    bindings: readonly SubagentWorkspaceWriteToolBindingV2[],
    runSignal?: AbortSignal,
  ) => SubagentWorkspaceWriteApprovalGateV2;
  prepareMcpMutationApproval?: (
    bindings: readonly SubagentMcpMutationBindingV2[],
    runSignal?: AbortSignal,
  ) => SubagentMcpMutationGateV2;
  prepareShellApproval?: (
    bindings: readonly SubagentShellToolBindingV2[],
    runSignal?: AbortSignal,
  ) => SubagentShellGateV2;
  /** Main-owned depth-2 execution seam. Absent for V1, depth-2, rollback, or denied authority. */
  executeNested?: (
    params: unknown,
    signal?: AbortSignal,
    forkContext?: SubagentContextCapture,
  ) => Promise<string>;
  /** Private context binding and a transcript allocated only for this child. */
  context: {
    mode: SubagentContextMode;
    revisionHash: string;
    messages: AgentMessage[];
  };
  request: SubagentTaskRequest;
  signal?: AbortSignal;
  /** Reports a bounded cancellation/teardown deadline miss without runtime context. */
  onCleanupFailure?: () => void;
  now?: () => number;
  policy?: SubagentChildRunnerPolicy;
  dependencies?: SubagentChildRunnerDependencies;
  telemetry?: {
    starting(): void;
    running(): void;
    turnStarted(): void;
    toolStarted(toolName: string): void;
    textDelta(delta: string): void;
    /** Exact terminal text not already observed through text deltas. */
    textReconciled(additionalChars: number): void;
    /** Hidden thinking/tool-call protocol charged to the shared tree ceiling. */
    protocolDelta?(additionalChars: number): void;
    protocolReconciled?(additionalChars: number): void;
    usage(message: AssistantMessage): void;
  };
}

function truncateSummary(text: string): string {
  text = sanitizeSubagentText(text);
  if (text.length <= MAX_SUBAGENT_SUMMARY_CHARS) return text;
  const marker = "\n\n… [middle of child summary truncated] …\n\n";
  const available = MAX_SUBAGENT_SUMMARY_CHARS - marker.length;
  const head = Math.min(2_000, Math.floor(available / 2));
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

function safeFailure(
  request: SubagentTaskRequest,
  warning = "The child could not complete this task.",
): SubagentTaskResult {
  return {
    role: request.role,
    label: request.label,
    status: "failed",
    summary: "",
    warning,
  };
}

function assistantProtocolChars(message: AssistantMessage): number {
  let total = 0;
  for (const block of message.content) {
    if (block.type === "text") total += block.text.length;
    else if (block.type === "thinking") total += block.thinking.length;
    else {
      total += block.id.length + block.name.length;
      try {
        total += JSON.stringify(block.arguments).length;
      } catch {
        return Number.MAX_SAFE_INTEGER;
      }
    }
    if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

function assistantHiddenProtocolChars(message: AssistantMessage): number {
  let total = 0;
  for (const block of message.content) {
    if (block.type === "text") continue;
    if (block.type === "thinking") total += block.thinking.length;
    else {
      total += block.id.length + block.name.length;
      try {
        total += JSON.stringify(block.arguments).length;
      } catch {
        return Number.MAX_SAFE_INTEGER;
      }
    }
    if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER;
  }
  return total;
}

function throwIfParentAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Parent generation cancelled.");
}

function timedOutResult(request: SubagentTaskRequest): SubagentTaskResult {
  return {
    role: request.role,
    label: request.label,
    status: "timed_out",
    // A deadline can split a credential or path at any character. Never
    // promote accumulated stream fragments into renderer-visible terminal
    // state when the child did not complete.
    summary: "",
    warning: "The child reached its deadline.",
  };
}

async function boundedDrain(promise: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function reportCleanupFailure(input: RunSubagentChildInput): void {
  try {
    input.onCleanupFailure?.();
  } catch {
    // Aggregate health evidence cannot affect cancellation settlement.
  }
}

function assistantMessage(event: AgentEvent): AssistantMessage | null {
  if (
    (event.type === "message_end" || event.type === "turn_end") &&
    event.message.role === "assistant"
  ) {
    return event.message as AssistantMessage;
  }
  return null;
}

export async function runSubagentChild(input: RunSubagentChildInput): Promise<SubagentTaskResult> {
  throwIfParentAborted(input.signal);
  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  const policy = {
    deadlineMs: input.policy?.deadlineMs ?? DEFAULT_SUBAGENT_CHILD_DEADLINE_MS,
    cancellationGraceMs:
      input.policy?.cancellationGraceMs ?? DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS,
    maxTurns: input.policy?.maxTurns ?? MAX_SUBAGENT_CHILD_TURNS,
    maxToolCalls: input.policy?.maxToolCalls ?? MAX_SUBAGENT_CHILD_TOOL_CALLS,
    maxEvents: input.policy?.maxEvents ?? MAX_SUBAGENT_CHILD_EVENTS,
    maxOutputChars: input.policy?.maxOutputChars ?? MAX_SUBAGENT_CHILD_OUTPUT_CHARS,
    maxProtocolChars: input.policy?.maxProtocolChars ?? MAX_SUBAGENT_CHILD_PROTOCOL_CHARS,
  };
  if (
    !Number.isFinite(policy.deadlineMs) ||
    policy.deadlineMs <= 0 ||
    !Number.isFinite(policy.cancellationGraceMs) ||
    policy.cancellationGraceMs < 0 ||
    policy.cancellationGraceMs > 30_000 ||
    !Number.isInteger(policy.maxTurns) ||
    policy.maxTurns <= 0 ||
    !Number.isInteger(policy.maxToolCalls) ||
    policy.maxToolCalls <= 0 ||
    !Number.isInteger(policy.maxEvents) ||
    policy.maxEvents <= 0 ||
    !Number.isInteger(policy.maxOutputChars) ||
    policy.maxOutputChars <= 0 ||
    !Number.isInteger(policy.maxProtocolChars) ||
    policy.maxProtocolChars <= 0
  ) {
    throw new Error("Invalid subagent child resource policy.");
  }
  if (!Number.isFinite(startedAt)) {
    throw new Error("Invalid subagent child clock.");
  }
  const deadlineAt = startedAt + policy.deadlineMs;
  if (!Number.isFinite(deadlineAt)) {
    throw new Error("Invalid subagent child deadline.");
  }

  const buildTools = input.dependencies?.buildTools;
  if (!buildTools) throw new Error("Subagent child tool construction is unavailable.");
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const constructionCancellation = new AbortController();
  const constructionSignal = input.signal
    ? AbortSignal.any([input.signal, constructionCancellation.signal])
    : constructionCancellation.signal;
  let removeParentAbort = () => {};
  let unsubscribe = () => {};
  let workspaceWriteApproval: SubagentWorkspaceWriteApprovalGateV2 | undefined;
  let mcpMutationApproval: SubagentMcpMutationGateV2 | undefined;
  let shellApproval: SubagentShellGateV2 | undefined;
  const deadline = new Promise<{ kind: "timed_out" }>((resolve) => {
    deadlineTimer = setTimeout(
      () => {
        constructionCancellation.abort(new Error("Subagent child construction deadline exceeded."));
        resolve({ kind: "timed_out" });
      },
      Math.max(0, deadlineAt - now()),
    );
  });
  const parentAbort = new Promise<{ kind: "parent_aborted" }>((resolve) => {
    if (!input.signal) return;
    const abort = () => {
      constructionCancellation.abort(
        input.signal?.reason ?? new Error("Parent generation cancelled."),
      );
      resolve({ kind: "parent_aborted" });
    };
    if (input.signal.aborted) abort();
    else {
      input.signal.addEventListener("abort", abort, { once: true });
      removeParentAbort = () => input.signal?.removeEventListener("abort", abort);
    }
  });
  const deadlineElapsed = () => {
    const current = now();
    return !Number.isFinite(current) || current >= deadlineAt;
  };

  try {
    const toolConstruction = Promise.resolve()
      .then(() =>
        buildTools({
          workspaceRoot: input.workspaceRoot,
          permission: input.permission,
          role: input.request.role,
          inheritedCeiling: input.inheritedCeiling,
          authority: input.v2Authority,
          currentAuthority: input.currentV2Authority,
          consumeNetworkOperation: input.consumeNetworkOperation,
          signal: constructionSignal,
        }),
      )
      .then(
        (tools) => ({ kind: "tools" as const, tools }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
    const constructionOutcome = await Promise.race([toolConstruction, deadline, parentAbort]);
    if (constructionOutcome.kind === "parent_aborted") {
      if (!(await boundedDrain(toolConstruction, policy.cancellationGraceMs))) {
        reportCleanupFailure(input);
      }
      throwIfParentAborted(input.signal);
      throw new Error("Parent generation cancelled.");
    }
    if (constructionOutcome.kind === "timed_out" || deadlineElapsed()) {
      if (
        constructionOutcome.kind === "timed_out" &&
        !(await boundedDrain(toolConstruction, policy.cancellationGraceMs))
      ) {
        reportCleanupFailure(input);
      }
      return timedOutResult(input.request);
    }
    if (constructionOutcome.kind === "failed") throw constructionOutcome.error;

    throwIfParentAborted(input.signal);
    const createChild =
      input.dependencies?.createChild ?? ((spec) => subagentRuntimeRegistry.create(spec));
    const assembly = Array.isArray(constructionOutcome.tools)
      ? {
          tools: constructionOutcome.tools,
          outboundApprovalBindings: [],
          workspaceWriteApprovalBindings: [],
          mcpMutationApprovalBindings: [],
          shellApprovalBindings: [],
        }
      : constructionOutcome.tools;
    const outboundApproval =
      assembly.outboundApprovalBindings.length > 0
        ? input.prepareOutboundApproval?.(assembly.outboundApprovalBindings)
        : undefined;
    if (assembly.outboundApprovalBindings.length > 0 && !outboundApproval) {
      throw new Error("Subagent outbound approval is unavailable.");
    }
    workspaceWriteApproval =
      assembly.workspaceWriteApprovalBindings.length > 0
        ? input.prepareWorkspaceWriteApproval?.(
            assembly.workspaceWriteApprovalBindings,
            input.signal,
          )
        : undefined;
    if (assembly.workspaceWriteApprovalBindings.length > 0 && !workspaceWriteApproval) {
      throw new Error("Subagent workspace-write approval is unavailable.");
    }
    mcpMutationApproval =
      assembly.mcpMutationApprovalBindings.length > 0
        ? input.prepareMcpMutationApproval?.(assembly.mcpMutationApprovalBindings, input.signal)
        : undefined;
    if (assembly.mcpMutationApprovalBindings.length > 0 && !mcpMutationApproval) {
      throw new Error("Subagent MCP mutation approval is unavailable.");
    }
    shellApproval =
      assembly.shellApprovalBindings.length > 0
        ? input.prepareShellApproval?.(assembly.shellApprovalBindings, input.signal)
        : undefined;
    if (assembly.shellApprovalBindings.length > 0 && !shellApproval) {
      throw new Error("Subagent shell approval is unavailable.");
    }
    const outboundToolNames = new Set(
      assembly.outboundApprovalBindings.map(({ toolName }) => toolName),
    );
    const workspaceWriteToolNames = new Set<string>(
      assembly.workspaceWriteApprovalBindings.map(({ toolName }) => toolName),
    );
    const mutationToolNames = new Set(
      assembly.mcpMutationApprovalBindings.map(({ childAgentToolName }) => childAgentToolName),
    );
    const shellToolNames = new Set<string>(
      assembly.shellApprovalBindings.map(({ toolName }) => toolName),
    );
    if (
      [...workspaceWriteToolNames].some(
        (toolName) => outboundToolNames.has(toolName) || mutationToolNames.has(toolName),
      ) ||
      [...mutationToolNames].some((toolName) => outboundToolNames.has(toolName))
    ) {
      throw new Error("Subagent approval tool bindings overlap.");
    }
    const childTools = assembly.tools.map((tool) => {
      if (workspaceWriteToolNames.has(tool.name) && workspaceWriteApproval) {
        return {
          ...tool,
          execute: (toolCallId: string, args: unknown, signal?: AbortSignal) =>
            workspaceWriteApproval!.execute({
              toolCallId,
              toolName: tool.name,
              arguments: args,
              signal,
            }),
        };
      }
      if (mutationToolNames.has(tool.name) && mcpMutationApproval) {
        return {
          ...tool,
          execute: (toolCallId: string, args: unknown, signal?: AbortSignal) =>
            mcpMutationApproval!.execute({
              toolCallId,
              toolName: tool.name,
              arguments: args,
              signal,
            }),
        };
      }
      if (shellToolNames.has(tool.name) && shellApproval) {
        return {
          ...tool,
          execute: (toolCallId: string, args: unknown, signal?: AbortSignal) =>
            shellApproval!.execute({
              toolCallId,
              toolName: "run_command",
              arguments: args,
              signal,
            }),
        };
      }
      if (!outboundToolNames.has(tool.name) || !outboundApproval) return tool;
      const execute = tool.execute.bind(tool);
      return {
        ...tool,
        execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => {
          outboundApproval.consume({
            toolCallId,
            toolName: tool.name,
            arguments: args,
          });
          return execute(toolCallId, args, signal);
        },
      };
    });
    let child: SubagentRuntimeChild | undefined;
    if (input.executeNested) {
      const authority = input.v2Authority;
      if (
        !authority ||
        authority.depth !== 1 ||
        authority.execution !== "foreground" ||
        authority.capabilities.delegation !== true
      ) {
        throw new Error("Nested delegation authority is unavailable.");
      }
      childTools.push(
        createSubagentTool(
          {
            execute: (params: unknown, signal?: AbortSignal) => {
              const request = parseSubagentToolRequest(params);
              const yieldInference = child?.withoutInferenceLease;
              if (!yieldInference) {
                throw new Error("Nested delegation cannot release parent inference capacity.");
              }
              const forkContext =
                request.context === "fork"
                  ? captureLiveSubagentContext({
                      chatId: input.authority.chatId,
                      parentRunId: authority.runId,
                      // This is the sole live-state read. Capture completes
                      // synchronously before the inference lease is yielded.
                      messages: child!.agent.state.messages,
                      descendantContextWindow: input.runtime.model.contextWindow ?? 1_000_000,
                    })
                  : undefined;
              return yieldInference(() => input.executeNested!(params, signal, forkContext));
            },
          } as SubagentSupervisor,
          projectRequestableSubagentMcpInventoryV2(authority.capabilities.mcp),
          authority.capabilities.workspaceWrite,
          projectRequestableSubagentMcpMutationInventoryV2(authority.capabilities.mcp),
          authority.capabilities.shell,
          false,
        ),
      );
    }
    child = createChild({
      authority: input.authority,
      runId: input.runId ?? input.childId ?? input.groupId,
      groupId: input.groupId,
      childId: input.childId,
      runtime: input.runtime,
      thinkingLevel: input.thinkingLevel,
      systemPrompt: subagentRoleSystemPrompt(input.request.role, {
        contextMode: input.context.mode,
        workspaceRead:
          input.v2Authority?.capabilities.workspaceRead ??
          (input.permission !== "none" && input.inheritedCeiling.length > 0),
        workspaceWrite: input.v2Authority?.capabilities.workspaceWrite === true,
        shell: input.v2Authority?.capabilities.shell === true,
        mcpRead:
          input.v2Authority?.capabilities.mcp.some((scope) =>
            scope.tools.some((tool) => tool.effect === "read"),
          ) === true,
        mcpMutation:
          input.v2Authority?.capabilities.mcp.some((scope) =>
            scope.tools.some((tool) => tool.effect === "mutating"),
          ) === true,
        delegation: input.executeNested !== undefined,
      }),
      tools: childTools,
      beforeToolCall:
        outboundApproval || workspaceWriteApproval || mcpMutationApproval || shellApproval
          ? async (context, signal) => {
              const workspaceResult = await workspaceWriteApproval?.beforeToolCall(context, signal);
              if (workspaceResult !== undefined) return workspaceResult;
              const mutationResult = await mcpMutationApproval?.beforeToolCall(context, signal);
              if (mutationResult !== undefined) return mutationResult;
              const shellResult = await shellApproval?.beforeToolCall(context, signal);
              if (shellResult !== undefined) return shellResult;
              return outboundApproval?.beforeToolCall(context, signal);
            }
          : undefined,
      initialMessages: input.context.messages,
      onStarting: () => input.telemetry?.starting(),
    });
    if (deadlineElapsed()) {
      child.cancel(new Error("Subagent child deadline exceeded."));
      return timedOutResult(input.request);
    }
    if (input.signal?.aborted) {
      child.cancel(
        input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("Parent generation cancelled."),
      );
      throwIfParentAborted(input.signal);
    }
    const recordUsage = input.dependencies?.recordUsage ?? (async () => {});

    let currentTurnOutput = "";
    let terminalOutput = "";
    let observedOutputChars = 0;
    let observedProtocolChars = 0;
    let currentTurnTextDeltaChars = 0;
    let currentTurnProtocolDeltaChars = 0;
    let currentTurnHiddenProtocolDeltaChars = 0;
    let observedTerminalAssistant = false;
    let turns = 0;
    let toolCalls = 0;
    let lifecycleEvents = 0;
    let currentTurnHadTextDelta = false;
    let terminalError: string | null = null;
    let terminalAborted = false;
    let limitWarning: string | null = null;
    const stopForLimit = (warning: string) => {
      if (limitWarning) return;
      limitWarning = warning;
      child.cancel(new Error(warning));
    };
    unsubscribe = child.agent.subscribe(async (event) => {
      const isStreamUpdate = event.type === "message_update";
      if (!isStreamUpdate) {
        lifecycleEvents += 1;
        if (lifecycleEvents > policy.maxEvents) {
          stopForLimit("The child reached its event limit.");
          return;
        }
      }
      if (event.type === "message_start" && event.message.role === "assistant") {
        currentTurnHadTextDelta = false;
        currentTurnTextDeltaChars = 0;
        currentTurnProtocolDeltaChars = 0;
        currentTurnHiddenProtocolDeltaChars = 0;
        currentTurnOutput = "";
        terminalError = null;
        terminalAborted = false;
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          input.telemetry?.textDelta(update.delta);
          currentTurnHadTextDelta = true;
          currentTurnTextDeltaChars += update.delta.length;
          currentTurnProtocolDeltaChars += update.delta.length;
          observedProtocolChars += update.delta.length;
          observedOutputChars += update.delta.length;
          const remaining = policy.maxOutputChars - currentTurnOutput.length;
          if (remaining > 0) currentTurnOutput += update.delta.slice(0, remaining);
          if (observedOutputChars > policy.maxOutputChars || update.delta.length > remaining) {
            stopForLimit("The child reached its output limit.");
          }
          if (observedProtocolChars > policy.maxProtocolChars) {
            stopForLimit("The child reached its protocol limit.");
          }
        } else if (update.type === "thinking_delta" || update.type === "toolcall_delta") {
          currentTurnProtocolDeltaChars += update.delta.length;
          currentTurnHiddenProtocolDeltaChars += update.delta.length;
          observedProtocolChars += update.delta.length;
          input.telemetry?.protocolDelta?.(update.delta.length);
          if (observedProtocolChars > policy.maxProtocolChars) {
            stopForLimit("The child reached its protocol limit.");
          }
        } else if (update.type === "error" && update.reason === "error") {
          terminalError = SAFE_CHILD_PROVIDER_FAILURE;
        }
      } else if (event.type === "turn_start") {
        if (turns >= policy.maxTurns) {
          stopForLimit("The child reached its turn limit.");
          return;
        }
        turns += 1;
        input.telemetry?.turnStarted();
      } else if (event.type === "agent_start") {
        input.telemetry?.running();
      } else if (event.type === "tool_execution_start") {
        if (toolCalls >= policy.maxToolCalls) {
          stopForLimit("The child reached its tool-call limit.");
          return;
        }
        toolCalls += 1;
        input.telemetry?.toolStarted(event.toolName);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const message = assistantMessage(event);
        if (message) {
          // Host-owned synthetic failures carry no provider request usage and
          // never belong in provider success/failure aggregates.
          if (!piRuntimePrivateFailure(message)) {
            input.telemetry?.usage(message);
            await recordUsage(message, input.runtime);
          }
          const error = terminalGenerationError(message) ?? terminalGenerationLengthError(message);
          if (error) {
            terminalError = message.stopReason === "error" ? SAFE_CHILD_PROVIDER_FAILURE : error;
          }
          if (terminalGenerationWasAborted(message)) terminalAborted = true;
          const exactOutput = terminalAssistantText(message);
          const additionalObserved = currentTurnHadTextDelta
            ? Math.max(0, exactOutput.length - currentTurnTextDeltaChars)
            : exactOutput.length;
          observedOutputChars += additionalObserved;
          input.telemetry?.textReconciled(additionalObserved);
          const exactProtocolChars = assistantProtocolChars(message);
          observedProtocolChars += Math.max(0, exactProtocolChars - currentTurnProtocolDeltaChars);
          const additionalHiddenProtocolChars = Math.max(
            0,
            assistantHiddenProtocolChars(message) - currentTurnHiddenProtocolDeltaChars,
          );
          input.telemetry?.protocolReconciled?.(additionalHiddenProtocolChars);
          currentTurnOutput = exactOutput.slice(0, policy.maxOutputChars);
          if (
            observedOutputChars > policy.maxOutputChars ||
            exactOutput.length > policy.maxOutputChars
          ) {
            stopForLimit("The child reached its output limit.");
          }
          if (observedProtocolChars > policy.maxProtocolChars) {
            stopForLimit("The child reached its protocol limit.");
          }
          if (message.stopReason !== "toolUse") {
            observedTerminalAssistant = true;
            terminalOutput = currentTurnOutput;
          }
        }
      }
    });

    const prompt = Promise.resolve()
      .then(() => child.prompt(subagentTaskPrompt(input.request.task)))
      .then(
        (runtimeOutcome) => ({ kind: "settled" as const, runtimeOutcome }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
    const outcome = await Promise.race([prompt, deadline, parentAbort]);
    if (outcome.kind === "parent_aborted") {
      child.cancel(
        input.signal?.reason instanceof Error
          ? input.signal.reason
          : new Error("Parent generation cancelled."),
      );
      if (!(await boundedDrain(prompt, policy.cancellationGraceMs))) {
        child.markCleanupPending?.();
        reportCleanupFailure(input);
      }
      throwIfParentAborted(input.signal);
      throw new Error("Parent generation cancelled.");
    }
    if (outcome.kind === "timed_out" || deadlineElapsed()) {
      child.cancel(new Error("Subagent child deadline exceeded."));
      if (!(await boundedDrain(prompt, policy.cancellationGraceMs))) {
        child.markCleanupPending?.();
        reportCleanupFailure(input);
      }
      return timedOutResult(input.request);
    }
    throwIfParentAborted(input.signal);
    if (limitWarning) return safeFailure(input.request, limitWarning);
    if (outcome.kind === "failed") {
      return safeFailure(input.request);
    }
    if (outcome.runtimeOutcome.kind === "host_failed") {
      return safeFailure(input.request);
    }
    if (outcome.runtimeOutcome.kind === "provider_failed") {
      return safeFailure(
        input.request,
        outcome.runtimeOutcome.reason === "output-limit"
          ? "The child reached its output limit."
          : SAFE_CHILD_PROVIDER_FAILURE,
      );
    }
    if (outcome.runtimeOutcome.kind === "app_cancelled") {
      return {
        role: input.request.role,
        label: input.request.label,
        status: "interrupted",
        summary: "",
        warning: "The child was interrupted before completion.",
      };
    }
    if (terminalError) return safeFailure(input.request, terminalError);
    if (terminalAborted) {
      return {
        role: input.request.role,
        label: input.request.label,
        status: "interrupted",
        summary: "",
        warning: "The child was interrupted before completion.",
      };
    }
    if (!observedTerminalAssistant || !terminalOutput.trim()) {
      return safeFailure(input.request, "The child completed without a textual assistant result.");
    }
    return {
      role: input.request.role,
      label: input.request.label,
      status: "completed",
      summary: truncateSummary(terminalOutput.trim() || "[No textual result.]"),
    };
  } finally {
    clearTimeout(deadlineTimer);
    removeParentAbort();
    unsubscribe();
    if (workspaceWriteApproval) {
      let shutdownFailed = false;
      const shutdown = Promise.resolve()
        .then(() => workspaceWriteApproval!.shutdown())
        .catch(() => {
          shutdownFailed = true;
        });
      if (!(await boundedDrain(shutdown, policy.cancellationGraceMs)) || shutdownFailed) {
        reportCleanupFailure(input);
      }
    }
    if (mcpMutationApproval) {
      let shutdownFailed = false;
      const shutdown = Promise.resolve()
        .then(() => mcpMutationApproval!.shutdown())
        .catch(() => {
          shutdownFailed = true;
        });
      if (!(await boundedDrain(shutdown, policy.cancellationGraceMs)) || shutdownFailed) {
        reportCleanupFailure(input);
      }
    }
    if (shellApproval) {
      let shutdownFailed = false;
      const shutdown = Promise.resolve()
        .then(() => shellApproval!.shutdown())
        .catch(() => {
          shutdownFailed = true;
        });
      if (!(await boundedDrain(shutdown, policy.cancellationGraceMs)) || shutdownFailed) {
        reportCleanupFailure(input);
      }
    }
  }
}
