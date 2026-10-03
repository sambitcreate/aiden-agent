import type {
  PeerFeedRow,
  PeerHostFeedMessage,
  PeerHostFeedSnapshot,
  PeerHostStatus,
  PeerRunState,
} from "../../shared/peer-host";

/**
 * Pure renderer mirror of main's per-host feed cache. Main broadcasts every
 * change once with the cache's epoch and sequence after applying it, so a
 * renderer snapshot plus later messages reproduces main's rows.
 */

/** Returned when a message cannot follow the snapshot; read a fresh snapshot instead. */
export const FEED_RESYNC = "resync" as const;

function upsert(rows: readonly PeerFeedRow[], row: PeerFeedRow): PeerFeedRow[] {
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  if (index < 0) return [...rows, row];
  const next = [...rows];
  next[index] = row;
  return next;
}

function without(rows: readonly PeerFeedRow[], id: string): PeerFeedRow[] {
  return rows.filter((candidate) => candidate.id !== id);
}

/** Keeps main's insertion order: the newest state for a run moves to the end. */
function withRun(runs: readonly PeerRunState[], run: PeerRunState): PeerRunState[] {
  return [...runs.filter((candidate) => candidate.runId !== run.runId), run];
}

export function applyPeerHostFeedMessage(
  snapshot: PeerHostFeedSnapshot,
  message: PeerHostFeedMessage,
): PeerHostFeedSnapshot | typeof FEED_RESYNC {
  if (message.hostId !== snapshot.hostId) return snapshot;
  const { change } = message;
  if (change.type === "reset") {
    return {
      hostId: snapshot.hostId,
      epoch: message.epoch,
      sequence: message.sequence,
      stale: snapshot.stale,
      summaries: change.summaries,
      workspaces: change.workspaces,
      bots: change.bots,
      runs: change.runs,
    };
  }
  if (change.type === "stale") {
    return change.stale === snapshot.stale ? snapshot : { ...snapshot, stale: change.stale };
  }
  // A different epoch means a reset this snapshot never saw.
  if (message.epoch !== snapshot.epoch) return FEED_RESYNC;
  // Already reflected in a snapshot read after it was sent.
  if (message.sequence < snapshot.sequence) return snapshot;
  const next = { ...snapshot, sequence: message.sequence };
  switch (change.type) {
    case "chat.upsert":
      return { ...next, summaries: upsert(snapshot.summaries, change.row) };
    case "workspace.upsert":
      return { ...next, workspaces: upsert(snapshot.workspaces, change.row) };
    case "bot.upsert":
      return { ...next, bots: upsert(snapshot.bots, change.row) };
    case "chat.remove":
      return { ...next, summaries: without(snapshot.summaries, change.id) };
    case "workspace.remove":
      return { ...next, workspaces: without(snapshot.workspaces, change.id) };
    case "bot.remove":
      return { ...next, bots: without(snapshot.bots, change.id) };
    case "run.state":
      return { ...next, runs: withRun(snapshot.runs, change.run) };
    default:
      return next;
  }
}

/** Applies messages that arrived while a snapshot read was in flight. */
export function replayPeerHostFeedMessages(
  snapshot: PeerHostFeedSnapshot,
  messages: readonly PeerHostFeedMessage[],
): PeerHostFeedSnapshot | typeof FEED_RESYNC {
  let current = snapshot;
  for (const message of messages) {
    const next = applyPeerHostFeedMessage(current, message);
    if (next === FEED_RESYNC) return FEED_RESYNC;
    current = next;
  }
  return current;
}

/**
 * Keeps the newest status per host by generation, so statuses only move
 * forward. A full list (`complete`) also drops hosts it no longer names.
 */
export function mergePeerHostStatuses(
  current: readonly PeerHostStatus[] | undefined,
  incoming: readonly PeerHostStatus[],
  complete = false,
): PeerHostStatus[] {
  const known = new Map((current ?? []).map((status) => [status.hostId, status]));
  const byHost = complete ? new Map<string, PeerHostStatus>() : new Map(known);
  for (const status of incoming) {
    const previous = known.get(status.hostId);
    byHost.set(
      status.hostId,
      previous && previous.generation > status.generation ? previous : status,
    );
  }
  return [...byHost.values()];
}
