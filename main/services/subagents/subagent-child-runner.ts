import type { CompactionEngine, CompactionModelOverrides } from "../../../renderer/shared/compaction.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
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
import type { SubagentRuntimeTransform } from "./subagent-runtime-authority.js";
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
import { SUBAGENT_READ_TOOL_NAMES, type SubagentReadToolName } from "./capability-profile.js";
import {
  captureLiveSubagentContext,
  type SubagentContextCapture,
  type SubagentContextMode,
} from "./forked-context.js";
import { normalizeSubagentModelText } from "./model-text.js";
import { sanitizePartialFindingsForParent } from "./subagent-work-text-filter.js";
import type { SubagentTranscriptRecorder } from "./subagent-transcript-recorder.js";
import type { SubagentAuthorityV2 } from "./authority-v2.js";
import { createSubagentTool } from "./subagent-tool.js";
import type { SubagentModelToolOptions } from "./subagent-model-selection.js";
import type { SubagentSupervisor } from "./subagent-supervisor.js";
import {
  projectRequestableSubagentMcpInventoryV2,
  projectRequestableSubagentMcpMutationInventoryV2,
} from "./request-capabilities-v2.js";
import type { SubagentOutboundToolBindingV2 } from "./outbound-approval-v2.js";
import type { SubagentOutboundApprovalGateV2 } from "./outbound-approval-v2.js";
import {
  subagentWorkspaceWriteTargetPath,
  type SubagentWorkspaceWriteApprovalGateV2,
  type SubagentWorkspaceWriteToolBindingV2,
} from "./subagent-workspace-write.js";
import type {
  SubagentMcpMutationBindingV2,
  SubagentMcpMutationGateV2,
} from "./subagent-mcp-mutation.js";
import type { SubagentShellGateV2, SubagentShellToolBindingV2 } from "./subagent-shell.js";

import { SUBAGENT_PARTIAL_WORK_NOTE, SUBAGENT_TIME_LIMIT_WARNING, type SubagentTimeLimit, DEFAULT_SUBAGENT_CHILD_DEADLINE_MS, DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS, MAX_SUBAGENT_CHILD_TURNS, MAX_SUBAGENT_CHILD_TOOL_CALLS, MAX_SUBAGENT_CHILD_EVENTS, MAX_SUBAGENT_CHILD_OUTPUT_CHARS, MAX_SUBAGENT_CHILD_PROTOCOL_CHARS } from "./subagent-child-policy.js";
export * from "./subagent-child-policy.js";
const SAFE_CHILD_PROVIDER_FAILURE = "The child model could not complete this task.";
const CHILD_TURN_LIMIT_WARNING = "The child reached its turn limit.";
const CHILD_REPORT_INSTRUCTION = "Your remaining allowance is for one text-only final report. No tools or further actions are available. Report only what the settled history supports: partial findings, checks actually run and their observed results, remaining checks and blockers. Work is incomplete and unverified; do not claim task acceptance or that interrupted/unknown effects succeeded. Keep the report concise.";

export interface SubagentChildRunnerPolicy {
  deadlineMs?: number;
  /**
   * Which named limit the deadline enforces. Only a Bot reply's 60 minutes is
   * a real limit, so only "bot" saves a last turn for a report before it.
   * The chat limit is a 24-hour safety net. Defaults to "chat".
   */
  timeLimit?: SubagentTimeLimit;
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
    transformRuntime?: SubagentRuntimeTransform;
    thinkingLevel: ThinkingLevel;
    compactionEngine?: CompactionEngine;
  compactionModelOverrides?: CompactionModelOverrides;
    systemPrompt: string;
    tools: AgentTool[];
    initialMessages: AgentMessage[];
    beforeToolCall?: (
      context: BeforeToolCallContext,
      signal?: AbortSignal,
    ) => Promise<BeforeToolCallResult | undefined>;
    prepareNextTurnWithContext?: AgentOptions["prepareNextTurnWithContext"];
    finishTurn?: AgentOptions["finishTurn"];
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
  compactionEngine?: CompactionEngine;
  compactionModelOverrides?: CompactionModelOverrides;
  authority: SubagentRuntimeAuthority;
  runId?: string;
  childId?: string;
  groupId: string;
  runtime: ResolvedModelRuntime;
  transformRuntime?: SubagentRuntimeTransform;
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
  /** Requestable models and efforts advertised on the nested subagent tool. */
  nestedModelOptions?: SubagentModelToolOptions;
  /** Private context binding and a transcript allocated only for this child. */
  context: {
    mode: SubagentContextMode;
    revisionHash: string;
    messages: AgentMessage[];
  };
  request: SubagentTaskRequest;
  signal?: AbortSignal;
  /**
   * Saves this helper's conversation for the chat. The supervisor creates it
   * and writes the final state once the child settles; the runner only feeds
   * it events.
   */
  transcript?: SubagentTranscriptRecorder;
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

/**
 * A stopped helper's partial findings for the parent: the same cross-line
 * credential filter as settled partial work, then the summary size cap.
 */
export function projectSubagentPartialFindings(
  reports: readonly string[],
): Pick<SubagentTaskResult, "summary" | "summaryTruncated"> {
  return projectSubagentCompletedSummary(sanitizePartialFindingsForParent(reports));
}

export function projectSubagentCompletedSummary(
  text: string,
): Pick<SubagentTaskResult, "summary" | "summaryTruncated"> {
  text = normalizeSubagentModelText(text);
  if (text.length <= MAX_SUBAGENT_SUMMARY_CHARS) return { summary: text };
  const marker = "\n\n… [middle of child summary truncated] …\n\n";
  const available = MAX_SUBAGENT_SUMMARY_CHARS - marker.length;
  const head = Math.min(2_000, Math.floor(available / 2));
  let headEnd = head;
  if (headEnd > 0 && /[\uD800-\uDBFF]/u.test(text[headEnd - 1]!)) headEnd -= 1;
  let tailStart = text.length - (available - head);
  if (tailStart < text.length && /[\uDC00-\uDFFF]/u.test(text[tailStart]!)) tailStart += 1;
  return {
    summary: `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`,
    summaryTruncated: true,
  };
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

/** Files a stopped helper lists for the parent, after which "and N more" is shown. */
const MAX_PARTIAL_CHANGED_FILES_LISTED = 20;
/** Distinct changed paths tracked per helper; later paths only count. */
const MAX_PARTIAL_CHANGED_FILES_TRACKED = 1_000;
const RAN_COMMANDS_NOTE = "It also ran commands, which may have changed other files.";
const CHANGED_FILES_MAY_BE_INCOMPLETE_NOTE =
  "The helper had not finished stopping, so this list may be incomplete.";

/**
 * The parent-facing notes about a stopped helper's side effects: the files it
 * changed through approved writes, and whether it ran shell commands.
 */
export function subagentPartialWorkNotes(
  changedFiles: readonly string[],
  untrackedChangedFiles: number,
  ranCommands: boolean,
  options: { mayBeIncomplete?: boolean } = {},
): string[] {
  const notes: string[] = [];
  if (changedFiles.length > 0) {
    const listed = changedFiles.slice(0, MAX_PARTIAL_CHANGED_FILES_LISTED);
    const more = changedFiles.length - listed.length + untrackedChangedFiles;
    // One path per line: a name can itself contain ", " or " and ".
    notes.push([
      "Files it changed:",
      ...listed.map((path) => `- ${path}`),
      ...(more > 0 ? [`- and ${more} more`] : []),
      ...(options.mayBeIncomplete ? [CHANGED_FILES_MAY_BE_INCOMPLETE_NOTE] : []),
    ].join("\n"));
  }
  if (ranCommands) notes.push(RAN_COMMANDS_NOTE);
  return notes;
}

function timedOutResult(request: SubagentTaskRequest, timeLimit: SubagentTimeLimit): SubagentTaskResult {
  return {
    role: request.role,
    label: request.label,
    status: "timed_out",
    // A deadline can split a credential or path at any character. Never
    // promote accumulated stream fragments into renderer-visible terminal
    // state when the child did not complete. Settled partial work is added
    // separately, through the parent-facing partial-findings filter.
    summary: "",
    warning: SUBAGENT_TIME_LIMIT_WARNING[timeLimit],
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
    timeLimit: input.policy?.timeLimit ?? "chat",
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
    (policy.timeLimit !== "chat" && policy.timeLimit !== "bot") ||
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
      return timedOutResult(input.request, policy.timeLimit);
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
    // Side effects a stopped helper reports to its parent with its partial work.
    const changedFiles = new Set<string>();
    let untrackedChangedFiles = 0;
    let ranCommands = false;
    const childTools = assembly.tools.map((tool) => {
      if (workspaceWriteToolNames.has(tool.name) && workspaceWriteApproval) {
        return {
          ...tool,
          execute: async (toolCallId: string, args: unknown, signal?: AbortSignal) => {
            const result = await workspaceWriteApproval!.execute({
              toolCallId,
              toolName: tool.name,
              arguments: args,
              signal,
            });
            // The gate resolves only once the change is committed.
            const path = subagentWorkspaceWriteTargetPath(tool.name, args);
            if (path && !changedFiles.has(path)) {
              if (changedFiles.size < MAX_PARTIAL_CHANGED_FILES_TRACKED) changedFiles.add(path);
              else untrackedChangedFiles += 1;
            }
            return result;
          },
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
          execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => {
            ranCommands = true;
            return shellApproval!.execute({
              toolCallId,
              toolName: "run_command",
              arguments: args,
              signal,
            });
          },
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
    let turns = 0;
    let toolCalls = 0;
    let reportingWarning: string | undefined;
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
          input.nestedModelOptions,
        ),
      );
    }
    child = createChild({
      authority: input.authority,
      runId: input.runId ?? input.childId ?? input.groupId,
      groupId: input.groupId,
      childId: input.childId,
      runtime: input.runtime,
      transformRuntime: input.transformRuntime,
      thinkingLevel: input.thinkingLevel,
      compactionEngine: input.compactionEngine,
      compactionModelOverrides: input.compactionModelOverrides,
      systemPrompt: subagentRoleSystemPrompt(input.request.role, {
        contextMode: input.context.mode,
        workspaceRead: childTools.some((tool) =>
          (SUBAGENT_READ_TOOL_NAMES as readonly string[]).includes(tool.name),
        ),
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
        permission: input.permission,
      }),
      tools: childTools,
      prepareNextTurnWithContext: ({ context }) => {
        throwIfParentAborted(input.signal);
        if (deadlineElapsed()) {
          child!.cancel(new Error("Subagent child deadline exceeded."));
          throw new Error("Subagent child deadline exceeded.");
        }
        if (turns >= policy.maxTurns) {
          stopForLimit(CHILD_TURN_LIMIT_WARNING);
          throw new Error(CHILD_TURN_LIMIT_WARNING);
        }
        // Reserve one of the already-authorized turns, with at most 30 seconds
        // (10% for shorter runs) of the existing wall clock. An in-flight tool
        // is never interrupted to manufacture a report or given extra time.
        // Only a Bot reply's limit is a real deadline worth reporting against;
        // the chat limit is a 24-hour safety net.
        if (turns >= policy.maxTurns - 1 || toolCalls >= policy.maxToolCalls ||
          (policy.timeLimit === "bot" &&
            now() >= deadlineAt - Math.min(30_000, policy.deadlineMs * 0.1))) {
          reportingWarning ??= turns >= policy.maxTurns - 1
            ? CHILD_TURN_LIMIT_WARNING
            : toolCalls >= policy.maxToolCalls
              ? "The child reached its tool-call limit."
              : "The child reserved its remaining deadline for reporting.";
          return {
            context: {
              ...context,
              tools: [],
              messages: [...context.messages, {
                role: "user",
                content: [{ type: "text", text: CHILD_REPORT_INSTRUCTION }],
                timestamp: Date.now(),
              }],
            },
          };
        }
        return undefined;
      },
      // A noncompliant model can still emit a stale tool name. End after this
      // one report response, and deny it before any approval or effect dispatch.
      finishTurn: () => reportingWarning ? { action: "end" } : undefined,
      beforeToolCall: async (context, signal) => {
        if (reportingWarning) return { block: true, terminate: true, reason: "Only a final text report is permitted." };
        const workspaceResult = await workspaceWriteApproval?.beforeToolCall(context, signal);
        if (workspaceResult !== undefined) return workspaceResult;
        const mutationResult = await mcpMutationApproval?.beforeToolCall(context, signal);
        if (mutationResult !== undefined) return mutationResult;
        const shellResult = await shellApproval?.beforeToolCall(context, signal);
        if (shellResult !== undefined) return shellResult;
        return outboundApproval?.beforeToolCall(context, signal);
      },
      initialMessages: input.context.messages,
      onStarting: () => input.telemetry?.starting(),
    });
    if (deadlineElapsed()) {
      child.cancel(new Error("Subagent child deadline exceeded."));
      return timedOutResult(input.request, policy.timeLimit);
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
    // Keep the complete, output-budget-bounded assistant history so sanitizing
    // the final partial never loses an earlier credential-key prefix.
    const partialReports: string[] = [];
    // Settled partial work for the parent: the helper's settled messages plus
    // the files it changed, through the parent-facing partial-findings filter.
    type PartialWork = Pick<SubagentTaskResult, "summary" | "summaryTruncated">;
    // A child whose cancellation did not drain may still commit a gated write
    // after this snapshot, so its file list is marked as possibly incomplete.
    let cleanupPending = false;
    const partialWork = (): PartialWork | undefined => {
      const notes = subagentPartialWorkNotes(
        [...changedFiles],
        untrackedChangedFiles,
        ranCommands,
        { mayBeIncomplete: cleanupPending },
      );
      if (partialReports.length === 0 && notes.length === 0) return undefined;
      const reports = notes.length > 0 ? [...partialReports, notes.join("\n")] : partialReports;
      return projectSubagentPartialFindings(reports);
    };
    const withPartial = (
      base: SubagentTaskResult,
      partial: PartialWork | undefined = partialWork(),
    ): SubagentTaskResult => {
      if (!partial) return base;
      return {
        ...base,
        ...partial,
        warning: `${base.warning ?? ""} ${SUBAGENT_PARTIAL_WORK_NOTE}`.trim(),
      };
    };
    const interruptedResult = (): SubagentTaskResult => ({
      role: input.request.role,
      label: input.request.label,
      status: "interrupted",
      summary: "",
      warning: "The child was interrupted before completion.",
    });
    let observedOutputChars = 0;
    let observedProtocolChars = 0;
    let currentTurnTextDeltaChars = 0;
    let currentTurnProtocolDeltaChars = 0;
    let currentTurnHiddenProtocolDeltaChars = 0;
    let observedTerminalAssistant = false;
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
      // Display-only; a recorder failure never changes the run.
      input.transcript?.observe(event);
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
          stopForLimit(CHILD_TURN_LIMIT_WARNING);
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
          const messageWasAborted = terminalGenerationWasAborted(message);
          if (messageWasAborted) terminalAborted = true;
          const exactOutput = terminalAssistantText(message);
          const additionalObserved = currentTurnHadTextDelta
            ? Math.max(0, exactOutput.length - currentTurnTextDeltaChars)
            : exactOutput.length;
          observedOutputChars += additionalObserved;
          if (
            !messageWasAborted &&
            observedOutputChars <= policy.maxOutputChars &&
            exactOutput.length <= policy.maxOutputChars &&
            exactOutput.trim()
          ) {
            partialReports.push(exactOutput.trim());
          }
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
        cleanupPending = true;
        child.markCleanupPending?.();
        reportCleanupFailure(input);
      }
      // A stopped helper hands its settled partial work to the supervisor,
      // which keeps it under the stop or time-limit status it decides.
      const partial = partialWork();
      if (partial) return withPartial(interruptedResult(), partial);
      throwIfParentAborted(input.signal);
      throw new Error("Parent generation cancelled.");
    }
    if (outcome.kind === "timed_out" || deadlineElapsed()) {
      child.cancel(new Error("Subagent child deadline exceeded."));
      if (!(await boundedDrain(prompt, policy.cancellationGraceMs))) {
        cleanupPending = true;
        child.markCleanupPending?.();
        reportCleanupFailure(input);
      }
      return withPartial(timedOutResult(input.request, policy.timeLimit));
    }
    if (input.signal?.aborted) {
      const partial = partialWork();
      if (partial) return withPartial(interruptedResult(), partial);
    }
    throwIfParentAborted(input.signal);
    // Every unfinished ending hands over the settled partial work. Source paths
    // stay useful to the parent; the renderer projector applies its stricter
    // snapshot/path policy separately.
    if (limitWarning) return withPartial(safeFailure(input.request, limitWarning));
    if (outcome.kind === "failed") return withPartial(safeFailure(input.request));
    if (outcome.runtimeOutcome.kind === "host_failed") {
      return withPartial(safeFailure(input.request));
    }
    if (outcome.runtimeOutcome.kind === "provider_failed") {
      return withPartial(safeFailure(
        input.request,
        outcome.runtimeOutcome.reason === "output-limit"
          ? "The child reached its output limit."
          : SAFE_CHILD_PROVIDER_FAILURE,
      ));
    }
    if (outcome.runtimeOutcome.kind === "app_cancelled") return withPartial(interruptedResult());
    if (terminalError) return withPartial(safeFailure(input.request, terminalError));
    if (terminalAborted) return withPartial(interruptedResult());
    if (reportingWarning) {
      if (!observedTerminalAssistant || !terminalOutput.trim()) {
        return withPartial(safeFailure(
          input.request,
          `${reportingWarning} The child did not provide a final text report.`,
        ));
      }
      return withPartial(safeFailure(input.request, reportingWarning));
    }
    if (!observedTerminalAssistant || !terminalOutput.trim()) {
      return withPartial(safeFailure(
        input.request,
        "The child completed without a textual assistant result.",
      ));
    }
    return {
      role: input.request.role,
      label: input.request.label,
      status: "completed",
      ...projectSubagentCompletedSummary(terminalOutput.trim() || "[No textual result.]"),
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
