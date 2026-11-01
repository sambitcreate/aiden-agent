import { CHAT_ROW_STATES, isChatRowState, type ChatRowState } from "./chat-row-state.js";
import type { ChatTriageEntry } from "./chat-triage.js";
import type { PeerFeedRow, PeerRunState } from "./peer-host.js";

/**
 * How a paired host's feed rows read for the Inbox: one implementation for
 * the sidebar (`renderer/lib/sidebar-remote-groups.ts`,
 * `renderer/lib/sidebar-inbox-view.ts`) and the main process's Dock badge
 * (`main/services/inbox-dock-badge.ts`). Pure.
 */

/** An RFC 3339 feed field as epoch ms, or undefined when absent or malformed. */
export function peerFeedTime(row: PeerFeedRow, field: string): number | undefined {
  const value = row[field];
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The triage entry a summary row reports: its `triageRevision` with whichever
 * of Pin, Done and Snooze it holds. `updatedAt` is not on the wire; the newest
 * of the entry's times stands in, and nothing orders by it.
 */
export function reportedTriage(row: PeerFeedRow): ChatTriageEntry | undefined {
  const revision = row.triageRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  const pinnedAt = peerFeedTime(row, "pinnedAt");
  const doneAt = peerFeedTime(row, "doneAt");
  const snoozedUntil = peerFeedTime(row, "snoozedUntil");
  return {
    revision,
    updatedAt: Math.max(0, pinnedAt ?? 0, doneAt ?? 0),
    ...(pinnedAt !== undefined ? { pinnedAt } : {}),
    ...(doneAt !== undefined ? { doneAt } : {}),
    ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
  };
}

export const PEER_LIVE_RUN_STATES: ReadonlySet<string> = new Set(["working", "needs_approval", "needs_input"]);

function moreUrgent(left: ChatRowState, right: ChatRowState): ChatRowState {
  return CHAT_ROW_STATES.indexOf(left) <= CHAT_ROW_STATES.indexOf(right) ? left : right;
}

/** Newest run per chat; the feed keeps runs in insertion order, newest last. */
export function latestPeerRuns(runs: readonly PeerRunState[]): Map<string, PeerRunState> {
  const latest = new Map<string, PeerRunState>();
  for (const run of runs) latest.set(run.chatId, run);
  return latest;
}

export interface PeerFeedChatState {
  rowState: ChatRowState;
  /** The host's read state, before the open chat is cleared. */
  hostUnread: boolean;
  /** The host reports that the chat's newest output is a failed turn (revision 36). */
  lastRunFailed: boolean;
  attentionSince?: number;
  runStartedAt?: number;
  lastAssistantAt?: number;
  /** Revision 48: the triage entry the host reports. */
  triage?: ChatTriageEntry;
}

/**
 * One summary row's state. The summary's row state and the chat's newest live
 * run each count, the more urgent winning. A stale host cannot confirm a run
 * is still going, so working reads idle; a waiting prompt stays visible.
 */
export function peerFeedChatState(
  row: PeerFeedRow,
  run: PeerRunState | undefined,
  stale: boolean,
): PeerFeedChatState {
  const summaryState: ChatRowState = isChatRowState(row.rowState)
    ? row.rowState
    : row.activity === "active"
      ? "working"
      : "idle";
  const runState = run && PEER_LIVE_RUN_STATES.has(run.state) && isChatRowState(run.state) ? run.state : "idle";
  let rowState = moreUrgent(runState, summaryState);
  if (stale && rowState === "working") rowState = "idle";
  // The summary carries the host's current read marker, so it outranks the
  // run's hint, which only stands in when a summary has no read state.
  const hostUnread = typeof row.unread === "boolean" ? row.unread : run?.unread === true;
  const attentionSince = peerFeedTime(row, "attentionSince");
  const runStartedAt = peerFeedTime(row, "runStartedAt");
  const lastAssistantAt = peerFeedTime(row, "lastAssistantAt");
  const triage = reportedTriage(row);
  return {
    rowState,
    hostUnread,
    lastRunFailed: row.lastRunFailed === true,
    ...(attentionSince !== undefined ? { attentionSince } : {}),
    ...(runStartedAt !== undefined ? { runStartedAt } : {}),
    ...(lastAssistantAt !== undefined ? { lastAssistantAt } : {}),
    ...(triage ? { triage } : {}),
  };
}

/**
 * A paired host's Bot row (revision 48). A Bot that needs the person outranks
 * one whose last run failed; older hosts send neither field.
 */
export function peerFeedBotAttention(row: PeerFeedRow): { needsYou: boolean; failed: boolean } {
  const needsYou = row.needsYou === true;
  return { needsYou, failed: !needsYou && row.failed === true };
}
