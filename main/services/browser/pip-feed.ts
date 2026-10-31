// Feeds a browser tab's Picture in Picture window from the page's CDP
// screencast. Chromium encodes each changed frame as JPEG off the main thread
// and sends nothing while the page is static; this class only decides which
// frame to paint and when to acknowledge one. Electron-free: the caller paints.

/** Picture in Picture paints at most this often, the same 4 fps as the former capture loop. */
export const PIP_FRAME_INTERVAL_MS = 250;

/** The screencast settings Picture in Picture asks for when the tab is not also recording. */
export const PIP_SCREENCAST = Object.freeze({
  format: "jpeg",
  quality: 70,
  maxWidth: 1280,
  maxHeight: 960,
  everyNthFrame: 1,
});

/** Frames larger than this are dropped rather than painted. */
export const PIP_MAX_FRAME_CHARS = 8_000_000;

export interface PipFeedOptions {
  /** Shows a base64 JPEG in the window. Rejects when the window could not paint it. */
  paint(base64Jpeg: string): Promise<void>;
  /** Acknowledges a screencast frame so Chromium sends the next one. */
  ack(sessionId: number): void;
  /** Whether anyone can see the window (it is shown and not minimized). */
  viewing(): boolean;
  intervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Chromium keeps only a couple of unacknowledged screencast frames in flight.
 * A frame whose acknowledgement the feed holds is the backpressure: it is
 * released only after the newest frame is painted, so a minimized or hidden
 * window, or a slow paint, stalls the encoder instead of queueing frames.
 */
export class PipFeed {
  private latest: string | null = null;
  private heldAcks: number[] = [];
  private painting = false;
  private lastPaint = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private disposed = false;

  constructor(private readonly options: PipFeedOptions) {}

  /**
   * A frame from the screencast. With `holdAck` the feed acknowledges it once
   * it has been painted or superseded; otherwise the caller already did.
   */
  push(base64Jpeg: unknown, sessionId: number, holdAck: boolean): void {
    if (this.disposed) {
      if (holdAck) this.options.ack(sessionId);
      return;
    }
    if (holdAck) this.heldAcks.push(sessionId);
    if (typeof base64Jpeg === "string" && base64Jpeg.length > 0 && base64Jpeg.length <= PIP_MAX_FRAME_CHARS)
      this.latest = base64Jpeg;
    this.pump();
  }

  /** The window became visible again: paint the newest frame. */
  resume(): void {
    this.pump();
  }

  /**
   * Acknowledges every held frame now, for when another consumer (a
   * recording) needs the screencast to keep flowing regardless of this window.
   */
  releaseAcks(): void {
    const held = this.heldAcks;
    this.heldAcks = [];
    for (const sessionId of held) this.options.ack(sessionId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.latest = null;
    if (this.timer !== null) (this.options.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
    this.releaseAcks();
  }

  private pump(): void {
    if (this.disposed || this.painting || this.timer !== null) return;
    if (this.latest === null) {
      // Nothing new to show; let Chromium send the next frame.
      this.releaseAcks();
      return;
    }
    if (!this.options.viewing()) return;
    const now = (this.options.now ?? Date.now)();
    const wait = this.lastPaint + (this.options.intervalMs ?? PIP_FRAME_INTERVAL_MS) - now;
    if (wait > 0) {
      this.timer = (this.options.setTimer ?? setTimeout)(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }
    const frame = this.latest;
    this.latest = null;
    this.painting = true;
    this.lastPaint = now;
    void this.options
      .paint(frame)
      .catch(() => {
        /* A closing or navigating window retries with the next frame. */
      })
      .finally(() => {
        this.painting = false;
        this.pump();
      });
  }
}
