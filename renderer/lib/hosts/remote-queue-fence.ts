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
  /** The accepted turn's run (its stream id); `null` while the send awaits its receipt. */
  runId: string | null;
  /** When it was accepted, for the stall fallback. */
  since: number;
}

export interface RemoteQueueFenceView {
  /** The run this pane follows on the host's run stream. */
  run: { runId: string | null; ended: boolean } | null;
  /** The host feed's `run.state` for the fenced run, when the feed has sent one. */
  hostRunState: string | undefined;
  now: number;
}

/** A run this Mac never hears about must not hold the queue for good. */
export const REMOTE_QUEUE_FENCE_STALL_MS = 120_000;

/** Feed states the host publishes only after it has released the turn. */
const SETTLED_RUN_STATES = new Set(["done", "failed", "cancelled"]);

/**
 * Whether the fence still holds. It lifts only on evidence about that very
 * run: the run stream saw it end, or the host feed reports it settled. The
 * host saves a reply before it releases the turn, and a chat's idle/active
 * row can't say which run it describes, so neither counts.
 */
export function remoteQueueFenceHolds(fence: RemoteQueueFence | null, view: RemoteQueueFenceView): boolean {
  if (!fence) return false;
  if (view.now - fence.since >= REMOTE_QUEUE_FENCE_STALL_MS) return false;
  // Sent, receipt not in yet: the host may already be running it.
  if (fence.runId === null) return true;
  if (view.hostRunState !== undefined && SETTLED_RUN_STATES.has(view.hostRunState)) return false;
  return !(view.run?.runId === fence.runId && view.run.ended);
}

const fences = new Map<string, RemoteQueueFence>();
const listeners = new Set<() => void>();

export function setRemoteQueueFence(key: string, fence: RemoteQueueFence | null): void {
  if (fence) fences.set(key, fence);
  else fences.delete(key);
  for (const listener of listeners) listener();
}

/**
 * Starts a turn and fences the chat's queue on its run. Every new turn goes
 * through here (typed, queued, or a failure card's Try again), so a queued
 * follow-up never reaches the host while any of them is still running.
 * `key` is bound before the send, so a receipt after the pane closed still fences.
 */
export async function sendFencedTurn(
  key: string | null,
  send: () => Promise<{ streamId: string } | null>,
  now: () => number = Date.now,
): Promise<void> {
  // Held from before the send: the session reports the send finished a step
  // before its receipt reaches here, and the queue must not slip into that gap.
  const pending: RemoteQueueFence | null = key ? { runId: null, since: now() } : null;
  // An attempt that doesn't start puts back the fence it found, so a refusal
  // never lifts the hold an earlier accepted turn still needs.
  const previous = key ? remoteQueueFence(key) : null;
  if (key && pending) setRemoteQueueFence(key, pending);
  const release = () => {
    if (key && remoteQueueFence(key) === pending) setRemoteQueueFence(key, previous);
  };
  let receipt: { streamId: string } | null;
  try {
    receipt = await send();
  } catch (error) {
    release();
    throw error;
  }
  if (!receipt) {
    // Unconfirmed: the reconciliation banner holds the queue from here too.
    release();
    return;
  }
  if (key) setRemoteQueueFence(key, { runId: receipt.streamId, since: now() });
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
