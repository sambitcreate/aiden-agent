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
import {
  SUBAGENT_NEEDS_ATTENTION_FALLBACK_ACTIVITY,
  type SubagentRunSnapshot,
} from "../shared/subagent-runs";
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

export function subagentHelperIsActive(state: SubagentRunSnapshot["state"] | "unknown"): boolean {
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

/**
 * The runner writes its reasons for the main chat's model, which calls the
 * helper "the child". People read these plain sentences instead; the model
 * still gets the original text. Each entry's first sentence is the runner's
 * whole text, so a reason cut short upstream still maps by its start.
 */
const RUNNER_REASONS: ReadonlyArray<readonly [string, RegExp, string]> = [
  ["The child reached its turn limit.", /the child reached its turn limit\./giu, "It ran out of turns."],
  [
    "The child reached its tool-call limit.",
    /the child reached its tool-call limit\./giu,
    "It used all of its allowed steps.",
  ],
  [
    "The child reserved its remaining deadline for reporting.",
    /the child reserved its remaining deadline for reporting\./giu,
    "It ran short of time and stopped to write its report.",
  ],
  ["The child reached its output limit.", /the child reached its output limit\./giu, "Its reply grew too long."],
  [
    "The child reached its event limit.",
    /the child reached its event limit\./giu,
    "It did more work than one helper is allowed.",
  ],
  [
    "The child reached its protocol limit.",
    /the child reached its protocol limit\./giu,
    "It sent more than one helper is allowed.",
  ],
  [
    "The child did not provide a final text report.",
    /the child did not provide a final text report\./giu,
    "It stopped without writing a report.",
  ],
  [
    "The child completed without a textual assistant result.",
    /the child completed without a textual assistant result\./giu,
    "It stopped without writing a report.",
  ],
  [
    "The child model returned no successful final answer.",
    /the child model returned no successful final answer\./giu,
    "Its model stopped without a final answer.",
  ],
  [
    "The child tool result exceeds its transport budget.",
    /the child tool result exceeds its transport budget\./giu,
    "One of its tools returned more than a helper can pass on.",
  ],
  [
    "The child was interrupted before completion.",
    /the child was interrupted before completion\./giu,
    "It was interrupted before it finished.",
  ],
  [
    "The child was stopped because the user sent new guidance. Read it before relaunching this task.",
    /the child was stopped because the user sent new guidance\.(?: read it before relaunching this task\.)?/giu,
    "It was stopped because you sent new guidance.",
  ],
  [
    "These are incomplete, unverified partial findings.",
    /these are incomplete, unverified partial findings\./giu,
    "Its findings so far may be incomplete.",
  ],
  ["The child could not complete this task.", /the child (?:model )?could not complete this task\./giu, ""],
  ["This helper couldn't finish.", /this helper couldn't finish\./giu, ""],
];

/** The shortest cut-off runner text still matched by its start. */
const MIN_RUNNER_PREFIX = 16;

// Upstream limits can cut the last reason mid-sentence, with or without an
// ellipsis. A long enough start of one runner sentence still reads plainly.
function plainTruncatedRunnerReason(text: string): string {
  const match = /(^|[.!?]\s+)([^.!?]*?)(?:\u2026|\.\.\.)?\s*$/u.exec(text);
  if (!match) return text;
  const fragment = (match[2] ?? "").trim().toLocaleLowerCase();
  if (fragment.length < MIN_RUNNER_PREFIX) return text;
  for (const [sentence, , plain] of RUNNER_REASONS) {
    if (sentence.toLocaleLowerCase().startsWith(fragment)) {
      return `${text.slice(0, match.index)}${match[1] ?? ""} ${plain} `;
    }
  }
  return text;
}

/**
 * A failed helper's reason in plain words, or null when it only says the
 * helper did not finish. Text the runner did not write passes through.
 */
export function subagentFailureReason(error: string | undefined): string | null {
  let text = error?.trim().replace(/\s+/gu, " ");
  if (!text || GENERIC_FAILURES.has(text.toLocaleLowerCase())) return null;
  for (const [, pattern, plain] of RUNNER_REASONS) text = text.replace(pattern, ` ${plain} `);
  text = plainTruncatedRunnerReason(text.trim());
  // Sentences the replacements produced twice read once.
  const seen = new Set<string>();
  text = text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => {
      if (!sentence || seen.has(sentence)) return false;
      seen.add(sentence);
      return true;
    })
    .join(" ");
  if (!text) return null;
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

export interface SubagentHelperProblem {
  tone: "stopped" | "failed";
  text: string;
  /** The ready-made message Ask the main chat to retry puts in the composer. */
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
    const reason = subagentFailureReason(run.error);
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

/** A helper in this chat, as far as matching an approval to it needs. */
export type SubagentHelperPeer = Pick<SubagentRunSnapshot, "runId" | "label"> & {
  state: SubagentRunSnapshot["state"] | "unknown";
};

/**
 * The pending approval that belongs to this helper. A run grant names its
 * run; the other kinds name only the helper's label, so they match only while
 * this helper is active and no other active helper in `helpers` shares it. Every surface passes all of
 * the chat's helpers and this one rule decides which count.
 */
export function subagentHelperApprovalFor(
  run: SubagentHelperPeer,
  approvals: readonly ApprovalPrompt[],
  helpers: readonly SubagentHelperPeer[],
): ApprovalPrompt | null {
  return subagentHelperApprovalsFor(run, approvals, helpers)[0] ?? null;
}

/** Every pending approval that belongs to this helper, in queue order. */
export function subagentHelperApprovalsFor(
  run: SubagentHelperPeer,
  approvals: readonly ApprovalPrompt[],
  helpers: readonly SubagentHelperPeer[],
): ApprovalPrompt[] {
  // A finished helper can't be asking; only its own run grant still names it.
  const labelOwned =
    subagentHelperIsActive(run.state) &&
    !helpers.some(
    (other) =>
      other.runId !== run.runId && other.label === run.label && subagentHelperIsActive(other.state),
    );
  const owned: ApprovalPrompt[] = [];
  for (const approval of approvals) {
    const details = approval.details;
    if (isSubagentRunGrantApprovalDetails(details)) {
      if (details.runId === run.runId) owned.push(approval);
      continue;
    }
    if (
      (isSubagentWorkspaceWriteApprovalDetails(details) ||
        isSubagentShellApprovalDetails(details) ||
        isSubagentMcpMutationApprovalDetails(details)) &&
      labelOwned &&
      details.childLabel === run.label
    ) {
      owned.push(approval);
    }
  }
  return owned;
}

/**
 * Show running helpers that wait on one of your approvals as waiting on you.
 * The server still calls them running, so this is a display-only overlay.
 * Only running helpers ask: every helper approval, a run grant included,
 * comes from one of its tool calls, which start once it runs. `helpers` is
 * every helper in the chat, for telling apart helpers that share a label; it
 * defaults to `runs`. Returns the same array when nothing changes.
 */
export function withSubagentApprovalWaitSnapshots(
  runs: readonly SubagentRunSnapshot[],
  approvals: readonly ApprovalPrompt[],
  helpers: readonly SubagentHelperPeer[] = runs,
): readonly SubagentRunSnapshot[] {
  if (approvals.length === 0) return runs;
  let changed = false;
  const next = runs.map((run) => {
    if (run.state !== "running" || run.version !== 2) return run;
    if (subagentHelperApprovalsFor(run, approvals, helpers).length === 0) return run;
    changed = true;
    return {
      ...run,
      state: "needs_attention" as const,
      activity: SUBAGENT_NEEDS_ATTENTION_FALLBACK_ACTIVITY,
    };
  });
  return changed ? next : runs;
}

/** The same overlay for run views that carry a snapshot. */
export function withSubagentApprovalWaitViews<
  T extends { state: SubagentRunSnapshot["state"]; snapshot?: SubagentRunSnapshot },
>(views: readonly T[], approvals: readonly ApprovalPrompt[]): readonly T[] {
  if (approvals.length === 0) return views;
  const snapshots = views.flatMap((view) => (view.snapshot ? [view.snapshot] : []));
  const overlaid = withSubagentApprovalWaitSnapshots(snapshots, approvals);
  if (overlaid === snapshots) return views;
  const byRun = new Map(overlaid.map((run) => [run.runId, run]));
  let changed = false;
  const next = views.map((view) => {
    const snapshot = view.snapshot ? byRun.get(view.snapshot.runId) : undefined;
    if (!snapshot || snapshot === view.snapshot) return view;
    changed = true;
    return { ...view, state: snapshot.state, snapshot };
  });
  return changed ? next : views;
}

/** Whether a helper this one started is still active, so stopping it stops them too. */
export function subagentHelperHasActiveHelpers(
  runId: string,
  views: ReadonlyArray<{ terminal: boolean; snapshot?: SubagentRunSnapshot }>,
): boolean {
  return views.some(
    (view) =>
      !view.terminal && view.snapshot?.version === 2 && view.snapshot.parentRunId === runId,
  );
}

/** Shown when a helper's saved conversation could not be read. */
export const SUBAGENT_TRANSCRIPT_REFRESH_ERROR = "Couldn't load this helper's conversation.";

/**
 * Why this window should read a helper's saved conversation again, or null.
 * Each distinct reason is read once.
 *
 * - `gap:<revision>`: the streamed updates start after the saved copy.
 * - `join`: a running helper with nothing in this window yet (it started
 *   before the window opened); its updates will follow.
 * - `join:<revision>`: the same with no updates streaming to this window, so
 *   the read repeats as the run moves until a saved copy exists. A queued or
 *   starting helper has nothing saved yet, and that is not a failure.
 * - `run:<state>:<revision>`: no updates stream to this window (another
 *   window runs the chat), so the saved copy is read again whenever the run's
 *   state or revision moves, including when it finishes.
 */
export function subagentHelperTranscriptRefetchReason(
  run: Pick<SubagentRunSnapshot, "state" | "revision">,
  merged: MergedSubagentTranscript,
  streamingHere: boolean,
): string | null {
  if (!merged.complete) return `gap:${merged.transcript?.revision ?? 0}`;
  if (!merged.transcript) {
    if (!subagentHelperIsActive(run.state)) return null;
    return streamingHere ? "join" : `join:${run.revision}`;
  }
  if (streamingHere) return null;
  return `run:${run.state}:${run.revision}`;
}

/**
 * The run revision a read for this reason may be skipped at: a saved copy
 * already read at that revision or later answers it. A gap, or a join whose
 * updates stream here, always reads.
 */
export function subagentHelperRefetchSkipRevision(reason: string): number | undefined {
  const match = /^(?:run:[a-z_]+|join):(\d+)$/u.exec(reason);
  return match ? Number(match[1]) : undefined;
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
