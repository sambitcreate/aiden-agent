import {
  GENERATION_TIMELINE_VERSION,
  isTerminalAgentStep,
  type AgentStepStatus,
  type AgentToolStep,
  type GenerationTimeline,
  type GenerationTimelineStatus,
} from "../../renderer/shared/generation-timeline.js";

const MAX_TOOL_NAME_LENGTH = 80;
const MAX_TARGET_LENGTH = 240;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;

interface SafeToolDescriptor {
  label: string;
  target?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function safeToolName(value: string): string {
  const cleaned = value
    .replace(/[^\p{L}\p{N}_:.-]+/gu, " ")
    .trim()
    .slice(0, MAX_TOOL_NAME_LENGTH);
  return cleaned || "tool";
}

function safeRelativeTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value.replace(/\\/gu, "/"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("")
    .trim();
  if (
    !cleaned ||
    cleaned.startsWith("/") ||
    cleaned.startsWith("~") ||
    WINDOWS_ABSOLUTE_PATH.test(cleaned)
  ) {
    return undefined;
  }
  const segments = cleaned.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) return undefined;
  return segments.join("/").slice(0, MAX_TARGET_LENGTH) || undefined;
}

function titleCaseToolName(toolName: string): string {
  return safeToolName(toolName)
    .split(/[_:.-]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function safeToolDescriptor(toolName: string, args: unknown): SafeToolDescriptor {
  const values = record(args);
  const path = safeRelativeTarget(values.path ?? values.filePath ?? values.directory);
  switch (toolName) {
    case "read_file":
      return { label: "Read file", target: path };
    case "list_dir":
      return { label: "List directory", target: path };
    case "glob":
      return { label: "Find files", target: path };
    case "grep":
      return { label: "Search files", target: path };
    case "write_file":
      return { label: "Write file", target: path };
    case "edit_file":
      return { label: "Edit file", target: path };
    case "run_command":
      return { label: "Run command" };
    case "computer_use":
      return { label: "Use Mac" };
    default:
      return { label: titleCaseToolName(toolName) || "Use tool" };
  }
}

export class GenerationTimelineProjector {
  private readonly timeline: GenerationTimeline;
  private readonly stepIndex = new Map<string, number>();

  constructor(
    generationId: string,
    private readonly publish: (timeline: GenerationTimeline) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.timeline = {
      version: GENERATION_TIMELINE_VERSION,
      generationId,
      status: "running",
      startedAt: this.now(),
      steps: [],
    };
  }

  toolStarted(toolCallId: string, toolName: string, args: unknown): void {
    if (this.timeline.status !== "running" || this.stepIndex.has(toolCallId)) return;
    const timestamp = this.now();
    const descriptor = safeToolDescriptor(toolName, args);
    const sequence = this.timeline.steps.length + 1;
    const step: AgentToolStep = {
      id: `tool-${sequence}`,
      order: this.timeline.steps.length,
      kind: "tool",
      toolCallId: `call-${sequence}`,
      toolName: safeToolName(toolName),
      label: descriptor.label,
      status: "pending",
      startedAt: timestamp,
      updatedAt: timestamp,
      ...(descriptor.target ? { target: descriptor.target } : {}),
    };
    this.stepIndex.set(toolCallId, this.timeline.steps.length);
    this.timeline.steps.push(step);
    this.emit();
  }

  publicToolCallId(toolCallId: string): string | undefined {
    const index = this.stepIndex.get(toolCallId);
    return index === undefined ? undefined : this.timeline.steps[index]?.toolCallId;
  }

  toolAwaitingApproval(toolCallId: string): void {
    this.updateTool(toolCallId, "awaiting_approval");
  }

  toolRunning(toolCallId: string): void {
    this.updateTool(toolCallId, "running");
  }

  toolFinished(
    toolCallId: string,
    status: Extract<AgentStepStatus, "completed" | "failed" | "blocked" | "cancelled">,
  ): void {
    this.updateTool(toolCallId, status, true);
  }

  finish(status: Exclude<GenerationTimelineStatus, "running">): GenerationTimeline {
    if (this.timeline.status === "running") {
      const timestamp = this.now();
      this.timeline.status = status;
      this.timeline.finishedAt = timestamp;
      for (const step of this.timeline.steps) {
        if (
          step.status === "pending" ||
          step.status === "awaiting_approval" ||
          step.status === "running"
        ) {
          step.status = status === "cancelled" ? "cancelled" : "failed";
          step.updatedAt = timestamp;
          step.finishedAt = timestamp;
        }
      }
      this.emit();
    }
    return this.snapshot();
  }

  snapshot(): GenerationTimeline {
    return {
      ...this.timeline,
      steps: this.timeline.steps.map((step) => ({ ...step })),
    };
  }

  private updateTool(toolCallId: string, status: AgentStepStatus, terminal = false): void {
    if (this.timeline.status !== "running") return;
    const index = this.stepIndex.get(toolCallId);
    if (index === undefined) return;
    const step = this.timeline.steps[index];
    if (!step || isTerminalAgentStep(step.status)) return;
    const timestamp = this.now();
    step.status = status;
    step.updatedAt = timestamp;
    if (terminal) step.finishedAt = timestamp;
    this.emit();
  }

  private emit(): void {
    this.publish(this.snapshot());
  }
}
