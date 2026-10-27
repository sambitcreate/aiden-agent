import * as React from "react";

/**
 * A queued follow-up for a chat on a paired Mac goes out only once the turn
 * sent before it has finished there. The host accepts a turn (the receipt)
 * before its run reaches this Mac over the run stream, so between the two the
 * chat looks idle without being idle. The fence is keyed by host and chat and
 * outlives the pane, as the queue does: reopening the chat, or a receipt that
 * lands after the pane closed, never lets the next message jump the run.
 */

export interface RemoteQueueFence {
  /** The accepted turn's run (its stream id). */
  runId: string;
  /** The transcript revision when the turn was accepted. */
  revision: string | null;
  /** When it was accepted, for the stall fallback. */
  since: number;
}

export interface RemoteQueueFenceView {
  run: { runId: string | null; ended: boolean } | null;
  transcript: { revision: string | null; lastRole: string | undefined };
  now: number;
}

/** A run this Mac never hears about must not hold the queue for good. */
export const REMOTE_QUEUE_FENCE_STALL_MS = 120_000;

/**
 * Whether the fence still holds. It lifts only on evidence the turn finished:
 * its run was seen ending, or the host has since saved a reply (the
 * transcript moved on and now ends with the assistant) while no run is active.
 */
export function remoteQueueFenceHolds(fence: RemoteQueueFence | null, view: RemoteQueueFenceView): boolean {
  if (!fence) return false;
  if (view.now - fence.since >= REMOTE_QUEUE_FENCE_STALL_MS) return false;
  const run = view.run;
  if (run?.runId === fence.runId) return !run.ended;
  const runActive = Boolean(run && run.runId !== null && !run.ended);
  const replied =
    view.transcript.revision !== null &&
    view.transcript.revision !== fence.revision &&
    view.transcript.lastRole === "assistant";
  return runActive || !replied;
}

const fences = new Map<string, RemoteQueueFence>();
const listeners = new Set<() => void>();

export function setRemoteQueueFence(key: string, fence: RemoteQueueFence | null): void {
  if (fence) fences.set(key, fence);
  else fences.delete(key);
  for (const listener of listeners) listener();
}

export function remoteQueueFence(key: string): RemoteQueueFence | null {
  return fences.get(key) ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRemoteQueueFence(key: string | null): RemoteQueueFence | null {
  const read = React.useCallback(() => (key ? remoteQueueFence(key) : null), [key]);
  return React.useSyncExternalStore(subscribe, read, read);
}
