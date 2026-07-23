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
}

const RESULT_HIDE_DELAY_MS = 1_200;
const ERROR_HIDE_DELAY_MS = 2_000;
const MAX_TRANSCRIPT_LENGTH = 100_000;

/**
 * Serialized dictation lifecycle. Every external event enters the same queue,
 * so cold-window startup, duplicate ready messages, delivery, and a new hotkey
 * can never overtake one another.
 */
export class DictationCoordinator {
  private stage: DictationStage = "idle";
  private pillReady = false;
  private hideTimer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

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

  private scheduleHide(delayMs: number): void {
    this.clearHideTimer();
    this.hideTimer = this.deps.setTimer(() => {
      this.hideTimer = null;
      if (this.stage === "idle") this.deps.hidePill();
    }, delayMs);
  }

  toggle(): Promise<void> {
    return this.enqueue(async () => {
      this.clearHideTimer();
      if (this.stage === "idle") {
        this.stage = "starting";
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
        }
        return;
      }
      if (this.stage === "starting") {
        this.stage = "idle";
        this.deps.broadcast({ state: "cancelled" });
        this.deps.hidePill();
        return;
      }
      if (this.stage === "recording") {
        this.stage = "transcribing";
        this.deps.broadcast({ state: "stopping" });
        return;
      }
      if (this.stage === "transcribing") {
        this.stage = "idle";
        this.deps.broadcast({ state: "cancelled" });
        this.deps.hidePill();
      }
      // Delivery is intentionally serialized. The queued toggle begins a new
      // recording only after the previous transcript has finished delivery.
    });
  }

  ready(): Promise<void> {
    return this.enqueue(() => {
      this.pillReady = true;
      if (this.stage === "starting") {
        this.stage = "recording";
        this.deps.broadcast({ state: "recording" });
      }
    });
  }

  result(value: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.stage !== "transcribing") return;
      this.stage = "delivering";
      const transcript =
        typeof value === "string" ? value.trim().slice(0, MAX_TRANSCRIPT_LENGTH) : "";
      if (!transcript) {
        this.stage = "idle";
        this.deps.broadcast({ state: "error", message: "No speech detected." });
        this.scheduleHide(ERROR_HIDE_DELAY_MS);
        return;
      }
      const outcome = await this.deps.paste(transcript);
      this.stage = "idle";
      this.deps.broadcast({ state: outcome });
      this.scheduleHide(RESULT_HIDE_DELAY_MS);
    });
  }

  error(value: unknown): Promise<void> {
    return this.enqueue(() => {
      if (this.stage === "idle") return;
      this.stage = "idle";
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
      this.clearHideTimer();
      this.deps.broadcast({ state: "cancelled" });
      this.deps.hidePill();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearHideTimer();
    this.stage = "idle";
    this.deps.destroyPill();
  }
}
