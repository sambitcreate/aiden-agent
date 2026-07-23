export const GENERATION_TIMELINE_VERSION = 1 as const;

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
  /** A workspace-relative file or directory. Never raw file contents or commands. */
  target?: string;
}

export type AgentStep = AgentToolStep;

export type GenerationTimelineStatus = "running" | "completed" | "failed" | "cancelled";

export interface GenerationTimeline {
  version: typeof GENERATION_TIMELINE_VERSION;
  generationId: string;
  status: GenerationTimelineStatus;
  startedAt: number;
  finishedAt?: number;
  steps: AgentStep[];
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

/** Validate the renderer-safe subset before replaying a timeline from local chat storage. */
export function parseGenerationTimeline(value: unknown): GenerationTimeline | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== GENERATION_TIMELINE_VERSION ||
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

  const steps: AgentToolStep[] = [];
  for (const [index, rawStep] of candidate.steps.entries()) {
    if (!rawStep || typeof rawStep !== "object") return undefined;
    const step = rawStep as Record<string, unknown>;
    if (
      step.kind !== "tool" ||
      typeof step.id !== "string" ||
      !/^tool-[1-9]\d*$/u.test(step.id) ||
      typeof step.toolCallId !== "string" ||
      !/^call-[1-9]\d*$/u.test(step.toolCallId) ||
      step.order !== index ||
      typeof step.toolName !== "string" ||
      step.toolName.length === 0 ||
      step.toolName.length > 80 ||
      typeof step.label !== "string" ||
      step.label.length === 0 ||
      step.label.length > 120 ||
      typeof step.status !== "string" ||
      !STEP_STATUSES.has(step.status as AgentStepStatus) ||
      !finiteTimestamp(step.startedAt) ||
      !finiteTimestamp(step.updatedAt) ||
      (step.finishedAt !== undefined && !finiteTimestamp(step.finishedAt)) ||
      (step.target !== undefined && !safeStoredTarget(step.target))
    ) {
      return undefined;
    }
    steps.push({
      id: step.id,
      order: index,
      kind: "tool",
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      label: step.label,
      status: step.status as AgentStepStatus,
      startedAt: step.startedAt,
      updatedAt: step.updatedAt,
      ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt }),
      ...(step.target === undefined ? {} : { target: step.target }),
    });
  }

  return {
    version: GENERATION_TIMELINE_VERSION,
    generationId: candidate.generationId,
    status: candidate.status as GenerationTimelineStatus,
    startedAt: candidate.startedAt,
    ...(candidate.finishedAt === undefined ? {} : { finishedAt: candidate.finishedAt }),
    steps,
  };
}

export function isTerminalAgentStep(status: AgentStepStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "blocked" || status === "cancelled"
  );
}

export function latestActiveAgentStep(timeline: GenerationTimeline | null): AgentStep | null {
  if (!timeline) return null;
  for (let index = timeline.steps.length - 1; index >= 0; index -= 1) {
    const step = timeline.steps[index];
    if (
      step &&
      (step.status === "pending" ||
        step.status === "awaiting_approval" ||
        step.status === "running")
    ) {
      return step;
    }
  }
  return null;
}
