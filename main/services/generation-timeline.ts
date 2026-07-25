import {
  GENERATION_TIMELINE_VERSION,
  isTerminalAgentStep,
  isToolStep,
  type AgentStep,
  type AgentStepStatus,
  type AgentThinkingStep,
  type AgentToolStep,
  type GenerationTimeline,
  type GenerationTimelineStatus,
} from "../../renderer/shared/generation-timeline.js";

const MAX_TOOL_NAME_LENGTH = 80;
const MAX_TARGET_LENGTH = 240;
const MAX_DETAIL_LENGTH = 120;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;

interface SafeToolDescriptor {
  label: string;
  target?: string;
  detail?: string;
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

/**
 * Collapse a model-authored value to one printable feed line. Callers decide
 * per tool which arguments are eligible; raw shell commands and file contents
 * never are.
 */
function safeDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DETAIL_LENGTH)
    .trim();
  return cleaned || undefined;
}

function titleCaseToolName(toolName: string): string {
  return safeToolName(toolName)
    .split(/[_:.-]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Project a tool call onto the renderer-safe fields the activity feed reads.
 * `detail` is opt-in per tool: patterns and queries the model authored for
 * display are eligible, shell commands and file contents never are. A command
 * shows the model's own `description` argument instead of the command itself.
 */
export function safeToolDescriptor(toolName: string, args: unknown): SafeToolDescriptor {
  const values = record(args);
  const path = safeRelativeTarget(values.path ?? values.filePath ?? values.directory);
  switch (toolName) {
    case "read_file":
      return { label: "Read file", target: path };
    case "list_dir":
      return { label: "List directory", target: path };
    case "glob":
      return { label: "Find files", detail: safeDetail(values.pattern) };
    case "grep":
      return { label: "Search files", target: path, detail: safeDetail(values.pattern) };
    case "write_file":
      return { label: "Write file", target: path };
    case "edit_file":
      return { label: "Edit file", target: path };
    case "run_command":
      return { label: "Run command", detail: safeDetail(values.description) };
    case "web_search":
      return { label: "Web search", detail: safeDetail(values.query) };
    case "schedule_task":
      return { label: "Schedule task", detail: safeDetail(values.action) };
    case "computer_use":
      return { label: "Use Mac", detail: safeDetail(values.action) };
    default:
      return { label: titleCaseToolName(toolName) || "Use tool" };
  }
}

export class GenerationTimelineProjector {
  private readonly timeline: GenerationTimeline;
  private readonly stepIndex = new Map<string, number>();
  private toolSequence = 0;
  private thinkingSequence = 0;
  private openThinking: { index: number; startedAt: number } | null = null;

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
    this.toolSequence += 1;
    const step: AgentToolStep = {
      id: `tool-${this.toolSequence}`,
      order: this.timeline.steps.length,
      kind: "tool",
      toolCallId: `call-${this.toolSequence}`,
      toolName: safeToolName(toolName),
      label: descriptor.label,
      status: "pending",
      startedAt: timestamp,
      updatedAt: timestamp,
      ...(descriptor.target ? { target: descriptor.target } : {}),
      ...(descriptor.detail ? { detail: descriptor.detail } : {}),
    };
    this.stepIndex.set(toolCallId, this.timeline.steps.length);
    this.timeline.steps.push(step);
    this.emit();
  }

  /**
   * Pi reports no reasoning duration, so consecutive reasoning blocks are
   * merged into the single stretch of thinking the user actually perceives and
   * timed against the host clock.
   */
  thinkingStarted(): void {
    if (this.timeline.status !== "running" || this.openThinking) return;
    const timestamp = this.now();
    const last = this.timeline.steps[this.timeline.steps.length - 1];
    if (last && !isToolStep(last)) {
      this.openThinking = { index: this.timeline.steps.length - 1, startedAt: timestamp };
      return;
    }
    this.thinkingSequence += 1;
    const step: AgentThinkingStep = {
      id: `think-${this.thinkingSequence}`,
      order: this.timeline.steps.length,
      kind: "thinking",
      startedAt: timestamp,
      updatedAt: timestamp,
      durationMs: 0,
    };
    this.openThinking = { index: this.timeline.steps.length, startedAt: timestamp };
    this.timeline.steps.push(step);
    this.emit();
  }

  thinkingEnded(): void {
    if (this.timeline.status !== "running" || !this.openThinking) return;
    this.settleThinking(this.now());
    this.emit();
  }

  publicToolCallId(toolCallId: string): string | undefined {
    const index = this.stepIndex.get(toolCallId);
    if (index === undefined) return undefined;
    const step = this.timeline.steps[index];
    return step && isToolStep(step) ? step.toolCallId : undefined;
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
      this.settleThinking(timestamp);
      this.timeline.status = status;
      this.timeline.finishedAt = timestamp;
      for (const step of this.timeline.steps) {
        if (
          isToolStep(step) &&
          (step.status === "pending" ||
            step.status === "awaiting_approval" ||
            step.status === "running")
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
      steps: this.timeline.steps.map((step) => ({ ...step }) as AgentStep),
    };
  }

  private settleThinking(timestamp: number): void {
    const open = this.openThinking;
    if (!open) return;
    this.openThinking = null;
    const step = this.timeline.steps[open.index];
    if (!step || isToolStep(step)) return;
    step.durationMs = (step.durationMs ?? 0) + Math.max(0, timestamp - open.startedAt);
    step.updatedAt = timestamp;
    step.finishedAt = timestamp;
  }

  private updateTool(toolCallId: string, status: AgentStepStatus, terminal = false): void {
    if (this.timeline.status !== "running") return;
    const index = this.stepIndex.get(toolCallId);
    if (index === undefined) return;
    const step = this.timeline.steps[index];
    if (!step || !isToolStep(step) || isTerminalAgentStep(step.status)) return;
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
