import type {
  PeerFeedRow,
  PeerHostFeedMessage,
  PeerHostFeedSnapshot,
  PeerHostStatus,
  PeerRunState,
} from "../../shared/peer-host";
import type { QueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "./host-query-keys";

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
      // As main's cache does, a chat that leaves takes its run states with it.
      return {
        ...next,
        summaries: without(snapshot.summaries, change.id),
        runs: snapshot.runs.filter((run) => run.chatId !== change.id),
      };
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

/** Messages held for one host before the batch gives up and reads a fresh snapshot instead. */
export const PEER_FEED_BATCH_MAX_MESSAGES = 512;

export interface PeerHostFeedBatchTarget {
  /** The host's rows as last applied, or nothing while no snapshot is loaded. */
  read(hostId: string): PeerHostFeedSnapshot | null | undefined;
  /** Replaces the host's rows; called at most once per host per flush. */
  write(hostId: string, snapshot: PeerHostFeedSnapshot): void;
  /** The host's rows cannot follow the batch; read a fresh snapshot. */
  resync(hostId: string): void;
}

export interface PeerHostFeedBatcher {
  push(message: PeerHostFeedMessage): void;
  /** Drops anything held and cancels the scheduled frame. */
  dispose(): void;
}

/**
 * Coalesces feed broadcasts so each host's rows change at most once per
 * frame, however many messages arrive in it: the sidebar re-organizes once
 * per frame rather than once per message. A host that sends more than
 * `PEER_FEED_BATCH_MAX_MESSAGES` before a frame comes (a hidden window gets
 * none) stops holding them and reads one fresh snapshot instead, so a hidden
 * window's memory stays bounded.
 */
export function createPeerHostFeedBatcher(
  schedule: (flush: () => void) => () => void,
  target: PeerHostFeedBatchTarget,
): PeerHostFeedBatcher {
  const held = new Map<string, PeerHostFeedMessage[] | typeof FEED_RESYNC>();
  let scheduled = false;
  let cancel: (() => void) | null = null;
  const unschedule = () => {
    scheduled = false;
    cancel?.();
    cancel = null;
  };

  const applyHost = (hostId: string, messages: PeerHostFeedMessage[] | typeof FEED_RESYNC) => {
    const current = target.read(hostId);
    // No snapshot yet: the read in flight replays what it missed.
    if (!current) return;
    if (messages === FEED_RESYNC) {
      target.resync(hostId);
      return;
    }
    let next = current;
    let behind = false;
    for (const message of messages) {
      const applied = applyPeerHostFeedMessage(next, message);
      if (applied === FEED_RESYNC) {
        // A later reset in the same batch still brings the rows back in step.
        behind = true;
        continue;
      }
      if (message.change.type === "reset") behind = false;
      next = applied;
    }
    if (behind) target.resync(hostId);
    else if (next !== current) target.write(hostId, next);
  };

  const flush = () => {
    unschedule();
    const batch = [...held];
    held.clear();
    for (const [hostId, messages] of batch) applyHost(hostId, messages);
  };

  return {
    push(message) {
      const messages = held.get(message.hostId);
      if (messages === FEED_RESYNC) return;
      if (!messages) held.set(message.hostId, [message]);
      else if (messages.length >= PEER_FEED_BATCH_MAX_MESSAGES) held.set(message.hostId, FEED_RESYNC);
      else messages.push(message);
      if (scheduled) return;
      scheduled = true;
      const cancelFrame = schedule(flush);
      // A scheduler may flush at once; only a frame still pending can be cancelled.
      if (scheduled) cancel = cancelFrame;
    },
    dispose() {
      unschedule();
      held.clear();
    },
  };
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

export interface PeerHostStatusSync {
  /** Applies one host's status broadcast. */
  receive(status: PeerHostStatus): void;
  /** Query function for every host's status. */
  read(): Promise<PeerHostStatus[]>;
}

/**
 * Keeps the status query in step with per-host broadcasts. A broadcast names
 * one host, so until a complete read has landed it is held aside rather than
 * cached: a cached partial list would look fresh and skip the complete read.
 * Every read merges against the cache as it is when the reply lands, so a
 * newer broadcast received during the read is kept.
 */
export function createPeerHostStatusSync(
  queryClient: QueryClient,
  readAll: () => Promise<readonly PeerHostStatus[]>,
): PeerHostStatusSync {
  const key = hostQueryKeys.statuses();
  const cached = () => queryClient.getQueryData<PeerHostStatus[]>(key);
  let early: PeerHostStatus[] = [];
  return {
    receive(status) {
      if (cached() === undefined) {
        early.push(status);
        return;
      }
      queryClient.setQueryData<PeerHostStatus[]>(key, (current) =>
        mergePeerHostStatuses(current, [status]),
      );
    },
    async read() {
      const incoming = await readAll();
      const merged = mergePeerHostStatuses(
        mergePeerHostStatuses(cached(), incoming, true),
        early,
      );
      early = [];
      return merged;
    },
  };
}
