// Keep the computer awake while Aiden works (docs/plans/proactive-aiden-plan.md, C1).
//
// Pure: inputs, the power-save blocker, the idle clock and timers are all
// injected, so tests drive it with a fake clock. Each input reports what is
// holding the computer awake right now (and, optionally, when its answer will
// change by itself). The controller holds one blocker while any input has a
// reason, keeps it for a short grace after the last one ends so back-to-back
// runs share one hold, and lets go when nobody has used the computer for
// 4 hours, until they come back; a check-back or Bot wake-up that is due soon
// keeps it anyway, since keeping an unattended computer awake for it is the point.

import type { KeepAwakeReasonKind, KeepAwakeStatus } from "../../../renderer/shared/keep-awake.js";

/** One hold across back-to-back runs. */
export const KEEP_AWAKE_GRACE_MS = 60_000;
/** After this much system idle time the hold lets go until someone returns. */
export const KEEP_AWAKE_IDLE_CAP_SECONDS = 4 * 60 * 60;
/** How often the idle time is read while something wants the computer awake. */
export const KEEP_AWAKE_IDLE_POLL_MS = 60_000;
/** A recheck time already due is read again after this, never in a tight loop. */
const KEEP_AWAKE_MIN_RECHECK_MS = 1_000;
/**
 * A recheck never waits longer than this, so a far-off time (or a clock that
 * jumped) can't overflow the timer, which would fire at once, again and again.
 */
const KEEP_AWAKE_MAX_RECHECK_MS = 60 * 60_000;
/**
 * Holds for a check-back or Bot wake-up exist to keep an unattended computer
 * awake until it fires, so the idle cap never lets go of them.
 */
const IDLE_CAP_EXEMPT_KINDS: ReadonlySet<KeepAwakeReasonKind> = new Set(["check-back", "wake-up"]);

export interface KeepAwakeReason {
  kind: KeepAwakeReasonKind;
  /** Stable per thing (a chat id, a job id), so counts are distinct things. */
  id: string;
}

export interface KeepAwakeReading {
  reasons: readonly KeepAwakeReason[];
  /** When this input's answer changes without any event (epoch ms), if ever. */
  recheckAt?: number;
}

/** One source of reasons. New inputs are added without changing the controller. */
export interface KeepAwakeInput {
  read(now: number): KeepAwakeReading;
}

export interface KeepAwakeBlocker<Handle = unknown> {
  start(): Handle;
  stop(handle: Handle): void;
}

export interface KeepAwakeClock<Timer = unknown> {
  now(): number;
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}

export interface KeepAwakeControllerOptions<Handle, Timer> {
  blocker: KeepAwakeBlocker<Handle>;
  clock: KeepAwakeClock<Timer>;
  /** Seconds since the person last used the computer. */
  idleSeconds(): number;
  enabled?: boolean;
  onStatus?(status: KeepAwakeStatus): void;
  onError?(error: unknown): void;
}

export class KeepAwakeController<Handle = unknown, Timer = unknown> {
  private readonly inputs = new Set<KeepAwakeInput>();
  private enabled: boolean;
  private disposed = false;
  private handle: { value: Handle } | undefined;
  private reasons: KeepAwakeReason[] = [];
  private pausedWhileIdle = false;
  private graceTimer: Timer | undefined;
  private idleTimer: Timer | undefined;
  private recheckTimer: Timer | undefined;
  private lastStatus = "";

  constructor(private readonly options: KeepAwakeControllerOptions<Handle, Timer>) {
    this.enabled = options.enabled ?? true;
  }

  /** Adds an input and re-reads; the returned function removes it. */
  addInput(input: KeepAwakeInput): () => void {
    this.inputs.add(input);
    this.update();
    return () => {
      if (this.inputs.delete(input)) this.update();
    };
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.update();
  }

  /** Re-read every input. Call whenever one of them may have changed. */
  update(): void {
    if (this.disposed) return;
    const now = this.options.clock.now();
    const reasons: KeepAwakeReason[] = [];
    let recheckAt: number | undefined;
    for (const input of this.inputs) {
      let reading: KeepAwakeReading;
      try {
        reading = input.read(now);
      } catch (error) {
        // One broken input must not keep the computer awake or block the others.
        this.options.onError?.(error);
        continue;
      }
      reasons.push(...reading.reasons);
      if (reading.recheckAt !== undefined && Number.isFinite(reading.recheckAt)) {
        recheckAt = recheckAt === undefined ? reading.recheckAt : Math.min(recheckAt, reading.recheckAt);
      }
    }
    this.reasons = reasons;
    this.scheduleRecheck(recheckAt, now);

    if (!this.enabled) {
      this.clearGrace();
      this.stopIdlePoll();
      this.pausedWhileIdle = false;
      this.release();
    } else if (reasons.length > 0) {
      this.clearGrace();
      this.startIdlePoll();
      const due = reasons.some((reason) => IDLE_CAP_EXEMPT_KINDS.has(reason.kind));
      if (!due && this.readIdleSeconds() >= KEEP_AWAKE_IDLE_CAP_SECONDS) {
        this.pausedWhileIdle = true;
        this.release();
      } else {
        this.pausedWhileIdle = false;
        this.acquire();
      }
    } else {
      this.stopIdlePoll();
      this.pausedWhileIdle = false;
      if (this.handle && this.graceTimer === undefined) {
        this.graceTimer = this.options.clock.setTimeout(() => {
          this.graceTimer = undefined;
          this.release();
          this.publish();
        }, KEEP_AWAKE_GRACE_MS);
      }
    }
    this.publish();
  }

  status(): KeepAwakeStatus {
    const seen = new Map<KeepAwakeReasonKind, Set<string>>();
    for (const reason of this.reasons) {
      let ids = seen.get(reason.kind);
      if (!ids) seen.set(reason.kind, (ids = new Set()));
      ids.add(reason.id);
    }
    const counts: KeepAwakeStatus["counts"] = {};
    if (this.enabled && !this.pausedWhileIdle) {
      for (const [kind, ids] of seen) counts[kind] = ids.size;
    }
    return {
      supported: true,
      enabled: this.enabled,
      holding: this.handle !== undefined,
      pausedWhileIdle: this.pausedWhileIdle,
      counts,
    };
  }

  /** Let go now and stop listening; for quit. */
  dispose(): void {
    if (this.disposed) return;
    this.clearGrace();
    this.stopIdlePoll();
    if (this.recheckTimer !== undefined) this.options.clock.clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
    this.release();
    this.disposed = true;
    this.inputs.clear();
  }

  private acquire(): void {
    if (this.handle) return;
    try {
      this.handle = { value: this.options.blocker.start() };
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private release(): void {
    const handle = this.handle;
    if (!handle) return;
    this.handle = undefined;
    try {
      this.options.blocker.stop(handle.value);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private readIdleSeconds(): number {
    try {
      const seconds = this.options.idleSeconds();
      return Number.isFinite(seconds) ? seconds : 0;
    } catch (error) {
      this.options.onError?.(error);
      return 0;
    }
  }

  private clearGrace(): void {
    if (this.graceTimer === undefined) return;
    this.options.clock.clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
  }

  private startIdlePoll(): void {
    if (this.idleTimer !== undefined) return;
    this.idleTimer = this.options.clock.setTimeout(() => {
      this.idleTimer = undefined;
      this.update();
    }, KEEP_AWAKE_IDLE_POLL_MS);
  }

  private stopIdlePoll(): void {
    if (this.idleTimer === undefined) return;
    this.options.clock.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleRecheck(at: number | undefined, now: number): void {
    if (this.recheckTimer !== undefined) this.options.clock.clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
    if (at === undefined) return;
    this.recheckTimer = this.options.clock.setTimeout(() => {
      this.recheckTimer = undefined;
      this.update();
    }, Math.min(KEEP_AWAKE_MAX_RECHECK_MS, Math.max(KEEP_AWAKE_MIN_RECHECK_MS, at - now)));
  }

  private publish(): void {
    const status = this.status();
    const serialized = JSON.stringify(status);
    if (serialized === this.lastStatus) return;
    this.lastStatus = serialized;
    try {
      this.options.onStatus?.(status);
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
