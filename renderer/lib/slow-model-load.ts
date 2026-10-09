// Shows "Loading model…" only when an on-device model load outlasts a short
// grace period, so warm transcriptions never flash a notice.

export const SLOW_MODEL_LOAD_MS = 2000;

export type SlowModelLoadState = "loading" | "ready" | "failed" | "unloaded";

export interface SlowModelLoadNoticeDeps {
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  onShow(): void;
}

export class SlowModelLoadNotice {
  private timer: unknown = null;
  private loading = false;
  private visible = false;
  private disposed = false;

  constructor(private readonly deps: SlowModelLoadNoticeDeps) {}

  /** Feed every localVoice:state event for the active model while waiting for a result. */
  observe(state: SlowModelLoadState): void {
    if (this.disposed) return;
    if (state === "loading") {
      if (this.loading || this.visible) return;
      this.loading = true;
      this.timer = this.deps.setTimer(() => {
        this.timer = null;
        if (this.disposed || !this.loading) return;
        this.visible = true;
        this.deps.onShow();
      }, SLOW_MODEL_LOAD_MS);
      return;
    }
    // An idle unload of some earlier model says nothing about this load.
    if (state === "unloaded") return;
    this.loading = false;
    this.cancelTimer();
  }

  /** Result arrived or operation ended. */
  dispose(): void {
    this.disposed = true;
    this.loading = false;
    this.visible = false;
    this.cancelTimer();
  }

  get shown(): boolean {
    return this.visible;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}
