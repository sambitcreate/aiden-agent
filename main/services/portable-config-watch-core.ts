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
