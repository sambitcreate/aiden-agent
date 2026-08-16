export const GENERATION_TIMELINE_VERSION = 3 as const;

/** Versions this build can still replay from local chat storage. */
const REPLAYABLE_VERSIONS = new Set([1, 2, GENERATION_TIMELINE_VERSION]);

export type AgentStepStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export interface AgentToolStep {
  id: string;
  order: number;
  kind: "tool";
  toolCallId: string;
  toolName: string;
  label: string;
  status: AgentStepStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** UTF-16 offset into the visible assistant text when this activity began. */
  contentOffset?: number;
  /** Renderer-safe line totals reported by a completed first-party file mutation. */
  lineChanges?: {
    additions: number;
    deletions: number;
  };
  /** A workspace-relative file or directory. Never raw file contents or commands. */
  target?: string;
  /**
   * The single-line object of the action, shown after the verb in the activity
   * feed: a glob or grep pattern, a web query, or the model's own description
   * of a command. Never raw file contents and never a raw shell command.
   */
  detail?: string;
}

/** One uninterrupted stretch of model reasoning between tool calls. */
export interface AgentThinkingStep {
  id: string;
  order: number;
  kind: "thinking";
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** UTF-16 offset into the visible assistant text when this activity began. */
  contentOffset?: number;
  /** Wall-clock reasoning time measured by the host; pi reports no duration. */
  durationMs?: number;
}

export type AgentStep = AgentToolStep | AgentThinkingStep;

export type GenerationTimelineStatus = "running" | "completed" | "failed" | "cancelled";

export interface GenerationClaimCheck {
  kind: "unverified_success";
  /** Renderer-safe local step IDs whose outcomes conflict with the response. */
  stepIds: string[];
}

export interface GenerationTimeline {
  /** Preserve legacy versions on replay; only newly projected timelines use v3. */
  version: 1 | 2 | typeof GENERATION_TIMELINE_VERSION;
  generationId: string;
  status: GenerationTimelineStatus;
  startedAt: number;
  finishedAt?: number;
  steps: AgentStep[];
  /** Append-only post-turn outcome. The assistant's prose is never rewritten. */
  claimCheck?: GenerationClaimCheck;
}

export interface ChatTimelineNotification {
  streamId: string;
  timeline: GenerationTimeline;
}

const STEP_STATUSES = new Set<AgentStepStatus>([
  "pending",
  "awaiting_approval",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);
const TIMELINE_STATUSES = new Set<GenerationTimelineStatus>([
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const SAFE_ID = /^[a-z0-9._:-]+$/iu;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;
const MAX_DETAIL_LENGTH = 120;
const MAX_LINE_CHANGE_COUNT = 100_000_000;

export function isToolStep(step: AgentStep): step is AgentToolStep {
  return step.kind === "tool";
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeStoredTarget(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    WINDOWS_ABSOLUTE_PATH.test(value)
  ) {
    return false;
  }
  return !value.split(/[\\/]/u).some((segment) => segment === "..");
}

/** Details render as one feed line, so reject anything multi-line or oversized. */
function safeStoredDetail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DETAIL_LENGTH &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}

function parseToolStep(
  step: Record<string, unknown>,
  index: number,
  contentOffset?: number,
  allowLineChanges = false,
): AgentToolStep | undefined {
  const rawLineChanges = step.lineChanges;
  const lineChanges =
    rawLineChanges && typeof rawLineChanges === "object"
      ? (rawLineChanges as Record<string, unknown>)
      : undefined;
  if (
    typeof step.id !== "string" ||
    !/^tool-[1-9]\d*$/u.test(step.id) ||
    typeof step.toolCallId !== "string" ||
    !/^call-[1-9]\d*$/u.test(step.toolCallId) ||
    typeof step.toolName !== "string" ||
    step.toolName.length === 0 ||
    step.toolName.length > 80 ||
    typeof step.label !== "string" ||
    step.label.length === 0 ||
    step.label.length > 120 ||
    typeof step.status !== "string" ||
    !STEP_STATUSES.has(step.status as AgentStepStatus) ||
    (step.target !== undefined && !safeStoredTarget(step.target)) ||
    (step.detail !== undefined && !safeStoredDetail(step.detail)) ||
    (rawLineChanges !== undefined &&
      (!allowLineChanges ||
        !lineChanges ||
        (step.toolName !== "write_file" && step.toolName !== "edit_file") ||
        step.status !== "completed" ||
        !Number.isSafeInteger(lineChanges.additions) ||
        (lineChanges.additions as number) < 0 ||
        (lineChanges.additions as number) > MAX_LINE_CHANGE_COUNT ||
        !Number.isSafeInteger(lineChanges.deletions) ||
        (lineChanges.deletions as number) < 0 ||
        (lineChanges.deletions as number) > MAX_LINE_CHANGE_COUNT))
  ) {
    return undefined;
  }
  return {
    id: step.id,
    order: index,
    kind: "tool",
    toolCallId: step.toolCallId,
    toolName: step.toolName,
    label: step.label,
    status: step.status as AgentStepStatus,
    startedAt: step.startedAt as number,
    updatedAt: step.updatedAt as number,
    ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt as number }),
    ...(contentOffset === undefined ? {} : { contentOffset }),
    ...(step.target === undefined ? {} : { target: step.target as string }),
    ...(step.detail === undefined ? {} : { detail: step.detail as string }),
    ...(lineChanges === undefined
      ? {}
      : {
          lineChanges: {
            additions: lineChanges.additions as number,
            deletions: lineChanges.deletions as number,
          },
        }),
  };
}

function parseThinkingStep(
  step: Record<string, unknown>,
  index: number,
  contentOffset?: number,
): AgentThinkingStep | undefined {
  if (
    typeof step.id !== "string" ||
    !/^think-[1-9]\d*$/u.test(step.id) ||
    (step.durationMs !== undefined && !finiteTimestamp(step.durationMs))
  ) {
    return undefined;
  }
  return {
    id: step.id,
    order: index,
    kind: "thinking",
    startedAt: step.startedAt as number,
    updatedAt: step.updatedAt as number,
    ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt as number }),
    ...(contentOffset === undefined ? {} : { contentOffset }),
    ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs as number }),
  };
}

/** Validate the renderer-safe subset before replaying a timeline from local chat storage. */
export function parseGenerationTimeline(
  value: unknown,
  contentLength?: number,
): GenerationTimeline | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.version !== "number" ||
    !REPLAYABLE_VERSIONS.has(candidate.version) ||
    typeof candidate.generationId !== "string" ||
    candidate.generationId.length === 0 ||
    candidate.generationId.length > 128 ||
    !SAFE_ID.test(candidate.generationId) ||
    typeof candidate.status !== "string" ||
    !TIMELINE_STATUSES.has(candidate.status as GenerationTimelineStatus) ||
    !finiteTimestamp(candidate.startedAt) ||
    (candidate.finishedAt !== undefined && !finiteTimestamp(candidate.finishedAt)) ||
    !Array.isArray(candidate.steps) ||
    candidate.steps.length > 200
  ) {
    return undefined;
  }

  const steps: AgentStep[] = [];
  let previousContentOffset = 0;
  for (const [index, rawStep] of candidate.steps.entries()) {
    if (!rawStep || typeof rawStep !== "object") return undefined;
    const step = rawStep as Record<string, unknown>;
    if (
      step.order !== index ||
      !finiteTimestamp(step.startedAt) ||
      !finiteTimestamp(step.updatedAt) ||
      (step.finishedAt !== undefined && !finiteTimestamp(step.finishedAt))
    ) {
      return undefined;
    }
    const contentOffset =
      candidate.version === GENERATION_TIMELINE_VERSION ? step.contentOffset : undefined;
    if (
      candidate.version === GENERATION_TIMELINE_VERSION &&
      (!Number.isSafeInteger(contentOffset) ||
        (contentOffset as number) < previousContentOffset ||
        (contentLength !== undefined && (contentOffset as number) > contentLength))
    ) {
      return undefined;
    }
    if (contentOffset !== undefined) previousContentOffset = contentOffset as number;
    // Version 1 predates reasoning steps. Version 2 predates text offsets.
    const parsed =
      step.kind === "tool"
        ? parseToolStep(
            step,
            index,
            contentOffset as number | undefined,
            candidate.version === GENERATION_TIMELINE_VERSION,
          )
        : step.kind === "thinking" && candidate.version !== 1
          ? parseThinkingStep(step, index, contentOffset as number | undefined)
          : undefined;
    if (!parsed) return undefined;
    steps.push(parsed);
  }

  let claimCheck: GenerationClaimCheck | undefined;
  if (candidate.claimCheck !== undefined) {
    if (!candidate.claimCheck || typeof candidate.claimCheck !== "object") return undefined;
    const rawClaimCheck = candidate.claimCheck as Record<string, unknown>;
    if (
      candidate.status === "running" ||
      rawClaimCheck.kind !== "unverified_success" ||
      !Array.isArray(rawClaimCheck.stepIds) ||
      rawClaimCheck.stepIds.length === 0 ||
      rawClaimCheck.stepIds.length > 20 ||
      rawClaimCheck.stepIds.some(
        (id) =>
          typeof id !== "string" ||
          !steps.some(
            (step) =>
              step.id === id &&
              isToolStep(step) &&
              (step.status === "failed" ||
                step.status === "blocked" ||
                step.status === "cancelled"),
          ),
      ) ||
      new Set(rawClaimCheck.stepIds).size !== rawClaimCheck.stepIds.length
    ) {
      return undefined;
    }
    claimCheck = {
      kind: "unverified_success",
      stepIds: rawClaimCheck.stepIds as string[],
    };
  }

  return {
    version: candidate.version as GenerationTimeline["version"],
    generationId: candidate.generationId,
    status: candidate.status as GenerationTimelineStatus,
    startedAt: candidate.startedAt,
    ...(candidate.finishedAt === undefined ? {} : { finishedAt: candidate.finishedAt }),
    steps,
    ...(claimCheck ? { claimCheck } : {}),
  };
}

export function isTerminalAgentStep(status: AgentStepStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "blocked" || status === "cancelled"
  );
}

export function latestActiveAgentStep(timeline: GenerationTimeline | null): AgentToolStep | null {
  if (!timeline) return null;
  for (let index = timeline.steps.length - 1; index >= 0; index -= 1) {
    const step = timeline.steps[index];
    if (
      step &&
      isToolStep(step) &&
      (step.status === "pending" ||
        step.status === "awaiting_approval" ||
        step.status === "running")
    ) {
      return step;
    }
  }
  return null;
}
