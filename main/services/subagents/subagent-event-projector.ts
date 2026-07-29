import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  MAX_SUBAGENT_ACTIVITY_CHARS,
  MAX_SUBAGENT_ERROR_CHARS,
  MAX_SUBAGENT_LATEST_TEXT_CHARS,
  MAX_SUBAGENT_MILESTONES,
  MAX_SUBAGENT_TASK_PREVIEW_CHARS,
  MAX_SUBAGENT_TERMINAL_MARKDOWN_CHARS,
  MAX_SUBAGENT_WARNING_CHARS,
  SUBAGENT_RUN_SNAPSHOT_VERSION,
  parseSubagentRunSnapshotV1,
  type SubagentRunSnapshotV1,
  type SubagentRunState,
  type SubagentMilestoneKind,
} from "../../../renderer/shared/subagent-runs.js";
import { reportedTokens } from "../usage-accounting.js";
import type { SubagentTaskRequest, SubagentTaskResult } from "./contracts.js";
import { sanitizeSubagentSnapshotText } from "../../../renderer/shared/subagent-safe-text.js";

const MAX_DURABLE_LIVE_MILESTONES = 4;

export interface SubagentRunIdentity {
  runId: string;
  groupId: string;
  childId: string;
}

export interface SubagentRunProjectorInput {
  generationId: string;
  chatId: string;
  workspaceId: string;
  modelId: string;
  onSnapshot?: (snapshot: SubagentRunSnapshotV1) => void | Promise<void>;
  now?: () => number;
}

function normalizeProjectedText(value: string): string {
  const normalized = Array.from(sanitizeSubagentSnapshotText(value).replace(/\r\n?/gu, "\n"))
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code === 0x2028 || code === 0x2029) return "\n";
      if (code === 10) return character;
      if (code <= 31 || (code >= 127 && code <= 159)) return " ";
      return character;
    })
    .join("");
  return sanitizeSubagentSnapshotText(normalized);
}

function bounded(value: string, maximum: number, marker = "…"): string {
  const safe = normalizeProjectedText(value).trim();
  if (safe.length <= maximum) return safe;
  return `${safe.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

function boundedSingleLine(value: string, maximum: number): string {
  return bounded(normalizeProjectedText(value).replace(/\s+/gu, " "), maximum);
}

function safeToolMilestone(toolName: string): {
  activity: string;
  milestone: SubagentMilestoneKind;
} {
  switch (toolName) {
    case "read_file":
      return { activity: "Reading a workspace file", milestone: "reading" };
    case "list_dir":
      return { activity: "Listing a workspace directory", milestone: "listing" };
    case "glob":
      return { activity: "Matching workspace file names", milestone: "matching" };
    case "grep":
      return { activity: "Searching workspace text", milestone: "searching" };
    default:
      return { activity: "Using a bounded read-only tool", milestone: "inspecting" };
  }
}

function appendMilestone(
  current: readonly SubagentMilestoneKind[] | undefined,
  next: SubagentMilestoneKind,
): SubagentMilestoneKind[] {
  const milestones = current ?? [];
  if (milestones[milestones.length - 1] === next || milestones.length >= MAX_SUBAGENT_MILESTONES) {
    return [...milestones];
  }
  return [...milestones, next];
}

function stateForResult(result: SubagentTaskResult): SubagentRunState {
  return result.status;
}

/**
 * Converts child lifecycle facts into a strict renderer-safe projection. Raw
 * tool arguments/results, reasoning, prompts, and runtime transport data never
 * enter this class.
 */
export class SubagentEventProjector {
  private readonly records = new Map<string, SubagentRunSnapshotV1>();
  private readonly durableLiveMilestones = new Map<string, number>();
  private readonly now: () => number;
  private persistenceTail: Promise<void> = Promise.resolve();
  private persistenceError: unknown;

  constructor(private readonly input: SubagentRunProjectorInput) {
    this.now = input.now ?? Date.now;
  }

  begin(identity: SubagentRunIdentity, request: SubagentTaskRequest): void {
    if (this.records.has(identity.runId)) {
      throw new Error("Subagent run identity was reused.");
    }
    const now = this.now();
    this.publish({
      version: SUBAGENT_RUN_SNAPSHOT_VERSION,
      ...identity,
      generationId: this.input.generationId,
      chatId: this.input.chatId,
      workspaceId: this.input.workspaceId,
      revision: 1,
      role: request.role,
      label: boundedSingleLine(request.label, 120),
      taskPreview: boundedSingleLine(request.task, MAX_SUBAGENT_TASK_PREVIEW_CHARS),
      state: "queued",
      activity: "Waiting for an execution slot",
      startedAt: now,
      updatedAt: now,
      modelId: boundedSingleLine(this.input.modelId, 160),
      turns: 0,
      tools: 0,
      tokens: 0,
      milestones: [],
      warnings: [],
    });
    this.durableLiveMilestones.set(identity.runId, 0);
  }

  starting(runId: string): void {
    this.update(runId, {
      state: "starting",
      activity: "Starting a fresh child agent",
    });
  }

  running(runId: string): void {
    this.update(runId, {
      state: "running",
      activity: "Reviewing workspace context",
    });
  }

  turnStarted(runId: string): void {
    const current = this.require(runId);
    this.update(runId, { turns: current.turns + 1 }, undefined, false);
  }

  toolStarted(runId: string, toolName: string): void {
    const current = this.require(runId);
    const projected = safeToolMilestone(toolName);
    const activity = bounded(projected.activity, MAX_SUBAGENT_ACTIVITY_CHARS);
    const milestones = this.durableLiveMilestones.get(runId) ?? 0;
    const durable = activity !== current.activity && milestones < MAX_DURABLE_LIVE_MILESTONES;
    if (durable) this.durableLiveMilestones.set(runId, milestones + 1);
    this.update(
      runId,
      {
        tools: current.tools + 1,
        activity,
        milestones: appendMilestone(current.milestones, projected.milestone),
      },
      undefined,
      durable,
    );
  }

  textDelta(runId: string, delta: string): void {
    const current = this.require(runId);
    // A stream fragment cannot be proven safe in isolation: a later delta may
    // complete a credential or path prefix. V1 therefore exposes activity
    // while the child is live and publishes text only from the terminal result,
    // where the complete bounded value can be sanitized in one pass.
    void delta;
    if (current.activity === "Writing a bounded report") return;
    this.update(runId, {
      activity: "Writing a bounded report",
      milestones: appendMilestone(current.milestones, "composing"),
    });
  }

  usage(runId: string, message: AssistantMessage): void {
    const current = this.require(runId);
    const reported = reportedTokens(message.usage)?.total ?? 0;
    const tokens = Number.isSafeInteger(reported)
      ? reported
      : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(reported)));
    this.update(
      runId,
      {
        tokens: Math.min(Number.MAX_SAFE_INTEGER, current.tokens + tokens),
      },
      undefined,
      false,
    );
  }

  finish(runId: string, result: SubagentTaskResult): void {
    const now = this.now();
    const projectedWarning = result.warning
      ? bounded(result.warning, MAX_SUBAGENT_WARNING_CHARS)
      : "";
    const warning = projectedWarning || undefined;
    const terminalMarkdown =
      bounded(
        result.summary || result.warning || "[No textual result.]",
        MAX_SUBAGENT_TERMINAL_MARKDOWN_CHARS,
        "\n\n… [report truncated]",
      ) || "[No textual result.]";
    const latestText =
      bounded(result.summary || result.warning || "", MAX_SUBAGENT_LATEST_TEXT_CHARS) || undefined;
    const error =
      bounded(
        result.warning || "The child could not complete this task.",
        MAX_SUBAGENT_ERROR_CHARS,
      ) || "The child could not complete this task.";
    const state = stateForResult(result);
    this.update(
      runId,
      {
        state,
        activity: undefined,
        finishedAt: now,
        ...(latestText ? { latestText } : {}),
        terminalMarkdown,
        ...(result.status === "failed"
          ? {
              error,
            }
          : {}),
        warnings: warning ? [warning] : [],
      },
      now,
    );
  }

  snapshot(): SubagentRunSnapshotV1[] {
    return [...this.records.values()]
      .sort(
        (left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
      )
      .map((record) => structuredClone(record));
  }

  async flush(): Promise<void> {
    await this.persistenceTail;
    if (this.persistenceError) throw this.persistenceError;
  }

  private require(runId: string): SubagentRunSnapshotV1 {
    const record = this.records.get(runId);
    if (!record) throw new Error("Unknown subagent run.");
    return record;
  }

  private update(
    runId: string,
    patch: Partial<
      Pick<
        SubagentRunSnapshotV1,
        | "state"
        | "activity"
        | "finishedAt"
        | "turns"
        | "tools"
        | "tokens"
        | "milestones"
        | "latestText"
        | "terminalMarkdown"
        | "error"
        | "warnings"
      >
    >,
    updatedAt = this.now(),
    durable = true,
  ): void {
    const current = this.require(runId);
    if (current.finishedAt !== undefined) return;
    const monotonicUpdatedAt = Math.max(current.updatedAt, updatedAt);
    const next: SubagentRunSnapshotV1 = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: monotonicUpdatedAt,
      ...(patch.finishedAt !== undefined
        ? { finishedAt: Math.max(monotonicUpdatedAt, patch.finishedAt) }
        : {}),
    };
    for (const key of [
      "activity",
      "finishedAt",
      "latestText",
      "terminalMarkdown",
      "error",
    ] as const) {
      if (patch[key] === undefined && key in patch) delete next[key];
    }
    this.publish(next, durable);
  }

  private publish(candidate: SubagentRunSnapshotV1, durable = true): void {
    const snapshot = parseSubagentRunSnapshotV1(candidate);
    if (!snapshot) throw new Error("Invalid renderer-safe subagent snapshot.");
    this.records.set(snapshot.runId, snapshot);
    if (!durable || !this.input.onSnapshot) return;
    const operation = () => Promise.resolve(this.input.onSnapshot?.(structuredClone(snapshot)));
    const result = this.persistenceTail.then(operation, operation);
    this.persistenceTail = result.then(
      () => undefined,
      (error) => {
        this.persistenceError ??= error;
      },
    );
  }
}
