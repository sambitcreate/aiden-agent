import { parseProducedFile } from "./produced-file.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  parseAskUserQuestionRecap,
  type AskUserQuestionRecapV1,
} from "./ask-user-question.js";
import { WEB_FETCH_TOOL_NAME, parseWebExtractRecap, type WebExtractRecapV1 } from "./web-extract.js";
import {
  BROWSER_RECORDING_STOP_TOOL_NAME,
  parseBrowserRecordingRecap,
  type BrowserRecordingRecapV1,
} from "./browser-recording.js";
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
  producedFile?: import("./produced-file.js").ProducedFile;
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
  /**
   * What the owner chose in a settled `ask_user_question` card. Present only
   * on a completed step of that tool, so the transcript can show the questions
   * and answers in place of the generic activity line.
   */
  questionnaire?: AskUserQuestionRecapV1;
  /**
   * The values a completed `web_fetch` extract call read, each with the page
   * line it came from. Display-only; never the page or the request.
   */
  extraction?: WebExtractRecapV1;
  /**
   * The video a completed `browser_recording_stop` saved: its id, type, length
   * and size. Display-only; the bytes are read from the Mac by id.
   */
  recording?: BrowserRecordingRecapV1;
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
  /** UTF-16 offsets into the separately exposed, readable reasoning text. */
  reasoningStartOffset?: number;
  reasoningEndOffset?: number;
  /** Wall-clock reasoning time measured by the host; pi reports no duration. */
  durationMs?: number;
}

export type AgentStep = AgentToolStep | AgentThinkingStep;

export type GenerationTimelineStatus = "running" | "completed" | "failed" | "cancelled";

export const GENERATION_CANCELLATION_ORIGINS = [
  "user_stop",
  "chat_deletion",
  "workspace_authority_change",
  "computer_use_disabled",
  "scheduled_task_cancel",
  "application_shutdown",
] as const;

export type GenerationCancellationOrigin = (typeof GENERATION_CANCELLATION_ORIGINS)[number];

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
  /** Content-free first-writer-wins provenance for an actual app cancellation. */
  cancellationOrigin?: GenerationCancellationOrigin;
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
const CANCELLATION_ORIGINS = new Set<GenerationCancellationOrigin>(
  GENERATION_CANCELLATION_ORIGINS,
);
const SAFE_ID = /^[a-z0-9._:-]+$/iu;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;
const MAX_DETAIL_LENGTH = 120;
const MAX_LINE_CHANGE_COUNT = 100_000_000;
/** Every reader (chat storage, Aiden Remote, iOS, Android) rejects a longer timeline. */
export const MAX_GENERATION_TIMELINE_STEPS = 200;

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
  const producedFile = parseProducedFile(step.producedFile, String(step.toolName));
  const questionnaire =
    step.questionnaire === undefined ? undefined : parseAskUserQuestionRecap(step.questionnaire);
  const extraction =
    step.extraction === undefined ? undefined : parseWebExtractRecap(step.extraction);
  const recording =
    step.recording === undefined ? undefined : parseBrowserRecordingRecap(step.recording);
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
    (step.producedFile !== undefined && (!producedFile || step.status !== "completed")) ||
    (step.target !== undefined && !safeStoredTarget(step.target)) ||
    (step.detail !== undefined && !safeStoredDetail(step.detail)) ||
    (step.questionnaire !== undefined &&
      (!allowLineChanges ||
        !questionnaire ||
        step.toolName !== ASK_USER_QUESTION_TOOL_NAME ||
        step.status !== "completed")) ||
    (step.extraction !== undefined &&
      (!allowLineChanges ||
        !extraction ||
        step.toolName !== WEB_FETCH_TOOL_NAME ||
        step.status !== "completed")) ||
    (step.recording !== undefined &&
      (!allowLineChanges ||
        !recording ||
        step.toolName !== BROWSER_RECORDING_STOP_TOOL_NAME ||
        step.status !== "completed")) ||
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
    ...(producedFile ? { producedFile } : {}),
    ...(step.detail === undefined ? {} : { detail: step.detail as string }),
    ...(questionnaire ? { questionnaire } : {}),
    ...(extraction ? { extraction } : {}),
    ...(recording ? { recording } : {}),
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
    ...(step.reasoningStartOffset === undefined
      ? {}
      : { reasoningStartOffset: step.reasoningStartOffset as number }),
    ...(step.reasoningEndOffset === undefined
      ? {}
      : { reasoningEndOffset: step.reasoningEndOffset as number }),
    ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs as number }),
  };
}

/** Validate the renderer-safe subset before replaying a timeline from local chat storage. */
export function parseGenerationTimeline(
  value: unknown,
  contentLength?: number,
  reasoningLength?: number,
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
    candidate.steps.length > MAX_GENERATION_TIMELINE_STEPS
  ) {
    return undefined;
  }
  if (
    candidate.cancellationOrigin !== undefined &&
    (candidate.status !== "cancelled" ||
      typeof candidate.cancellationOrigin !== "string" ||
      !CANCELLATION_ORIGINS.has(candidate.cancellationOrigin as GenerationCancellationOrigin))
  ) {
    return undefined;
  }

  const steps: AgentStep[] = [];
  let previousContentOffset = 0;
  let previousReasoningEndOffset = 0;
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
    if (step.kind === "thinking" && candidate.version === GENERATION_TIMELINE_VERSION) {
      const start = step.reasoningStartOffset;
      const end = step.reasoningEndOffset;
      if (
        (start !== undefined &&
          (!Number.isSafeInteger(start) ||
            (start as number) < previousReasoningEndOffset ||
            (reasoningLength !== undefined && (start as number) > reasoningLength))) ||
        (end !== undefined &&
          (start === undefined ||
            !Number.isSafeInteger(end) ||
            (end as number) < (start as number) ||
            (reasoningLength !== undefined && (end as number) > reasoningLength))) ||
        (end === undefined && start !== undefined && step.finishedAt !== undefined)
      ) return undefined;
      if (end !== undefined) previousReasoningEndOffset = end as number;
    } else if (candidate.version !== GENERATION_TIMELINE_VERSION &&
      (step.reasoningStartOffset !== undefined || step.reasoningEndOffset !== undefined)) {
      return undefined;
    }
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
    ...(candidate.cancellationOrigin === undefined
      ? {}
      : { cancellationOrigin: candidate.cancellationOrigin as GenerationCancellationOrigin }),
    ...(claimCheck ? { claimCheck } : {}),
  };
}

/** The newest steps are kept exact while older ones can still fold. */
const BOUND_KEPT_TAIL = 40;

/** Calls whose row carries nothing beyond its line and that change nothing. */
const ROUTINE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "web_search",
  "browser_status",
  "browser_snapshot",
  "browser_wait_for",
  "browser_scroll",
]);

/** Calls other rows point at (images and visuals are placed after them). */
const ANCHOR_TOOLS = new Set([
  "display_image",
  "share_image",
  "generate_image",
  "render_artifact",
  "render_ui",
]);

function carriesRecap(step: AgentToolStep): boolean {
  return Boolean(step.producedFile || step.lineChanges || step.questionnaire || step.extraction);
}

/** Lower drops first; Infinity never drops. */
function foldRank(step: AgentStep): number {
  if (!isToolStep(step)) return Infinity;
  if (!isTerminalAgentStep(step.status)) return Infinity;
  // Subagent chips sit on their row, and phones fetch only recordings a saved step names.
  if (step.toolName === "subagent" || step.recording) return Infinity;
  if (step.status !== "completed") return 3;
  if (ROUTINE_TOOLS.has(step.toolName) && !carriesRecap(step)) return 0;
  if (!ANCHOR_TOOLS.has(step.toolName) && !carriesRecap(step)) return 1;
  return 2;
}

function mergeThinking(steps: readonly AgentThinkingStep[]): AgentThinkingStep {
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  const start = steps.find((step) => step.reasoningStartOffset !== undefined)?.reasoningStartOffset;
  const end = [...steps].reverse().find((step) => step.reasoningEndOffset !== undefined)
    ?.reasoningEndOffset;
  const merged: AgentThinkingStep = {
    ...first,
    updatedAt: Math.max(...steps.map((step) => step.updatedAt)),
    durationMs: steps.reduce((total, step) => total + (step.durationMs ?? 0), 0),
  };
  if (last.finishedAt === undefined) delete merged.finishedAt;
  else merged.finishedAt = last.finishedAt;
  delete merged.reasoningStartOffset;
  delete merged.reasoningEndOffset;
  if (start !== undefined && end !== undefined) {
    merged.reasoningStartOffset = start;
    merged.reasoningEndOffset = end;
  }
  return merged;
}

/** What a bounded timeline already folded, so later updates never bring a step back. */
export interface GenerationTimelineFolds {
  dropped: Set<string>;
  /** A thinking step's id, mapped to the earlier thinking step it joined. */
  mergedInto: Map<string, string>;
}

export function emptyGenerationTimelineFolds(): GenerationTimelineFolds {
  return { dropped: new Set(), mergedInto: new Map() };
}

function isFinishedThinking(step: AgentStep | undefined): step is AgentThinkingStep {
  return Boolean(step && !isToolStep(step) && step.finishedAt !== undefined);
}

function sharesActivityRow(a: AgentStep | undefined, b: AgentStep | undefined): boolean {
  return Boolean(
    a && b && isToolStep(a) && isToolStep(b) && !a.questionnaire && !b.questionnaire &&
      a.contentOffset === b.contentOffset,
  );
}

/**
 * Whether dropping `list[index]` leaves the rest of the reply where it was:
 * the reply text on either side stays split at the same place, and a row
 * holding an image or visual keeps its first step (the row's identity).
 */
function canDrop(list: readonly AgentStep[], index: number): boolean {
  const step = list[index]!;
  const before = index > 0 ? list[index - 1]!.contentOffset : 0;
  if (before !== step.contentOffset && list[index + 1]?.contentOffset !== step.contentOffset) {
    return false;
  }
  if (sharesActivityRow(list[index - 1], step)) return true;
  for (let next = index + 1; sharesActivityRow(list[next - 1], list[next]); next += 1) {
    const later = list[next] as AgentToolStep;
    if (ANCHOR_TOOLS.has(later.toolName) || later.toolName === "subagent") return false;
  }
  return true;
}

/**
 * Keep a long run's timeline within what every reader accepts. Older settled
 * tool steps drop, oldest first: read-only calls, then plain calls, then calls
 * that carry a recap or anchor an image, then failed ones. When a drop leaves
 * two finished thoughts side by side they join, so every thought stays where
 * it happened and its reasoning stays shown. A drop never moves reply text or
 * an image. The newest `BOUND_KEPT_TAIL` steps fold only when nothing older
 * can, and running steps never do. `folds` remembers each decision: pass the
 * same object on every update of one run so a folded step stays folded.
 */
export function boundGenerationTimelineSteps(
  steps: readonly AgentStep[],
  folds: GenerationTimelineFolds = emptyGenerationTimelineFolds(),
  max = MAX_GENERATION_TIMELINE_STEPS,
): AgentStep[] {
  if (steps.length <= max && folds.dropped.size === 0 && folds.mergedInto.size === 0) {
    return [...steps];
  }
  const rootOf = (id: string): string => {
    let root = id;
    while (folds.mergedInto.has(root)) root = folds.mergedInto.get(root)!;
    return root;
  };
  const groups = new Map<string, AgentThinkingStep[]>();
  const list: AgentStep[] = [];
  for (const step of steps) {
    if (folds.dropped.has(step.id)) continue;
    const root = rootOf(step.id);
    if (root !== step.id) {
      groups.get(root)?.push(step as AgentThinkingStep);
      continue;
    }
    if (!isToolStep(step)) groups.set(step.id, [step]);
    list.push(step);
  }
  for (let index = 0; index < list.length; index += 1) {
    const group = groups.get(list[index]!.id);
    if (group && group.length > 1) list[index] = mergeThinking(group);
  }

  for (const keepTail of [true, false]) {
    for (let rank = 0; rank <= 3 && list.length > max; rank += 1) {
      for (let index = 0; list.length > max && index < list.length - (keepTail ? BOUND_KEPT_TAIL : 0);) {
        const step = list[index]!;
        if (foldRank(step) !== rank || !canDrop(list, index)) {
          index += 1;
          continue;
        }
        folds.dropped.add(step.id);
        list.splice(index, 1);
        const earlier = list[index - 1];
        const later = list[index];
        if (
          isFinishedThinking(earlier) &&
          isFinishedThinking(later) &&
          earlier.contentOffset === later.contentOffset
        ) {
          const group = [...(groups.get(earlier.id) ?? [earlier]), ...(groups.get(later.id) ?? [later])];
          groups.set(earlier.id, group);
          groups.delete(later.id);
          folds.mergedInto.set(later.id, earlier.id);
          list[index - 1] = mergeThinking(group);
          list.splice(index, 1);
        }
      }
    }
  }

  return list.map((step, order) => (step.order === order ? step : { ...step, order }));
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

/** True while the model is inside a reasoning block, per the host timeline. */
export function hasActiveThinkingStep(timeline: GenerationTimeline | null): boolean {
  if (!timeline || timeline.status !== "running") return false;
  for (let index = timeline.steps.length - 1; index >= 0; index -= 1) {
    const step = timeline.steps[index];
    if (!step) continue;
    if (isToolStep(step)) return false;
    return step.finishedAt === undefined;
  }
  return false;
}

/** True while any call of the named tool is pending approval or executing. */
export function hasActiveToolStep(timeline: GenerationTimeline | null, toolName: string): boolean {
  if (!timeline || timeline.status !== "running") return false;
  return timeline.steps.some(
    (step) =>
      isToolStep(step) &&
      step.toolName === toolName &&
      (step.status === "pending" ||
        step.status === "awaiting_approval" ||
        step.status === "running"),
  );
}
