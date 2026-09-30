// Idle unload policy for the on-device Parakeet recognizer. Electron-free so
// the timer/in-flight rules are testable without a utility process.

export interface ParakeetIdleUnloaderDeps<Timer> {
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  /** Current idle period, or null to keep the model loaded indefinitely. */
  idleMs: () => number | null | Promise<number | null>;
  /** Free the recognizer (terminate the worker process). */
  unload: () => void;
  logError?: (message: string, error: unknown) => void;
}

/**
 * Tracks model use and unloads after a quiet period. Work in flight (warm-up
 * or transcription) always holds the model; the countdown starts only after
 * the last lease ends, and any new lease cancels a pending unload — even one
 * whose idle period is still being read.
 */
export class ParakeetIdleUnloader<Timer = NodeJS.Timeout> {
  private active = 0;
  private loaded = false;
  private timer: Timer | null = null;
  private revision = 0;

  constructor(private readonly deps: ParakeetIdleUnloaderDeps<Timer>) {}

  get inFlight(): number {
    return this.active;
  }

  get armed(): boolean {
    return this.timer !== null;
  }

  private cancelTimer(): void {
    this.revision += 1;
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  /** Mark the model busy. Call the returned function exactly once when done. */
  begin(): () => void {
    this.cancelTimer();
    this.active += 1;
    this.loaded = true;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.active = Math.max(0, this.active - 1);
      if (this.active === 0) void this.arm();
    };
  }

  /** Re-read the idle period (e.g. after a Settings change) and restart the countdown. */
  reconfigure(): Promise<void> {
    if (this.active > 0 || !this.loaded) return Promise.resolve();
    return this.arm();
  }

  /** The model was released by other means (process exit, app shutdown, model delete). */
  forget(): void {
    this.cancelTimer();
    this.loaded = false;
  }

  private async arm(): Promise<void> {
    this.cancelTimer();
    const revision = this.revision;
    let delay: number | null;
    try {
      delay = await this.deps.idleMs();
    } catch (error) {
      this.deps.logError?.("Could not read the on-device voice idle period.", error);
      return;
    }
    if (revision !== this.revision || this.active > 0 || !this.loaded) return;
    if (delay === null || !Number.isFinite(delay) || delay < 0) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (this.active > 0 || !this.loaded) return;
      this.loaded = false;
      try {
        this.deps.unload();
      } catch (error) {
        this.deps.logError?.("Could not unload the idle on-device voice model.", error);
      }
    }, delay);
  }
}
