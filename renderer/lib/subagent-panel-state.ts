import {
  isSubagentRunViewStateActive,
  resolveSubagentSelection,
  splitSubagentRunViews,
  type SubagentRunView,
} from "./subagent-view-state";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";

export interface SubagentOverviewSummary {
  primary: string;
  secondary: string;
  ariaLabel: string;
}

export function subagentOverviewSummary(runs: readonly SubagentRunView[]): SubagentOverviewSummary {
  const counts = runs.reduce(
    (current, run) => {
      current[run.state] += 1;
      return current;
    },
    {
      queued: 0,
      starting: 0,
      running: 0,
      completed: 0,
      failed: 0,
      timed_out: 0,
      interrupted: 0,
      needs_attention: 0,
      stopped: 0,
      unknown: 0,
    } satisfies Record<SubagentRunView["state"], number>,
  );
  const parts = [
    counts.needs_attention ? `${counts.needs_attention} needs attention` : null,
    counts.queued ? `${counts.queued} queued` : null,
    counts.starting ? `${counts.starting} starting` : null,
    counts.running ? `${counts.running} working` : null,
    counts.failed ? `${counts.failed} failed` : null,
    counts.timed_out ? `${counts.timed_out} timed out` : null,
    counts.interrupted ? `${counts.interrupted} interrupted` : null,
    counts.stopped ? `${counts.stopped} stopped` : null,
    counts.unknown ? `${counts.unknown} outcome unknown` : null,
    counts.completed ? `${counts.completed} completed` : null,
  ].filter((part): part is string => part !== null);
  return {
    primary: parts[0] ?? "No subagents",
    secondary: parts.slice(1).join(" · ") || `${runs.length} total`,
    ariaLabel: parts.join(", ") || "No subagents",
  };
}

export function subagentRunProgressLabel(
  state: SubagentRunView["state"] | "finished",
  activity?: string,
): string {
  if (state === "running" && activity) return activity;
  if (state === "queued") return "Queued";
  if (state === "starting") return "Starting";
  if (state === "running") return "Working";
  if (state === "completed") return "Finished";
  if (state === "failed") return "Failed";
  if (state === "timed_out") return "Timed out";
  if (state === "interrupted") return "Interrupted";
  if (state === "needs_attention") return "Needs attention";
  if (state === "stopped") return "Stopped";
  if (state === "unknown") return "Outcome unknown";
  return "Finished";
}

export function subagentLiveSummary(runs: readonly SubagentRunView[]): string {
  const { active, done } = splitSubagentRunViews(runs);
  return formatSubagentLiveSummary(
    active.map((run) => ({
      runId: run.runId,
      label: run.label,
      state: run.state,
      activity: run.snapshot?.activity,
      updatedAt: run.snapshot?.updatedAt,
    })),
    done.map((run) => run.state),
  );
}

function formatSubagentLiveSummary(
  active: ReadonlyArray<{
    runId: string;
    label: string;
    state: SubagentRunView["state"];
    activity?: string;
    updatedAt?: number;
  }>,
  terminalStates: readonly SubagentRunView["state"][],
): string {
  const activeOutcomes = active.reduce(
    (counts, run) => {
      if (run.state === "queued") counts.queued += 1;
      else if (run.state === "starting") counts.starting += 1;
      else if (run.state === "needs_attention") counts.needsAttention += 1;
      else counts.working += 1;
      return counts;
    },
    { queued: 0, starting: 0, working: 0, needsAttention: 0 },
  );
  const activeSummary = [
    activeOutcomes.needsAttention > 0 ? `${activeOutcomes.needsAttention} needs attention` : null,
    activeOutcomes.queued > 0 ? `${activeOutcomes.queued} queued` : null,
    activeOutcomes.starting > 0 ? `${activeOutcomes.starting} starting` : null,
    activeOutcomes.working > 0 ? `${activeOutcomes.working} working` : null,
  ]
    .filter((outcome): outcome is string => outcome !== null)
    .join(", ");
  const latest = active.reduce<(typeof active)[number] | undefined>(
    (current, run) =>
      !current ||
      (run.updatedAt ?? 0) > (current.updatedAt ?? 0) ||
      ((run.updatedAt ?? 0) === (current.updatedAt ?? 0) &&
        (run.label > current.label ||
          (run.label === current.label && run.runId.localeCompare(current.runId) > 0)))
        ? run
        : current,
    undefined,
  );
  const terminalOutcomes = terminalStates.reduce(
    (counts, state) => {
      if (state === "completed") counts.completed += 1;
      else if (state === "failed") counts.failed += 1;
      else if (state === "timed_out") counts.timedOut += 1;
      else if (state === "interrupted") counts.interrupted += 1;
      else if (state === "stopped") counts.stopped += 1;
      else if (state === "unknown") counts.unknown += 1;
      else counts.finished += 1;
      return counts;
    },
    {
      completed: 0,
      failed: 0,
      timedOut: 0,
      interrupted: 0,
      stopped: 0,
      unknown: 0,
      finished: 0,
    },
  );
  const outcomeSummary = [
    terminalOutcomes.completed > 0 ? `${terminalOutcomes.completed} completed successfully` : null,
    terminalOutcomes.failed > 0 ? `${terminalOutcomes.failed} failed` : null,
    terminalOutcomes.timedOut > 0 ? `${terminalOutcomes.timedOut} timed out` : null,
    terminalOutcomes.interrupted > 0 ? `${terminalOutcomes.interrupted} interrupted` : null,
    terminalOutcomes.stopped > 0 ? `${terminalOutcomes.stopped} stopped` : null,
    terminalOutcomes.unknown > 0 ? `${terminalOutcomes.unknown} outcome unknown` : null,
    terminalOutcomes.finished > 0 ? `${terminalOutcomes.finished} finished` : null,
  ]
    .filter((outcome): outcome is string => outcome !== null)
    .join("; ");
  const activeLead = `${active.length} active subagent${active.length === 1 ? "" : "s"}${
    activeSummary ? `: ${activeSummary}` : ""
  }`;
  const latestSummary = latest
    ? ` Latest active update: ${latest.label}, ${subagentRunProgressLabel(latest.state, latest.activity)}.`
    : "";
  return `${activeLead}; ${outcomeSummary || "0 finished"}.${latestSummary}`;
}

export function subagentSnapshotLiveSummary(runs: readonly SubagentRunSnapshot[]): string {
  const active = runs.filter((run) => isSubagentRunViewStateActive(run.state));
  return formatSubagentLiveSummary(
    active,
    runs.filter((run) => !isSubagentRunViewStateActive(run.state)).map((run) => run.state),
  );
}

export function subagentSnapshotLiveSummaryIsTerminal(
  runs: readonly SubagentRunSnapshot[],
): boolean {
  return runs.length > 0 && runs.every((run) => !isSubagentRunViewStateActive(run.state));
}

interface PendingSubagentLiveAnnouncement {
  ownerKey: string;
  summary: string;
  terminal: boolean;
}

interface PendingSubagentDetailAnnouncement {
  ownerKey: string;
  message: string;
}

/**
 * Own the one Subagents live-region debounce independently from React rendering.
 * A same-owner terminal snapshot is the last chance to announce completion,
 * so flush it if persistence clears the live array before the debounce. An
 * owner change always discards the old owner's pending sentence. Saved-detail
 * lifecycle messages share this coordinator and take the next announcement
 * slot, so a concurrent live revision cannot overwrite them.
 */
export class SubagentLiveAnnouncementCoordinator {
  private ownerKey: string | null = null;
  private stateKey = "";
  private pendingLive: PendingSubagentLiveAnnouncement | null = null;
  private pendingDetail: PendingSubagentDetailAnnouncement | null = null;
  private timer: unknown;

  constructor(
    private readonly publish: (announcement: string) => void,
    private readonly schedule: (callback: () => void, delayMs: number) => unknown,
    private readonly cancel: (timer: unknown) => void,
  ) {}

  update(ownerKey: string, summary: string, terminal: boolean): void {
    const stateKey = JSON.stringify([ownerKey, summary, terminal]);
    if (stateKey === this.stateKey) return;
    this.stateKey = stateKey;

    const ownerChanged = this.ownerKey !== null && this.ownerKey !== ownerKey;
    if (ownerChanged) {
      this.clearPending();
    }
    this.ownerKey = ownerKey;

    if (!summary) {
      const pendingLive = this.pendingLive;
      this.pendingLive = null;
      if (pendingLive?.ownerKey === ownerKey && pendingLive.terminal) {
        if (this.pendingDetail) {
          this.pendingLive = pendingLive;
          this.ensureTimer(false);
        } else {
          this.cancelTimer();
          this.publish(pendingLive.summary);
        }
      } else if (!this.pendingDetail) {
        this.cancelTimer();
        this.publish("");
      }
      return;
    }

    if (ownerChanged) this.publish("");
    this.pendingLive = { ownerKey, summary, terminal };
    this.ensureTimer(this.pendingDetail === null);
  }

  announceDetail(ownerKey: string, message: string): void {
    if (this.ownerKey !== ownerKey || !message) return;
    this.pendingDetail = { ownerKey, message };
    this.ensureTimer(true);
  }

  dispose(): void {
    this.clearPending();
    this.ownerKey = null;
    this.stateKey = "";
  }

  private ensureTimer(reset: boolean): void {
    if (reset) this.cancelTimer();
    if (this.timer !== undefined) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      const detail = this.pendingDetail;
      if (detail) {
        this.pendingDetail = null;
        if (detail.ownerKey === this.ownerKey) this.publish(detail.message);
      } else {
        const live = this.pendingLive;
        this.pendingLive = null;
        if (live?.ownerKey === this.ownerKey) this.publish(live.summary);
      }
      if (this.pendingDetail || this.pendingLive) this.ensureTimer(false);
    }, 120);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  private clearPending(): void {
    this.cancelTimer();
    this.pendingLive = null;
    this.pendingDetail = null;
  }
}

export interface SubagentPanelSelectionState {
  runId: string | null;
  loading: boolean;
}

export function subagentPanelOwnerKey(
  chatId: string | null | undefined,
  workspaceId: string | null | undefined,
): string {
  return JSON.stringify([chatId ?? null, workspaceId ?? null]);
}

/**
 * The Environment provider commits its fallback selection in an effect. Derive
 * the first visible frame so an archived run shows Loading, never Unavailable,
 * while that state commit and its history request begin.
 */
export function subagentPanelSelectionState(
  runs: readonly SubagentRunView[],
  selectedRunId: string | null,
  active: boolean,
  detailLoading: boolean,
  detailError: string | null,
): SubagentPanelSelectionState {
  const runId = active
    ? (resolveSubagentSelection(selectedRunId ?? undefined, runs) ?? null)
    : selectedRunId;
  const selectedRun = runs.find((run) => run.runId === runId);
  const selectionCommitPending = active && runId !== selectedRunId;
  return {
    runId,
    loading:
      detailLoading ||
      Boolean(selectionCommitPending && selectedRun && !selectedRun.snapshot && !detailError),
  };
}

export function subagentDetailRestoreRunId(
  selectedRun: Pick<SubagentRunView, "runId"> | null,
): string | null {
  return selectedRun?.runId ?? null;
}

interface SubagentRosterFocusTarget {
  dataset: {
    subagentRunId?: string;
  };
  focus: () => void;
}

export function focusSubagentRosterRun(
  buttons: Iterable<SubagentRosterFocusTarget>,
  runId: string | null,
): boolean {
  if (!runId) return false;
  for (const button of buttons) {
    if (button.dataset.subagentRunId !== runId) continue;
    button.focus();
    return true;
  }
  return false;
}

export interface SubagentChipFocusTarget {
  dataset: {
    subagentChipRunId?: string;
  };
  isConnected: boolean;
  contains: (target: Node | null) => boolean;
  focus: (options?: { preventScroll?: boolean }) => void;
}

export interface SubagentChipFocusCapture {
  runId: string;
  element: SubagentChipFocusTarget;
}

export function captureSubagentChipFocus(
  element: SubagentChipFocusTarget | null,
): SubagentChipFocusCapture | null {
  const runId = element?.dataset.subagentChipRunId;
  return element && runId ? { runId, element } : null;
}

export function retainSubagentChipFocusAfterPointerDown(
  capture: SubagentChipFocusCapture | null,
  target: Node | null,
): SubagentChipFocusCapture | null {
  return capture?.element.contains(target) ? capture : null;
}

export type SubagentChipFocusHandoff =
  | { action: "retain" }
  | { action: "clear" }
  | { action: "focus"; target: SubagentChipFocusTarget };

/**
 * A live chip and its persisted transcript chip can be different React
 * subtrees. Retain the run identity while the old chip is disconnected and
 * the replacement has not mounted, but abandon the handoff as soon as focus
 * has moved to any real control.
 */
export function resolveSubagentChipFocusHandoff(
  capture: SubagentChipFocusCapture | null,
  activeElement: unknown,
  neutralFocusTargets: readonly unknown[],
  candidates: Iterable<SubagentChipFocusTarget>,
): SubagentChipFocusHandoff {
  if (!capture) return { action: "clear" };
  if (capture.element.isConnected) return { action: "retain" };
  if (
    activeElement !== null &&
    activeElement !== undefined &&
    !neutralFocusTargets.includes(activeElement)
  ) {
    return { action: "clear" };
  }
  for (const candidate of candidates) {
    if (
      candidate !== capture.element &&
      candidate.isConnected &&
      candidate.dataset.subagentChipRunId === capture.runId
    ) {
      return { action: "focus", target: candidate };
    }
  }
  return { action: "retain" };
}

export type SubagentPanelFocusSurface = "back" | "detail" | "roster" | null;
export type SubagentPanelBreakpointFocusTarget = "detail" | "roster" | null;

/**
 * Preserve the semantic keyboard destination when the responsive layout
 * replaces the focused DOM subtree. Detail focus stays with detail; the
 * compact Back control resolves to the selected roster row it represents.
 */
export function subagentPanelBreakpointFocusTarget(
  previousCompact: boolean,
  nextCompact: boolean,
  focusedSurface: SubagentPanelFocusSurface,
): SubagentPanelBreakpointFocusTarget {
  if (previousCompact === nextCompact || focusedSurface === null) return null;
  return focusedSurface === "detail" ? "detail" : "roster";
}

export function subagentDetailPendingLoading(
  hasSelectedRun: boolean,
  hasDetailSnapshot: boolean,
  detailLoading: boolean,
  detailError: string | null,
): boolean {
  if (!hasSelectedRun || hasDetailSnapshot || detailError !== null) return false;
  return detailLoading;
}

export type SubagentDetailPresentation =
  | "loading"
  | "unavailable"
  | "loaded"
  | "refreshing"
  | "refresh_failed"
  | "stopping"
  | "stop_failed"
  | "saving"
  | "save_delayed";

export function subagentDetailPresentation(
  hasSelectedRun: boolean,
  hasDetailSnapshot: boolean,
  pendingDetailLoading: boolean,
): SubagentDetailPresentation | null {
  if (!hasSelectedRun) return null;
  if (hasDetailSnapshot) return "loaded";
  return pendingDetailLoading ? "loading" : "unavailable";
}

export interface SubagentDetailAnnouncementState {
  ownerKey: string;
  runId: string;
  label: string;
  saved: boolean;
  presentation: SubagentDetailPresentation;
  activity?: string;
  statusLabel?: string;
}

/**
 * Produce one complete atomic sentence for the panel's single polite region.
 * Focus management is intentionally separate: announcements must never move
 * the roster or detail focus.
 */
export function subagentDetailAnnouncement(
  previous: SubagentDetailAnnouncementState | null,
  next: SubagentDetailAnnouncementState | null,
): string | null {
  if (!next) return null;
  const sameRun = previous?.ownerKey === next.ownerKey && previous.runId === next.runId;

  if (next.presentation === "stopping") {
    return !sameRun || previous?.presentation !== "stopping" ? `Stopping ${next.label}.` : null;
  }
  if (next.presentation === "stop_failed" && (!sameRun || previous?.presentation === "stopping")) {
    return `Could not stop ${next.label}. Try again if the run is still available.`;
  }
  if (
    (next.presentation === "saving" || next.presentation === "save_delayed") &&
    (!sameRun || previous?.presentation !== next.presentation)
  ) {
    return `${next.label}: ${next.statusLabel ?? "Subagent outcome is waiting for conversation history"}.`;
  }

  if (next.saved && next.presentation === "refreshing") {
    return sameRun && previous?.presentation === "refresh_failed"
      ? `Retrying saved activity for ${next.label}.`
      : `Refreshing saved activity for ${next.label}.`;
  }
  if (
    next.saved &&
    next.presentation === "refresh_failed" &&
    (!sameRun || previous?.presentation !== "refresh_failed")
  ) {
    return `Could not refresh saved activity for ${next.label}. Showing the last available activity. Retry is available.`;
  }
  if (next.saved && next.presentation === "loading") {
    return sameRun && previous?.presentation === "unavailable"
      ? `Retrying saved activity for ${next.label}.`
      : `Loading saved activity for ${next.label}.`;
  }
  if (
    next.saved &&
    next.presentation === "loaded" &&
    sameRun &&
    (previous?.presentation === "loading" || previous?.presentation === "refreshing")
  ) {
    const action = previous.presentation === "refreshing" ? "refreshed" : "loaded";
    return next.activity
      ? `Saved activity ${action} for ${next.label}. ${next.activity}.`
      : `Saved activity ${action} for ${next.label}.`;
  }
  if (
    next.saved &&
    next.presentation === "unavailable" &&
    (!sameRun || previous?.presentation === "loading")
  ) {
    return `Could not load saved activity for ${next.label}. Retry is available.`;
  }
  return null;
}

export function subagentDetailFocusFrame(
  run: Pick<SubagentRunView, "runId" | "generationId">,
  hasDetailSnapshot: boolean,
  pendingDetailLoading: boolean,
  detailRequestVersion: number,
): string {
  const presentation: SubagentDetailPresentation = hasDetailSnapshot
    ? "loaded"
    : pendingDetailLoading
      ? "loading"
      : "unavailable";
  const requestVersion = presentation === "loaded" ? 0 : detailRequestVersion;
  return `${run.runId}:${run.generationId}:${presentation}:${requestVersion}`;
}

export function shouldRestoreSubagentDetailFocus(
  detailOwnedFocus: boolean,
  previousFrame: string | null,
  nextFrame: string | null,
): boolean {
  return (
    detailOwnedFocus && previousFrame !== null && nextFrame !== null && previousFrame !== nextFrame
  );
}

export type SubagentDetailGrowthAction = "reset" | "follow" | "measure";

export function subagentDetailGrowthAction(
  previous: { runId: string; revision: number } | null,
  next: { runId: string; revision: number },
  userNavigated: boolean,
): SubagentDetailGrowthAction {
  if (!previous || previous.runId !== next.runId) return "reset";
  if (previous.revision !== next.revision && !userNavigated) return "follow";
  return "measure";
}

export function subagentDetailIsAwayFromLatest(
  scrollHeight: number,
  clientHeight: number,
  scrollTop: number,
): boolean {
  return scrollHeight - clientHeight - scrollTop > 48;
}
