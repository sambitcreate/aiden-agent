import type { ApprovalPrompt } from "./ipc";
import { isExtractionStep, isQuestionnaireStep, isRecordingStep } from "./assistant-message-presentation";
import {
  isSubagentMcpMutationApprovalDetails,
  isSubagentRunGrantApprovalDetails,
  isSubagentShellApprovalDetails,
  isSubagentWorkspaceWriteApprovalDetails,
} from "../shared/assistant";
import {
  GENERATION_TIMELINE_VERSION,
  isToolStep,
  type GenerationTimeline,
  type GenerationTimelineStatus,
} from "../shared/generation-timeline";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import {
  mergeSubagentTranscript,
  type LiveSubagentTranscripts,
  type MergedSubagentTranscript,
  type SubagentTranscriptMessageEntry,
  type SubagentTranscriptV1,
} from "../shared/subagent-transcript";

/** The status dot's colour family. */
export type SubagentHelperTone = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";

export function subagentHelperTone(state: SubagentRunSnapshot["state"]): SubagentHelperTone {
  switch (state) {
    case "queued":
    case "starting":
      return "queued";
    case "running":
      return "running";
    case "needs_attention":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
    case "timed_out":
      return "failed";
    default:
      return "stopped";
  }
}

/**
 * The status dot for each tone. Queued is a hollow neutral ring and stopped a
 * solid tertiary dot, so the two read apart without relying on colour.
 */
export const SUBAGENT_HELPER_TONE_DOT: Record<SubagentHelperTone, string> = {
  queued: "bg-transparent ring-[1.5px] ring-inset ring-secondary",
  running: "bg-status-accent motion-safe:animate-pulse",
  waiting: "bg-status-warning",
  done: "bg-status-green",
  failed: "bg-status-red",
  stopped: "bg-tertiary",
};

export function subagentHelperIsActive(state: SubagentRunSnapshot["state"]): boolean {
  return (
    state === "queued" || state === "starting" || state === "running" || state === "needs_attention"
  );
}

/** A window keeps the saved transcripts it has read for at most this many helpers. */
export const MAX_SAVED_SUBAGENT_HELPER_TRANSCRIPTS = 32;

export type SavedSubagentHelperTranscripts = ReadonlyMap<string, SubagentTranscriptV1>;

/**
 * Keep the newest copy of a saved transcript. Returns the same map when the
 * copy is not newer, so callers can skip a render.
 */
export function rememberSubagentHelperTranscript(
  saved: SavedSubagentHelperTranscripts,
  transcript: SubagentTranscriptV1,
): SavedSubagentHelperTranscripts {
  const current = saved.get(transcript.runId);
  if (current && current.revision >= transcript.revision) return saved;
  const next = new Map(saved);
  next.delete(transcript.runId);
  next.set(transcript.runId, transcript);
  while (next.size > MAX_SAVED_SUBAGENT_HELPER_TRANSCRIPTS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/** The saved copy merged with the live updates for one helper. */
export function subagentHelperTranscript(
  runId: string,
  saved: SavedSubagentHelperTranscripts,
  live: LiveSubagentTranscripts | undefined,
): MergedSubagentTranscript {
  return mergeSubagentTranscript(saved.get(runId), live?.get(runId));
}

export interface SubagentHelperWorkSummary {
  /** Tool steps the helper took, finished or not. */
  steps: number;
  /** Workspace-relative files it changed, in first-change order. */
  changedFiles: string[];
}

export function subagentHelperWorkSummary(
  transcript: SubagentTranscriptV1 | null | undefined,
): SubagentHelperWorkSummary {
  let steps = 0;
  const changed = new Set<string>();
  for (const entry of transcript?.entries ?? []) {
    if (entry.kind !== "message") continue;
    for (const step of entry.steps) {
      if (!isToolStep(step)) continue;
      steps += 1;
      if (step.lineChanges && step.target) changed.add(step.target);
    }
  }
  return { steps, changedFiles: [...changed] };
}

function stepCount(steps: number): string {
  return `${steps} ${steps === 1 ? "step" : "steps"}`;
}

function fileList(files: readonly string[]): string {
  if (files.length === 1) return files[0]!;
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  return `${files[0]}, ${files[1]} and ${files.length - 2} more`;
}

/**
 * Host fallbacks that only restate that the helper did not finish. They add
 * nothing after "This helper couldn't finish.", so they are not shown.
 */
const GENERIC_FAILURES = new Set([
  "this helper couldn't finish.",
  "the child could not complete this task.",
  "the child model could not complete this task.",
]);

function failureReason(error: string | undefined): string | null {
  const text = error?.trim().replace(/\s+/gu, " ");
  if (!text || GENERIC_FAILURES.has(text.toLocaleLowerCase())) return null;
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

export interface SubagentHelperProblem {
  tone: "stopped" | "failed";
  text: string;
  /** The ready-made message Ask main chat to retry puts in the composer. */
  retryText: string;
}

/**
 * One plain explanation for a helper that ended without finishing, or null.
 * A trimmed transcript has lost its oldest steps, so the step count comes from
 * the run record and nothing is claimed about files it no longer shows.
 */
export function subagentHelperProblem(
  run: Pick<SubagentRunSnapshot, "state" | "label" | "error" | "tools">,
  summary: SubagentHelperWorkSummary,
  options: { trimmed?: boolean } = {},
): SubagentHelperProblem | null {
  const tone = subagentHelperTone(run.state);
  if (tone !== "stopped" && tone !== "failed") return null;
  const trimmed = options.trimmed === true;
  const steps = trimmed ? Math.max(summary.steps, run.tools) : summary.steps;
  const after = steps > 0 ? ` after ${stepCount(steps)}` : "";
  const files = summary.changedFiles;
  const changedSentence = files.length
    ? ` It changed ${fileList(files)}.`
    : trimmed
      ? ""
      : " It didn't change any files.";
  const changedClause = files.length
    ? ` and changed ${fileList(files)}`
    : trimmed
      ? ""
      : " and didn't change any files";
  let text: string;
  let outcome: string;
  if (run.state === "stopped") {
    text = `You stopped this helper${after}.`;
    outcome = "It was stopped";
  } else if (run.state === "timed_out") {
    text = `This helper ran out of time${after}.`;
    outcome = "It timed out";
  } else if (tone === "failed") {
    const reason = failureReason(run.error);
    text = reason ? `This helper couldn't finish. ${reason}` : "This helper couldn't finish.";
    outcome = "It failed";
  } else {
    text = `This helper stopped early${after}.`;
    outcome = "It was stopped";
  }
  return {
    tone,
    text: `${text}${changedSentence}`,
    retryText: `Please retry the helper \u201c${run.label}\u201d. ${outcome}${after}${changedClause}.`,
  };
}

/**
 * The pending approval that belongs to this helper. A run grant names its
 * run; the other kinds name only the helper's label, so they match only when
 * no other active helper shares it.
 */
export function subagentHelperApprovalFor(
  run: Pick<SubagentRunSnapshot, "runId" | "label">,
  approvals: readonly ApprovalPrompt[],
  activeRuns: ReadonlyArray<Pick<SubagentRunSnapshot, "runId" | "label">>,
): ApprovalPrompt | null {
  const labelUnique =
    activeRuns.filter((other) => other.label === run.label && other.runId !== run.runId).length ===
    0;
  for (const approval of approvals) {
    const details = approval.details;
    if (isSubagentRunGrantApprovalDetails(details)) {
      if (details.runId === run.runId) return approval;
      continue;
    }
    if (
      (isSubagentWorkspaceWriteApprovalDetails(details) ||
        isSubagentShellApprovalDetails(details) ||
        isSubagentMcpMutationApprovalDetails(details)) &&
      labelUnique &&
      details.childLabel === run.label
    ) {
      return approval;
    }
  }
  return null;
}

/** A timeline for one helper message, so the main chat's step rows can draw it. */
export function subagentHelperTimeline(
  runId: string,
  index: number,
  entry: SubagentTranscriptMessageEntry,
  runState: SubagentRunSnapshot["state"],
): GenerationTimeline {
  let status: GenerationTimelineStatus;
  if (entry.finishedAt === undefined && subagentHelperIsActive(runState)) status = "running";
  else if (entry.finishedAt !== undefined) status = "completed";
  else {
    const tone = subagentHelperTone(runState);
    status = tone === "failed" ? "failed" : tone === "stopped" ? "cancelled" : "completed";
  }
  return {
    version: GENERATION_TIMELINE_VERSION,
    generationId: `${runId}:${index}`,
    status,
    startedAt: entry.startedAt,
    ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
    steps: entry.steps.filter(isToolStep),
  };
}

/** One row of a helper chat: the task, or a message that may stand for several. */
export type SubagentHelperBlock =
  | { kind: "task"; key: string; text: string }
  | {
      kind: "message";
      key: string;
      /** The first transcript entry this block stands for. */
      index: number;
      entry: SubagentTranscriptMessageEntry;
    };

function isToolOnlyMessage(entry: SubagentTranscriptMessageEntry): boolean {
  if (entry.text.trim()) return false;
  const tools = entry.steps.filter(isToolStep);
  return (
    tools.length > 0 &&
    !tools.some((step) => isExtractionStep(step) || isRecordingStep(step) || isQuestionnaireStep(step))
  );
}

/**
 * The rows a helper chat draws. Back-to-back messages that only ran tools
 * become one message, so their steps read as one feed instead of a stack of
 * single-step feeds.
 */
export function subagentHelperBlocks(transcript: SubagentTranscriptV1): SubagentHelperBlock[] {
  const blocks: SubagentHelperBlock[] = [];
  let group: { index: number; parts: SubagentTranscriptMessageEntry[] } | null = null;
  const flush = () => {
    if (!group) return;
    const first = group.parts[0]!;
    const last = group.parts[group.parts.length - 1]!;
    const entry: SubagentTranscriptMessageEntry =
      group.parts.length === 1
        ? first
        : {
            kind: "message",
            text: "",
            steps: group.parts.flatMap((part) => part.steps),
            startedAt: first.startedAt,
            ...(last.finishedAt === undefined ? {} : { finishedAt: last.finishedAt }),
          };
    blocks.push({ kind: "message", key: `message-${group.index}`, index: group.index, entry });
    group = null;
  };
  transcript.entries.forEach((entry, index) => {
    if (entry.kind === "task") {
      flush();
      blocks.push({ kind: "task", key: `task-${index}`, text: entry.text });
      return;
    }
    if (isToolOnlyMessage(entry)) {
      if (group) group.parts.push(entry);
      else group = { index, parts: [entry] };
      return;
    }
    flush();
    blocks.push({ kind: "message", key: `message-${index}`, index, entry });
  });
  flush();
  return blocks;
}
