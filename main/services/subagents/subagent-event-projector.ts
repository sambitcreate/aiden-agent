import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  adaptSubagentRunSnapshotV2ToV1,
  MAX_SUBAGENT_ACTIVITY_CHARS,
  MAX_SUBAGENT_ERROR_CHARS,
  MAX_SUBAGENT_LATEST_TEXT_CHARS,
  MAX_SUBAGENT_MILESTONES,
  MAX_SUBAGENT_TASK_PREVIEW_CHARS,
  MAX_SUBAGENT_TERMINAL_MARKDOWN_CHARS,
  MAX_SUBAGENT_WARNING_CHARS,
  SUBAGENT_RUN_SNAPSHOT_VERSION,
  parseSubagentRunSnapshotV1,
  parseSubagentRunSnapshotV2,
  type SubagentRunSnapshotV1,
  type SubagentRunSnapshotV2,
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
  /** Synchronous authority/admission seam that runs before a new run is published. */
  prepareSnapshot?: (snapshot: SubagentRunSnapshotV1) => void;
  onSnapshot?: (snapshot: SubagentRunSnapshotV1) => void | Promise<void>;
  onControlSnapshot?: (snapshot: SubagentRunSnapshotV2) => void | Promise<void>;
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
  let safe = normalizeProjectedText(value).trim();
  const safeMarker = normalizeProjectedText(marker);
  for (let attempt = 0; attempt < 8 && safe.length > maximum; attempt += 1) {
    let end = Math.max(0, maximum - safeMarker.length);
    // Do not leave an unpaired high surrogate at the truncation boundary.
    if (end > 0 && /[\uD800-\uDBFF]/u.test(safe[end - 1]!)) end -= 1;
    // Truncation can create a new credential-like suffix even when the full
    // value was safe. Re-run the privacy projection after every cut rather
    // than sending that unstable prefix to the strict snapshot parser.
    safe = normalizeProjectedText(`${safe.slice(0, end)}${safeMarker}`).trim();
  }
  if (safe.length <= maximum) return safe;
  return safeMarker.slice(0, maximum);
}

function boundedSingleLine(value: string, maximum: number): string {
  return bounded(normalizeProjectedText(value).replace(/\s+/gu, " "), maximum);
}

function boundedRequiredSingleLine(value: string, maximum: number, fallback: string): string {
  return boundedSingleLine(value, maximum) || fallback;
}

function safeToolMilestone(toolName: string): {
  activity: string;
  milestone: SubagentMilestoneKind;
} {
  switch (toolName) {
    case "read_file":
      return { activity: "Reading a workspace file", milestone: "reading" };
    case "list_dir":
      return {
        activity: "Listing a workspace directory",
        milestone: "listing",
      };
    case "glob":
      return {
        activity: "Matching workspace file names",
        milestone: "matching",
      };
    case "grep":
      return { activity: "Searching workspace text", milestone: "searching" };
    case "write_file":
    case "edit_file":
      return {
        activity: "Preparing a workspace update",
        milestone: "inspecting",
      };
    case "run_command":
      return {
        activity: "Preparing a command",
        milestone: "inspecting",
      };
    case "web_search":
      return {
        activity: "Using public-web access",
        milestone: "inspecting",
      };
    case "subagent":
      return {
        activity: "Preparing a delegation",
        milestone: "inspecting",
      };
    default:
      return /__.*_[a-f0-9]{12}$/u.test(toolName)
        ? {
            activity: "Preparing connector access",
            milestone: "inspecting",
          }
        : { activity: "Preparing a tool", milestone: "inspecting" };
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
      label: boundedRequiredSingleLine(request.label, 120, "Subagent task"),
      taskPreview: boundedRequiredSingleLine(
        request.task,
        MAX_SUBAGENT_TASK_PREVIEW_CHARS,
        "Private task details redacted.",
      ),
      state: "queued",
      activity: "Waiting for an execution slot",
      startedAt: now,
      updatedAt: now,
      modelId: boundedRequiredSingleLine(this.input.modelId, 160, "Unknown model"),
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
      ? boundedSingleLine(result.warning, MAX_SUBAGENT_WARNING_CHARS)
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
      boundedSingleLine(
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

  /**
   * Apply the only foreground control transition that can arrive outside the
   * child telemetry stream. The private V2 record stays canonical while the
   * internal renderer projection becomes terminal synchronously, fencing every
   * late starting/running/finish callback before durability is acknowledged.
   */
  applyControlSnapshot(value: SubagentRunSnapshotV2): SubagentRunSnapshotV1 {
    const control = parseSubagentRunSnapshotV2(value);
    if (!control || control.state !== "stopped") {
      throw new Error("Invalid subagent terminal control snapshot.");
    }
    const current = this.require(control.runId);
    if (
      current.finishedAt !== undefined ||
      control.revision <= current.revision ||
      control.groupId !== current.groupId ||
      control.generationId !== current.generationId ||
      control.childId !== current.childId ||
      control.chatId !== current.chatId ||
      control.workspaceId !== current.workspaceId ||
      control.role !== current.role ||
      control.label !== current.label ||
      control.taskPreview !== current.taskPreview ||
      control.startedAt !== current.startedAt ||
      control.modelId !== current.modelId ||
      control.updatedAt < current.updatedAt ||
      control.turns < current.turns ||
      control.tools < current.tools ||
      control.tokens < current.tokens
    ) {
      throw new Error(
        "Subagent control snapshot changed immutable run identity or moved backward.",
      );
    }
    const projected = adaptSubagentRunSnapshotV2ToV1(control);
    if (!projected || projected.finishedAt === undefined) {
      throw new Error("Subagent control snapshot could not be projected safely.");
    }
    this.records.set(projected.runId, projected);
    this.enqueuePersistence(() =>
      Promise.resolve(this.input.onControlSnapshot?.(structuredClone(control))),
    );
    return structuredClone(projected);
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
    if (!this.records.has(snapshot.runId)) {
      this.input.prepareSnapshot?.(structuredClone(snapshot));
    }
    this.records.set(snapshot.runId, snapshot);
    if (!durable || !this.input.onSnapshot) return;
    this.enqueuePersistence(() =>
      Promise.resolve(this.input.onSnapshot?.(structuredClone(snapshot))),
    );
  }

  private enqueuePersistence(operation: () => Promise<void>): void {
    const result = this.persistenceTail.then(operation, operation);
    this.persistenceTail = result.then(
      () => undefined,
      (error) => {
        this.persistenceError ??= error;
      },
    );
  }
}
