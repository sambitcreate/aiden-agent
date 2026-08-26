import type { DictationProgress, DictationStatePayload } from "../../renderer/shared/dictation.js";
import type { PasteDeliveryResult, PasteOutcome } from "./dictation-paste.js";

export type DictationStage = "idle" | "starting" | "recording" | "transcribing" | "delivering";

export interface DictationCoordinatorDeps {
  /** Resolves true when this show created a new renderer document. */
  showPill: () => Promise<boolean>;
  hidePill: () => void;
  destroyPill: () => void;
  broadcast: (payload: DictationStatePayload) => void;
  paste: (text: string) => Promise<PasteOutcome | PasteDeliveryResult>;
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
// Cloud renderers fail within 45 seconds. Parakeet owns a 120-second process
// timeout, so the coordinator's last-resort fence must not preempt local work.
export const TRANSCRIPTION_WATCHDOG_MS = 135_000;

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
  private watchdogTimer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private holdToTalk = false;
  private holdKeyCode: number | null = null;
  private holdWatchActive = false;
  private pendingRelease = false;
  private operationSequence = 0;
  private operationId: string | null = null;
  private stopHoldWatch: (() => void) | null = null;

  constructor(private readonly deps: DictationCoordinatorDeps) {}

  get currentStage(): DictationStage {
    return this.stage;
  }

  get currentOperationId(): string | null {
    return this.operationId;
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

  private clearWatchdogTimer(): void {
    if (!this.watchdogTimer) return;
    this.deps.clearTimer(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private armWatchdog(): void {
    this.clearWatchdogTimer();
    const operationId = this.operationId;
    if (!operationId) return;
    this.watchdogTimer = this.deps.setTimer(() => {
      this.watchdogTimer = null;
      void this.enqueue(() => {
        if (this.stage !== "transcribing" || this.operationId !== operationId) return;
        this.stage = "idle";
        this.operationId = null;
        this.deps.broadcast({
          state: "error",
          operationId,
          message: "Transcription took too long. Your recording was stopped safely; try again.",
        });
        this.scheduleHide(ERROR_HIDE_DELAY_MS);
      });
    }, TRANSCRIPTION_WATCHDOG_MS);
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
          this.deps.broadcast({
            state: "recording",
            operationId: this.operationId ?? undefined,
            message: "Release monitoring unavailable — press again to stop.",
          });
        },
      );
      if (typeof stop !== "function") {
        this.deps.broadcast({
          state: "recording",
          operationId: this.operationId ?? undefined,
          message: "Release monitoring unavailable — press again to stop.",
        });
        return;
      }
      this.stopHoldWatch = stop;
      this.holdWatchActive = true;
    } catch (error) {
      this.holdWatchActive = false;
      this.deps.logError("Could not watch the dictation shortcut for release.", error);
      this.deps.broadcast({
        state: "recording",
        operationId: this.operationId ?? undefined,
        message: "Release monitoring unavailable — press again to stop.",
      });
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
    this.deps.broadcast({ state: "stopping", operationId: this.operationId ?? undefined });
    this.armWatchdog();
  }

  /** Hotkey press. Toggle mode starts/stops; hold mode starts, ignores down-repeats, and stops once release is in flight. */
  press(): Promise<void> {
    return this.enqueue(async () => {
      this.clearHideTimer();
      this.clearReleaseTimer();
      if (this.stage === "idle") {
        // Freeze the activation behavior for this operation. A Settings edit
        // takes effect on the next recording, never halfway through this one.
        await this.refreshHoldMode();
        this.stage = "starting";
        this.pendingRelease = false;
        this.operationSequence += 1;
        this.operationId = `${(this.deps.now ?? Date.now)()}-${this.operationSequence}`;
        try {
          const created = await this.deps.showPill();
          if (created) this.pillReady = false;
        } catch (error) {
          this.stage = "idle";
          this.operationId = null;
          this.deps.logError("Could not show the dictation pill.", error);
          return;
        }
        if (this.stage === "starting" && this.pillReady) {
          this.stage = "recording";
          this.deps.broadcast({ state: "recording", operationId: this.operationId ?? undefined });
          this.beginHoldWatch();
          if (this.pendingRelease) this.stopIfRecording();
        }
        return;
      }
      if (this.stage === "starting") {
        // A toggle-mode second press and a hold-mode release can arrive while
        // permission/settings/microphone startup is still in flight. Latch it
        // so the first recorder frame cannot outlive the user's stop action.
        this.pendingRelease = true;
        return;
      }
      if (this.stage === "recording") {
        if (this.holdToTalk && this.holdWatchActive) return;
        this.stopIfRecording();
        return;
      }
      if (this.stage === "transcribing") {
        const operationId = this.operationId ?? undefined;
        this.stage = "idle";
        this.operationId = null;
        this.pendingRelease = false;
        this.clearWatchdogTimer();
        this.endHoldWatch();
        this.deps.broadcast({ state: "cancelled", operationId });
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
        this.deps.broadcast({ state: "recording", operationId: this.operationId ?? undefined });
        this.beginHoldWatch();
        if (this.pendingRelease) this.stopIfRecording();
      }
    });
  }

  progress(value: unknown, operationId?: unknown): Promise<void> {
    return this.enqueue(() => {
      if (
        this.stage !== "transcribing" ||
        typeof operationId !== "string" ||
        operationId !== this.operationId ||
        (value !== "finalizing" && value !== "fallback-consent" && value !== "fallback")
      ) {
        return;
      }
      this.deps.broadcast({ state: value as DictationProgress, operationId });
    });
  }

  result(value: unknown, operationId?: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (
        this.stage !== "transcribing" ||
        typeof operationId !== "string" ||
        operationId !== this.operationId
      )
        return;
      this.clearWatchdogTimer();
      this.stage = "delivering";
      this.deps.broadcast({ state: "delivering", operationId });
      this.endHoldWatch();
      this.pendingRelease = false;
      try {
        let transcript =
          typeof value === "string" ? value.trim().slice(0, MAX_TRANSCRIPT_LENGTH) : "";
        if (!transcript) {
          this.stage = "idle";
          this.operationId = null;
          this.deps.broadcast({ state: "error", operationId, message: "No speech detected." });
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
        const pasteResult = await this.deps.paste(transcript);
        const outcome = typeof pasteResult === "string" ? pasteResult : pasteResult.outcome;
        this.stage = "idle";
        this.operationId = null;
        this.deps.broadcast({
          state: outcome,
          operationId,
          reason: typeof pasteResult === "string" ? undefined : pasteResult.reason,
          message: typeof pasteResult === "string" ? undefined : pasteResult.message,
        });
        this.scheduleHide(RESULT_HIDE_DELAY_MS);
      } catch (error) {
        this.stage = "idle";
        this.operationId = null;
        this.deps.logError("Dictation delivery failed.", error);
        this.deps.broadcast({
          state: "error",
          operationId,
          message:
            error instanceof Error && error.message.trim()
              ? error.message.trim()
              : "Dictation failed.",
        });
        this.scheduleHide(ERROR_HIDE_DELAY_MS);
      }
    });
  }

  error(value: unknown, operationId?: unknown): Promise<void> {
    return this.enqueue(() => {
      if (
        this.stage === "idle" ||
        typeof operationId !== "string" ||
        operationId !== this.operationId
      )
        return;
      this.clearWatchdogTimer();
      this.stage = "idle";
      this.operationId = null;
      this.pendingRelease = false;
      this.endHoldWatch();
      this.deps.broadcast({
        state: "error",
        operationId,
        message: typeof value === "string" && value.trim() ? value.trim() : "Dictation failed.",
      });
      this.scheduleHide(ERROR_HIDE_DELAY_MS);
    });
  }

  cancel(): Promise<void> {
    return this.enqueue(() => {
      if (this.stage === "idle") return;
      const operationId = this.operationId ?? undefined;
      this.stage = "idle";
      this.operationId = null;
      this.pendingRelease = false;
      this.clearHideTimer();
      this.clearReleaseTimer();
      this.clearWatchdogTimer();
      this.endHoldWatch();
      this.deps.broadcast({ state: "cancelled", operationId });
      this.deps.hidePill();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearHideTimer();
    this.clearReleaseTimer();
    this.clearWatchdogTimer();
    this.endHoldWatch();
    this.stage = "idle";
    this.deps.destroyPill();
  }
}
