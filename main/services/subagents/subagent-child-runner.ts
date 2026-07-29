import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { performance } from "node:perf_hooks";
import {
  terminalAssistantTextFallback,
  terminalGenerationError,
  terminalGenerationWasAborted,
} from "../generation-runtime.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import type { WorkspacePermission } from "../types.js";
import {
  MAX_SUBAGENT_SUMMARY_CHARS,
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
import { sanitizeSubagentText } from "./safe-text.js";

export const DEFAULT_SUBAGENT_CHILD_DEADLINE_MS = 10 * 60_000;
export const DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS = 5_000;
export const MAX_SUBAGENT_CHILD_TURNS = 24;
export const MAX_SUBAGENT_CHILD_TOOL_CALLS = 64;
export const MAX_SUBAGENT_CHILD_EVENTS = 512;
export const MAX_SUBAGENT_CHILD_OUTPUT_CHARS = 120_000;

export interface SubagentChildRunnerPolicy {
  deadlineMs?: number;
  cancellationGraceMs?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  maxEvents?: number;
  maxOutputChars?: number;
}

export interface SubagentChildRunnerDependencies {
  createChild?: (input: {
    authority: SubagentRuntimeAuthority;
    groupId: string;
    childId?: string;
    runtime: ResolvedModelRuntime;
    systemPrompt: string;
    tools: AgentTool[];
    onStarting?: () => void;
  }) => SubagentRuntimeChild;
  buildTools?: (input: {
    workspaceRoot: string;
    permission: WorkspacePermission;
    role: string;
    inheritedCeiling: readonly SubagentReadToolName[];
  }) => Promise<AgentTool[]>;
  recordUsage?: (message: AssistantMessage, runtime: ResolvedModelRuntime) => Promise<void>;
}

export interface RunSubagentChildInput {
  authority: SubagentRuntimeAuthority;
  runId?: string;
  childId?: string;
  groupId: string;
  runtime: ResolvedModelRuntime;
  workspaceRoot: string;
  permission: WorkspacePermission;
  inheritedCeiling: readonly SubagentReadToolName[];
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
    usage(message: AssistantMessage): void;
  };
}

function truncateSummary(text: string): string {
  text = sanitizeSubagentText(text);
  if (text.length <= MAX_SUBAGENT_SUMMARY_CHARS) return text;
  const marker = "\n\n… [child summary truncated]";
  return `${text.slice(0, MAX_SUBAGENT_SUMMARY_CHARS - marker.length)}${marker}`;
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
    policy.maxOutputChars <= 0
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
  let removeParentAbort = () => {};
  let unsubscribe = () => {};
  const deadline = new Promise<{ kind: "timed_out" }>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve({ kind: "timed_out" }),
      Math.max(0, deadlineAt - now()),
    );
  });
  const parentAbort = new Promise<{ kind: "parent_aborted" }>((resolve) => {
    if (!input.signal) return;
    const abort = () => resolve({ kind: "parent_aborted" });
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
    const child = createChild({
      authority: input.authority,
      groupId: input.groupId,
      childId: input.childId,
      runtime: input.runtime,
      systemPrompt: subagentRoleSystemPrompt(input.request.role),
      tools: constructionOutcome.tools,
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

    let output = "";
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
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          input.telemetry?.textDelta(update.delta);
          currentTurnHadTextDelta = true;
          const remaining = policy.maxOutputChars - output.length;
          if (remaining > 0) output += update.delta.slice(0, remaining);
          if (update.delta.length > remaining) {
            stopForLimit("The child reached its output limit.");
          }
        } else if (update.type === "error" && update.reason === "error") {
          terminalError = update.error.errorMessage?.trim() || "The child model failed.";
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
          input.telemetry?.usage(message);
          await recordUsage(message, input.runtime);
          const error = terminalGenerationError(message);
          if (error) terminalError = error;
          if (terminalGenerationWasAborted(message)) terminalAborted = true;
          const fallback = terminalAssistantTextFallback(message, currentTurnHadTextDelta);
          if (fallback) {
            const remaining = policy.maxOutputChars - output.length;
            output += fallback.slice(0, Math.max(0, remaining));
            if (fallback.length > remaining) {
              stopForLimit("The child reached its output limit.");
            }
          }
        }
      }
    });

    const prompt = Promise.resolve()
      .then(() => child.prompt(subagentTaskPrompt(input.request.task)))
      .then(
        () => ({ kind: "settled" as const }),
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
        reportCleanupFailure(input);
      }
      throwIfParentAborted(input.signal);
      throw new Error("Parent generation cancelled.");
    }
    if (outcome.kind === "timed_out" || deadlineElapsed()) {
      child.cancel(new Error("Subagent child deadline exceeded."));
      if (!(await boundedDrain(prompt, policy.cancellationGraceMs))) {
        reportCleanupFailure(input);
      }
      return timedOutResult(input.request);
    }
    throwIfParentAborted(input.signal);
    if (limitWarning) return safeFailure(input.request, limitWarning);
    if (outcome.kind === "failed") {
      return safeFailure(input.request);
    }
    if (terminalError) return safeFailure(input.request);
    if (terminalAborted) {
      return {
        role: input.request.role,
        label: input.request.label,
        status: "interrupted",
        summary: "",
        warning: "The child was interrupted before completion.",
      };
    }
    return {
      role: input.request.role,
      label: input.request.label,
      status: "completed",
      summary: truncateSummary(output.trim() || "[No textual result.]"),
    };
  } finally {
    clearTimeout(deadlineTimer);
    removeParentAbort();
    unsubscribe();
  }
}
