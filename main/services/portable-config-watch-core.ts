// Coalesces the "re-read ~/.aiden/config.json" trigger.
//
// The app fires this on every window focus and on wake from sleep, so the common
// case must not touch the renderer: DataStore.reload() re-reads the (small) file
// and compares contents, and only a real change is announced. Concurrent
// triggers coalesce, so a focus storm costs one re-read.
// Platform-independent so the coalescing and change-gating are testable.

export interface PortableConfigWatcher {
  /** Re-read now, joining an in-flight refresh rather than queueing another. */
  refresh(): Promise<void>;
}

export interface SafeSnapshotTransition<T> {
  previous: T;
  current: T;
}

export interface LastSafeSnapshotTracker<T> {
  /** Seed the tracker from the cache before the first disk reload. */
  seed(current: T | null, safe: boolean): void;
  /**
   * Observe the post-reload cache. Unsafe projections never replace the last
   * authoritative snapshot; a later repair remains pending until committed.
   */
  afterReload(
    current: T | null,
    safe: boolean,
    contentChanged: boolean,
  ): { comparison: SafeSnapshotTransition<T> | null; shouldNotify: boolean };
  /** Commit only after every reconciliation side effect succeeds. */
  commit(current: T): void;
}

export interface LastSafeSnapshotReload {
  (): Promise<boolean>;
  /** Advance the baseline after a fully reconciled app-authored mutation. */
  syncCurrent(): Promise<void>;
}

export function createLastSafeSnapshotTracker<T>(): LastSafeSnapshotTracker<T> {
  let lastSafe: T | null = null;
  let reconciliationPending = false;

  return {
    seed(current, safe) {
      if (!safe) {
        reconciliationPending = true;
        return;
      }
      if (lastSafe === null && current !== null) lastSafe = current;
    },

    afterReload(current, safe, contentChanged) {
      if (!safe || current === null) {
        reconciliationPending = true;
        return { comparison: null, shouldNotify: false };
      }

      const shouldNotify = contentChanged || reconciliationPending;
      if (lastSafe === null) {
        lastSafe = current;
        reconciliationPending = false;
        return { comparison: null, shouldNotify };
      }
      if (!shouldNotify) return { comparison: null, shouldNotify: false };

      reconciliationPending = true;
      return {
        comparison: { previous: lastSafe, current },
        shouldNotify: true,
      };
    },

    commit(current) {
      lastSafe = current;
      reconciliationPending = false;
    },
  };
}

export function createLastSafeSnapshotReload<T>(
  cachedSafe: () => Promise<boolean>,
  readSnapshot: () => Promise<T>,
  reload: () => Promise<boolean>,
  reconcile: (previous: T, current: T) => Promise<void>,
): LastSafeSnapshotReload {
  const snapshots = createLastSafeSnapshotTracker<T>();
  let transitionTail: Promise<void> = Promise.resolve();
  const MAX_STABILITY_PASSES = 8;

  function serialized<R>(operation: () => Promise<R>): Promise<R> {
    const result = transitionTail.then(operation, operation);
    transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function reconcileUntilStable(previous: T, current: T): Promise<boolean> {
    let before = previous;
    let target = current;
    for (let pass = 0; pass < MAX_STABILITY_PASSES; pass += 1) {
      await reconcile(before, target);
      const safe = await cachedSafe();
      if (!safe) {
        snapshots.seed(null, false);
        return false;
      }
      const latest = await readSnapshot();
      if (JSON.stringify(latest) === JSON.stringify(target)) {
        snapshots.commit(target);
        return true;
      }
      // Journal recovery or another reconciliation side effect may update the
      // cached projection. Reconcile that exact follow-up transition before
      // advancing the last-safe baseline, so a stale runtime connection cannot
      // survive behind a snapshot that was never actually committed.
      before = target;
      target = latest;
    }
    throw new Error("Portable credential reconciliation did not reach a stable snapshot.");
  }

  const run = (() =>
    serialized(async () => {
      const safeBefore = await cachedSafe();
      snapshots.seed(safeBefore ? await readSnapshot() : null, safeBefore);

      const changed = await reload();
      const safeAfter = await cachedSafe();
      const current = safeAfter ? await readSnapshot() : null;
      const transition = snapshots.afterReload(current, safeAfter, changed);
      if (transition.comparison) {
        if (
          !(await reconcileUntilStable(
            transition.comparison.previous,
            transition.comparison.current,
          ))
        ) {
          return false;
        }
      }
      return transition.shouldNotify;
    })) as LastSafeSnapshotReload;

  run.syncCurrent = () =>
    serialized(async () => {
      const safe = await cachedSafe();
      if (!safe) {
        snapshots.seed(null, false);
        return;
      }
      const current = await readSnapshot();
      // The config mutation that requested this sync may have reloaded an
      // unrelated external edit before publishing its own field. Reconcile
      // from the prior last-safe baseline before advancing it, otherwise that
      // consumed edit can leave an endpoint-bound runtime connection stale.
      const transition = snapshots.afterReload(current, true, true);
      if (transition.comparison) {
        await reconcileUntilStable(transition.comparison.previous, transition.comparison.current);
      }
    });

  return run;
}

export function createPortableConfigWatcher(
  reload: () => Promise<boolean>,
  onChanged: () => void,
  onError: (error: unknown) => void,
): PortableConfigWatcher {
  let pending: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (pending) return pending;
    const run = reload()
      .then(
        (changed) => {
          if (changed) onChanged();
        },
        (error: unknown) => onError(error),
      )
      .finally(() => {
        // Guard the identity: a refresh started after this one settled owns the
        // slot, and clearing it unconditionally would drop that one's coalescing.
        if (pending === run) pending = null;
      });
    pending = run;
    return run;
  }

  return { refresh };
}
