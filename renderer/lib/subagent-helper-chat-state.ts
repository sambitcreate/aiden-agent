import type { ApprovalPrompt } from "./ipc";
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

function changedText(files: readonly string[]): string {
  if (files.length === 0) return "nothing";
  if (files.length === 1) return files[0]!;
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  return `${files[0]}, ${files[1]} and ${files.length - 2} more`;
}

export interface SubagentHelperProblem {
  tone: "stopped" | "failed";
  title: string;
  text: string;
  /** The ready-made message Ask main chat to retry puts in the composer. */
  retryText: string;
}

/** One plain explanation for a helper that ended without finishing, or null. */
export function subagentHelperProblem(
  run: Pick<SubagentRunSnapshot, "state" | "label" | "error">,
  summary: SubagentHelperWorkSummary,
): SubagentHelperProblem | null {
  const tone = subagentHelperTone(run.state);
  if (tone !== "stopped" && tone !== "failed") return null;
  const after = `after ${stepCount(summary.steps)}`;
  const changed = changedText(summary.changedFiles);
  const changedSentence = `It changed ${changed}.`;
  const error = run.error?.trim();
  let title: string;
  let text: string;
  if (run.state === "stopped") {
    title = "Stopped";
    text = `You stopped this helper ${after}. ${changedSentence}`;
  } else if (run.state === "timed_out") {
    title = "Ran out of time";
    text = `This helper ran out of time ${after}. ${changedSentence}`;
  } else if (tone === "failed") {
    title = "Failed";
    text = error
      ? `${error.replace(/\s+$/u, "").replace(/([^.!?])$/u, "$1.")} ${changedSentence}`
      : `This helper failed ${after}. ${changedSentence}`;
  } else {
    title = "Stopped";
    text = `This helper stopped early ${after}. ${changedSentence}`;
  }
  return {
    tone,
    title,
    text,
    retryText: `Please retry the helper '${run.label}'. It stopped ${after} and changed ${changed}.`,
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
