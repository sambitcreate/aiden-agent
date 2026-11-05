export function shouldQuitAfterAllWindowsClose(
  platform: NodeJS.Platform,
  backgroundServiceRunning: boolean,
): boolean {
  return platform !== "darwin" && !backgroundServiceRunning;
}

/**
 * Electron reports `window-all-closed` only once every window is gone,
 * helper ones included. When only helper windows (the visual snapshot
 * renderer, the dictation pill) remain and closing should quit, they must be
 * released so it can.
 */
export function shouldReleaseAuxiliaryWindows(
  platform: NodeJS.Platform,
  backgroundServiceRunning: boolean,
  remaining: readonly { auxiliary: boolean }[],
): boolean {
  return (
    remaining.length > 0 &&
    remaining.every((window) => window.auxiliary) &&
    shouldQuitAfterAllWindowsClose(platform, backgroundServiceRunning)
  );
}

export interface LifecycleCheck {
  /** True while a close, reload, quit or onboarding reset is being decided. */
  readonly inFlight: boolean;
  /** Claim the check; false when another lifecycle action already holds it. */
  tryBegin(): boolean;
  /** Run `action` once the check is released, not before. */
  afterRelease(action: () => void): void;
  /** Release the check, then run the actions queued with `afterRelease`. */
  release(): void;
}

/**
 * Serializes window close, reload, quit and onboarding reset. Destroying the
 * last window fires `window-all-closed` and `before-quit` before `destroy()`
 * returns, and `before-quit` ignores a quit while a check is in flight. Work
 * that can re-enter the lifecycle that way is queued with `afterRelease`, so
 * the quit it starts is handled instead of swallowed.
 */
export function createLifecycleCheck(onError: (error: unknown) => void): LifecycleCheck {
  let inFlight = false;
  let pending: (() => void)[] = [];
  return {
    get inFlight() {
      return inFlight;
    },
    tryBegin() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    afterRelease(action) {
      pending.push(action);
    },
    release() {
      inFlight = false;
      const actions = pending;
      pending = [];
      for (const action of actions) {
        try {
          action();
        } catch (error) {
          onError(error);
        }
      }
    },
  };
}

/**
 * Run `action` once no lifecycle action holds the check. Whoever holds it owns
 * the outcome until it releases, so the action decides only after that.
 */
export function whenLifecycleCheckFree(check: LifecycleCheck, action: () => void): void {
  if (check.inFlight) check.afterRelease(() => whenLifecycleCheckFree(check, action));
  else action();
}

/**
 * An accepted update install waits for its quit. If that quit never begins
 * (the window is gone), nothing else would withdraw it, and the next ordinary
 * quit would install unasked. Call this with the check free: `false` from a
 * busy check only says this caller lost the race.
 */
export async function settleUpdateInstallQuit(
  quit: () => Promise<boolean>,
  withdraw: () => void,
  onError: (error: unknown) => void,
): Promise<void> {
  let quitting = false;
  try {
    quitting = await quit();
  } catch (error) {
    onError(error);
  }
  if (!quitting) withdraw();
}
