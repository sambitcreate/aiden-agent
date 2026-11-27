import * as React from "react";

export interface SharedSnapshotOptions<T> {
  empty: T;
  subscribe: (onValue: (next: T) => void) => () => void;
  read: () => Promise<T>;
  normalize?: (next: T) => T;
  /** When true, a slow initial read cannot overwrite a push that arrived first. */
  ignoreReadAfterPush: boolean;
}

/**
 * Module-level refcounted subscription cache backed by `useSyncExternalStore`.
 * Subscribes before the initial read on the first consumer, guards async
 * updates with a generation counter, and resets on the last release.
 */
export function createSharedSnapshot<T>({
  empty,
  subscribe,
  read,
  normalize,
  ignoreReadAfterPush,
}: SharedSnapshotOptions<T>) {
  let cached: T = empty;
  let consumers = 0;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();

  function publish(next: T): void {
    cached = normalize ? normalize(next) : next;
    for (const listener of [...listeners]) listener();
  }

  function acquire(): () => void {
    consumers += 1;
    if (consumers === 1) {
      const current = ++generation;
      let pushed = false;
      unsubscribe = subscribe((next) => {
        if (current !== generation) return;
        pushed = true;
        publish(next);
      });
      void read().then(
        (next) => {
          if (current === generation && (!ignoreReadAfterPush || !pushed)) publish(next);
        },
        () => undefined,
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      consumers -= 1;
      if (consumers > 0) return;
      generation += 1;
      unsubscribe?.();
      unsubscribe = null;
      cached = empty;
    };
  }

  function useSnapshot(enabled: boolean): T {
    React.useEffect(() => (enabled ? acquire() : undefined), [enabled]);
    const state = React.useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => cached,
      () => empty,
    );
    return enabled ? state : empty;
  }

  return { acquire, useSnapshot };
}
