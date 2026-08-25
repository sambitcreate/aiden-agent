export const HOLD_POLL_MS = 30;

export interface HoldWatchDeps {
  isKeyDown: (keyCode: number) => Promise<boolean>;
  onRelease: () => void;
  setIntervalFn: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn: (timer: ReturnType<typeof setInterval>) => void;
  pollMs?: number;
}

/**
 * Poll the hold key until it is up, then fire onRelease once.
 * Returns a stop function.
 */
export function startHoldKeyWatch(keyCode: number, deps: HoldWatchDeps): () => void {
  let stopped = false;
  let released = false;
  let inflight = false;
  const pollMs = deps.pollMs ?? HOLD_POLL_MS;
  const timer = deps.setIntervalFn(() => {
    if (stopped || released || inflight) return;
    inflight = true;
    void deps
      .isKeyDown(keyCode)
      .then((down) => {
        if (stopped || released || down) return;
        released = true;
        deps.onRelease();
      })
      .catch(() => {
        // A poll failure must not stop recording; the user can still toggle.
      })
      .finally(() => {
        inflight = false;
      });
  }, pollMs);
  return () => {
    stopped = true;
    deps.clearIntervalFn(timer);
  };
}
