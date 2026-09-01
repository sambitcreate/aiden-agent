import {
  GENERATION_TIMELINE_VERSION,
  isTerminalAgentStep,
  isToolStep,
  type AgentStep,
  type AgentStepStatus,
  type AgentThinkingStep,
  type AgentToolStep,
  type GenerationCancellationOrigin,
  type GenerationTimeline,
  type GenerationTimelineStatus,
} from "../../renderer/shared/generation-timeline.js";

const MAX_TOOL_NAME_LENGTH = 80;
const MAX_TARGET_LENGTH = 240;
const MAX_DETAIL_LENGTH = 120;
const MAX_LINE_CHANGE_COUNT = 100_000_000;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;

interface SafeToolDescriptor {
  label: string;
  target?: string;
  detail?: string;
}

type SafeToolIssueCode =
  | "approval-background"
  | "approval-cancelled"
  | "approval-unavailable"
  | "subagent-budget-exhausted"
  | "subagent-capability-invalid";

const SAFE_TOOL_ISSUE_DETAILS: Record<SafeToolIssueCode, string> = {
  "approval-background": "approval unavailable while the response continues in the background",
  "approval-cancelled": "cancelled before approval",
  "approval-unavailable": "approval request could not be presented; return to the chat and retry",
  "subagent-budget-exhausted": "budget exhausted; start a new parent turn with narrower tasks",
  "subagent-capability-invalid":
    "capability request was invalid; retry with the shown capability schema",
};

interface SafeToolIssueDetails {
  kind: "safe_tool_issue";
  version: 1;
  code: SafeToolIssueCode;
}

function safeLineChanges(toolName: string, value: unknown): AgentToolStep["lineChanges"] {
  if (toolName !== "write_file" && toolName !== "edit_file") return undefined;
  const details = record(value);
  if (
    details.kind !== "file_line_changes" ||
    details.version !== 1 ||
    !Number.isSafeInteger(details.additions) ||
    (details.additions as number) < 0 ||
    (details.additions as number) > MAX_LINE_CHANGE_COUNT ||
    !Number.isSafeInteger(details.deletions) ||
    (details.deletions as number) < 0 ||
    (details.deletions as number) > MAX_LINE_CHANGE_COUNT
  ) {
    return undefined;
  }
  return {
    additions: details.additions as number,
    deletions: details.deletions as number,
  };
}

function safeToolIssue(value: unknown): string | undefined {
  const details = record(value);
  if (details.kind !== "safe_tool_issue" || details.version !== 1) return undefined;
  const code = details.code;
  return typeof code === "string" && code in SAFE_TOOL_ISSUE_DETAILS
    ? SAFE_TOOL_ISSUE_DETAILS[code as SafeToolIssueCode]
    : undefined;
}

function firstToolResultText(result: unknown): string | undefined {
  const content = record(result).content;
  if (!Array.isArray(content)) return undefined;
  const item = content.find(
    (candidate) => record(candidate).type === "text" && typeof record(candidate).text === "string",
  );
  return item ? (record(item).text as string) : undefined;
}

/** Convert only recognized host failures to codes; raw result text is never persisted. */
export function safeToolIssueDetails(
  toolName: string,
  status: Extract<AgentStepStatus, "failed" | "blocked" | "cancelled">,
  result: unknown,
): SafeToolIssueDetails | undefined {
  const text = firstToolResultText(result);
  let code: SafeToolIssueCode | undefined;
  if (status === "blocked") {
    if (
      text ===
      "Approval is unavailable while this response continues in the background. Return to the chat and retry the action."
    ) {
      code = "approval-background";
    } else if (
      text ===
      "Aiden could not present the approval request. Return to the chat and retry the action."
    ) {
      code = "approval-unavailable";
    } else if (text === "The action was cancelled before approval.") {
      code = "approval-cancelled";
    }
  } else if (status === "failed" && toolName === "subagent" && text) {
    if (/Subagent (?:generation )?tree .*budget exhausted/iu.test(text)) {
      code = "subagent-budget-exhausted";
    } else if (
      /subagent .*capability request.*cannot widen/iu.test(text) ||
      /invalid subagent capability request/iu.test(text)
    ) {
      code = "subagent-capability-invalid";
    }
  }
  return code ? { kind: "safe_tool_issue", version: 1, code } : undefined;
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
      return {
        label: "Search files",
        target: path,
        detail: safeDetail(values.pattern),
      };
    case "write_file":
      return { label: "Write file", target: path };
    case "edit_file":
      return { label: "Edit file", target: path };
    case "display_image":
      return { label: "Display image", target: path };
    case "render_artifact":
      return {
        label: "Render artifact",
        detail: safeDetail(values.title),
      };
    case "run_command":
      return { label: "Run command", detail: safeDetail(values.description) };
    case "share_image":
      return { label: "Share image", target: path };
    case "web_search":
      return { label: "Web search", detail: safeDetail(values.query) };
    case "schedule_task":
      return { label: "Schedule task", detail: safeDetail(values.action) };
    case "computer_use":
      return { label: "Use Mac", detail: safeDetail(values.action) };
    case "compact_context":
      return { label: "Compact context" };
    case "ask_user_question":
      return { label: "Ask a question" };
    case "todo":
      return { label: "Update task list" };
    default:
      return { label: titleCaseToolName(toolName) || "Use tool" };
  }
}

export class GenerationTimelineProjector {
  private readonly timeline: GenerationTimeline;
  private readonly stepIndex = new Map<string, number>();
  private toolSequence = 0;
  private thinkingSequence = 0;
  private compactionSequence = 0;
  private contentOffset = 0;
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
    if (this.timeline.status !== "running") return;
    const existingIndex = this.stepIndex.get(toolCallId);
    if (existingIndex !== undefined) {
      // An early pending step (opened at toolcall_start, before arguments
      // resolve) adopts the full descriptor once execution supplies real args.
      const step = this.timeline.steps[existingIndex];
      if (step && isToolStep(step) && !isTerminalAgentStep(step.status)) {
        const descriptor = safeToolDescriptor(toolName, args);
        const timestamp = this.now();
        step.toolName = safeToolName(toolName);
        step.label = descriptor.label;
        if (descriptor.target) step.target = descriptor.target;
        else delete step.target;
        if (descriptor.detail) step.detail = descriptor.detail;
        else delete step.detail;
        step.updatedAt = timestamp;
        this.emit();
      }
      return;
    }
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
      contentOffset: this.contentOffset,
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
    if (last && !isToolStep(last) && last.contentOffset === this.contentOffset) {
      // The stretch reopened on the merged thinking step: mark it open again so
      // the live timeline reflects reasoning in progress.
      delete last.finishedAt;
      last.updatedAt = timestamp;
      this.openThinking = {
        index: this.timeline.steps.length - 1,
        startedAt: timestamp,
      };
      this.emit();
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
      contentOffset: this.contentOffset,
    };
    this.openThinking = {
      index: this.timeline.steps.length,
      startedAt: timestamp,
    };
    this.timeline.steps.push(step);
    this.emit();
  }

  thinkingEnded(): void {
    if (this.timeline.status !== "running" || !this.openThinking) return;
    this.settleThinking(this.now());
    this.emit();
  }

  compactionStarted(): string {
    this.compactionSequence += 1;
    const id = `pi-compaction-${this.compactionSequence}`;
    this.toolStarted(id, "compact_context", {});
    this.toolRunning(id);
    return id;
  }

  compactionFinished(
    id: string,
    status: Extract<AgentStepStatus, "completed" | "failed" | "cancelled">,
  ): void {
    this.toolFinished(id, status);
  }

  /** Keep future activity anchored to the current visible assistant text. */
  setContentOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) return;
    this.contentOffset = offset;
  }

  /**
   * Terminal Pi content can replace a streamed assistant turn. Clamp activity
   * that was observed beyond the canonical turn end before anchoring later work.
   */
  reconcileContentOffset(turnStart: number, turnEnd: number): void {
    if (
      !Number.isSafeInteger(turnStart) ||
      turnStart < 0 ||
      !Number.isSafeInteger(turnEnd) ||
      turnEnd < turnStart
    ) {
      return;
    }
    let changed = false;
    for (const step of this.timeline.steps) {
      if (
        step.contentOffset !== undefined &&
        step.contentOffset >= turnStart &&
        step.contentOffset > turnEnd
      ) {
        step.contentOffset = turnEnd;
        changed = true;
      }
    }
    this.contentOffset = turnEnd;
    if (changed) this.emit();
  }

  /** Compact-and-retry removes failed prose but keeps its activity at the retry boundary. */
  rewindContentOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) return;
    let changed = false;
    for (const step of this.timeline.steps) {
      if (step.contentOffset !== undefined && step.contentOffset > offset) {
        step.contentOffset = offset;
        changed = true;
      }
    }
    this.contentOffset = offset;
    if (changed) this.emit();
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
    resultDetails?: unknown,
  ): void {
    this.updateTool(toolCallId, status, true, resultDetails);
  }

  finish(
    status: Exclude<GenerationTimelineStatus, "running">,
    cancellationOrigin?: GenerationCancellationOrigin,
  ): GenerationTimeline {
    if (this.timeline.status === "running") {
      const timestamp = this.now();
      this.settleThinking(timestamp);
      this.timeline.status = status;
      if (status === "cancelled" && cancellationOrigin) {
        this.timeline.cancellationOrigin = cancellationOrigin;
      }
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

  private updateTool(
    toolCallId: string,
    status: AgentStepStatus,
    terminal = false,
    resultDetails?: unknown,
  ): void {
    if (this.timeline.status !== "running") return;
    const index = this.stepIndex.get(toolCallId);
    if (index === undefined) return;
    const step = this.timeline.steps[index];
    if (!step || !isToolStep(step) || isTerminalAgentStep(step.status)) return;
    // Pi can emit many tool_execution_update ticks while a tool is already
    // running. Republishing the full timeline on each tick would copy the
    // whole step list over IPC and into the Remote SSE journal without
    // changing anything the activity feed can show.
    if (!terminal && step.status === status) return;
    const timestamp = this.now();
    step.status = status;
    step.updatedAt = timestamp;
    if (terminal) {
      step.finishedAt = timestamp;
      if (status === "completed") {
        const lineChanges = safeLineChanges(step.toolName, resultDetails);
        if (lineChanges) step.lineChanges = lineChanges;
      } else {
        const issue = safeToolIssue(resultDetails);
        if (issue) step.detail = issue;
      }
    }
    this.emit();
  }

  private emit(): void {
    this.publish(this.snapshot());
  }
}
