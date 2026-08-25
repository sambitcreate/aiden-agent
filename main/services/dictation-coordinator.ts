import type { DictationStatePayload } from "../../renderer/shared/dictation.js";
import type { PasteOutcome } from "./dictation-paste.js";

export type DictationStage =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "delivering";

export interface DictationCoordinatorDeps {
  /** Resolves true when this show created a new renderer document. */
  showPill: () => Promise<boolean>;
  hidePill: () => void;
  destroyPill: () => void;
  broadcast: (payload: DictationStatePayload) => void;
  paste: (text: string) => Promise<PasteOutcome>;
  setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer: (timer: NodeJS.Timeout) => void;
  logError: (message: string, error: unknown) => void;
  now?: () => number;
  isHoldToTalk?: () => boolean | Promise<boolean>;
  /** Optional polish after STT; must return the original text on failure. */
  cleanupTranscript?: (text: string) => Promise<string>;
  shouldCleanup?: () => boolean | Promise<boolean>;
  getHoldKeyCode?: () => number | null | Promise<number | null>;
  startHoldWatch?: (
    keyCode: number,
    onRelease: () => void,
    onFailed?: () => void,
  ) => (() => void) | null | undefined;
}

const RESULT_HIDE_DELAY_MS = 1_200;
const ERROR_HIDE_DELAY_MS = 2_000;
const MAX_TRANSCRIPT_LENGTH = 100_000;
export const HOLD_RELEASE_GRACE_MS = 50;

/**
 * Serialized dictation lifecycle. Every external event enters the same queue,
 * so cold-window startup, duplicate ready messages, delivery, and a new hotkey
 * can never overtake one another.
 */
export class DictationCoordinator {
  private stage: DictationStage = "idle";
  private pillReady = false;
  private hideTimer: NodeJS.Timeout | null = null;
  private releaseTimer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private holdToTalk = false;
  private holdKeyCode: number | null = null;
  private holdWatchActive = false;
  private pendingRelease = false;
  private stopHoldWatch: (() => void) | null = null;

  constructor(private readonly deps: DictationCoordinatorDeps) {}

  get currentStage(): DictationStage {
    return this.stage;
  }

  private enqueue(operation: () => Promise<void> | void): Promise<void> {
    const pending = this.queue.then(async () => {
      if (!this.disposed) await operation();
    });
    this.queue = pending.catch((error) => {
      this.deps.logError("Dictation coordinator operation failed.", error);
    });
    return pending;
  }

  private clearHideTimer(): void {
    if (!this.hideTimer) return;
    this.deps.clearTimer(this.hideTimer);
    this.hideTimer = null;
  }

  private clearReleaseTimer(): void {
    if (!this.releaseTimer) return;
    this.deps.clearTimer(this.releaseTimer);
    this.releaseTimer = null;
  }

  private endHoldWatch(): void {
    this.stopHoldWatch?.();
    this.stopHoldWatch = null;
    this.holdWatchActive = false;
  }

  private beginHoldWatch(): void {
    this.endHoldWatch();
    if (!this.holdToTalk || this.holdKeyCode === null || !this.deps.startHoldWatch) return;
    try {
      const stop = this.deps.startHoldWatch(
        this.holdKeyCode,
        () => {
          void this.release();
        },
        () => {
          this.holdWatchActive = false;
          this.stopHoldWatch = null;
        },
      );
      if (typeof stop !== "function") return;
      this.stopHoldWatch = stop;
      this.holdWatchActive = true;
    } catch (error) {
      this.holdWatchActive = false;
      this.deps.logError("Could not watch the dictation shortcut for release.", error);
    }
  }

  private scheduleHide(delayMs: number): void {
    this.clearHideTimer();
    this.hideTimer = this.deps.setTimer(() => {
      this.hideTimer = null;
      if (this.stage === "idle") this.deps.hidePill();
    }, delayMs);
  }

  private async refreshHoldMode(): Promise<void> {
    this.holdToTalk = (await this.deps.isHoldToTalk?.()) === true;
    const code = await this.deps.getHoldKeyCode?.();
    this.holdKeyCode = typeof code === "number" ? code : null;
  }

  private stopIfRecording(): void {
    if (this.stage !== "recording") return;
    this.endHoldWatch();
    this.stage = "transcribing";
    this.deps.broadcast({ state: "stopping" });
  }

  /** Hotkey press. Toggle mode starts/stops; hold mode starts, ignores down-repeats, and stops once release is in flight. */
  press(): Promise<void> {
    return this.enqueue(async () => {
      this.clearHideTimer();
      this.clearReleaseTimer();
      await this.refreshHoldMode();
      if (this.stage === "idle") {
        this.stage = "starting";
        this.pendingRelease = false;
        try {
          const created = await this.deps.showPill();
          if (created) this.pillReady = false;
        } catch (error) {
          this.stage = "idle";
          this.deps.logError("Could not show the dictation pill.", error);
          return;
        }
        if (this.stage === "starting" && this.pillReady) {
          this.stage = "recording";
          this.deps.broadcast({ state: "recording" });
          this.beginHoldWatch();
          if (this.pendingRelease) this.stopIfRecording();
        }
        return;
      }
      if (this.stage === "starting") {
        if (this.holdToTalk) return;
        this.stage = "idle";
        this.pendingRelease = false;
        this.endHoldWatch();
        this.deps.broadcast({ state: "cancelled" });
        this.deps.hidePill();
        return;
      }
      if (this.stage === "recording") {
        if (this.holdToTalk && this.holdWatchActive) return;
        this.stopIfRecording();
        return;
      }
      if (this.stage === "transcribing") {
        this.stage = "idle";
        this.pendingRelease = false;
        this.endHoldWatch();
        this.deps.broadcast({ state: "cancelled" });
        this.deps.hidePill();
      }
      // Delivery is intentionally serialized. The queued press begins a new
      // recording only after the previous transcript has finished delivery.
    });
  }

  /** Backward-compatible alias for press(). */
  toggle(): Promise<void> {
    return this.press();
  }

  /** Hold-to-talk key-up, with a short grace so OS repeats do not cut capture. */
  release(): Promise<void> {
    return this.enqueue(async () => {
      await this.refreshHoldMode();
      if (!this.holdToTalk) return;
      if (this.stage === "starting") {
        this.pendingRelease = true;
        return;
      }
      if (this.stage !== "recording") return;
      this.clearReleaseTimer();
      // End the key watch before the grace window so a re-press can still
      // stop recording. Leaving the watch "active" would ignore that press
      // after this timer is cancelled.
      this.endHoldWatch();
      this.releaseTimer = this.deps.setTimer(() => {
        this.releaseTimer = null;
        void this.enqueue(() => {
          if (this.holdToTalk) this.stopIfRecording();
        });
      }, HOLD_RELEASE_GRACE_MS);
    });
  }

  /** Silence detector or explicit stop while recording. */
  stopRecording(): Promise<void> {
    return this.enqueue(() => {
      this.clearReleaseTimer();
      this.stopIfRecording();
    });
  }

  ready(): Promise<void> {
    return this.enqueue(() => {
      this.pillReady = true;
      if (this.stage === "starting") {
        this.stage = "recording";
        this.deps.broadcast({ state: "recording" });
        this.beginHoldWatch();
        if (this.pendingRelease) this.stopIfRecording();
      }
    });
  }

  result(value: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.stage !== "transcribing") return;
      this.stage = "delivering";
      this.endHoldWatch();
      this.pendingRelease = false;
      try {
        let transcript =
          typeof value === "string" ? value.trim().slice(0, MAX_TRANSCRIPT_LENGTH) : "";
        if (!transcript) {
          this.stage = "idle";
          this.deps.broadcast({ state: "error", message: "No speech detected." });
          this.scheduleHide(ERROR_HIDE_DELAY_MS);
          return;
        }
        try {
          if ((await this.deps.shouldCleanup?.()) === true && this.deps.cleanupTranscript) {
            const cleaned = (await this.deps.cleanupTranscript(transcript)).trim();
            if (cleaned) transcript = cleaned.slice(0, MAX_TRANSCRIPT_LENGTH);
          }
        } catch (error) {
          this.deps.logError("Dictation cleanup failed; using the original transcript.", error);
        }
        const outcome = await this.deps.paste(transcript);
        this.stage = "idle";
        this.deps.broadcast({ state: outcome });
        this.scheduleHide(RESULT_HIDE_DELAY_MS);
      } catch (error) {
        this.stage = "idle";
        this.deps.logError("Dictation delivery failed.", error);
        this.deps.broadcast({
          state: "error",
          message: error instanceof Error && error.message.trim() ? error.message.trim() : "Dictation failed.",
        });
        this.scheduleHide(ERROR_HIDE_DELAY_MS);
      }
    });
  }

  error(value: unknown): Promise<void> {
    return this.enqueue(() => {
      if (this.stage === "idle") return;
      this.stage = "idle";
      this.pendingRelease = false;
      this.endHoldWatch();
      this.deps.broadcast({
        state: "error",
        message:
          typeof value === "string" && value.trim() ? value.trim() : "Dictation failed.",
      });
      this.scheduleHide(ERROR_HIDE_DELAY_MS);
    });
  }

  cancel(): Promise<void> {
    return this.enqueue(() => {
      if (this.stage === "idle") return;
      this.stage = "idle";
      this.pendingRelease = false;
      this.clearHideTimer();
      this.clearReleaseTimer();
      this.endHoldWatch();
      this.deps.broadcast({ state: "cancelled" });
      this.deps.hidePill();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearHideTimer();
    this.clearReleaseTimer();
    this.endHoldWatch();
    this.stage = "idle";
    this.deps.destroyPill();
  }
}
