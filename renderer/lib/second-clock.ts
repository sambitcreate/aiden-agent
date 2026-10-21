import { useSyncExternalStore } from "react";

// Display-only time. Running Bots, subagents, and image slots share one wakeup;
// model requests, timeouts, expiry enforcement, and animation keep their own clocks.
let snapshot = Date.now();
let timer: number | undefined;
const listeners = new Set<() => void>();

function schedule(): void {
  if (listeners.size === 0 || timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    snapshot = Date.now();
    for (const listener of [...listeners]) listener();
    schedule();
  }, 1_000 - (Date.now() % 1_000));
}

export const secondClock = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void): () => void {
    // Refresh after an idle period before React checks for a missed update.
    if (listeners.size === 0) snapshot = Date.now();
    listeners.add(listener);
    schedule();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
  },
};

const inactiveSubscribe = () => () => {};

export function useNowSecond(enabled = true): number {
  return useSyncExternalStore(
    enabled ? secondClock.subscribe : inactiveSubscribe,
    secondClock.getSnapshot,
    secondClock.getSnapshot,
  );
}
