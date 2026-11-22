// The inputs that hold the computer awake in C1 and C3 of
// docs/plans/proactive-aiden-plan.md. Each is a pure adapter from a service's
// current state to keep-awake reasons, so it is tested without Electron.
// Later inputs (goals) are added the same way, with `KeepAwakeController.addInput`.

import type { KeepAwakeInput, KeepAwakeReason } from "./keep-awake-core.js";

/** A usage-limit wait that ends this soon holds the computer awake. */
export const KEEP_AWAKE_USAGE_LIMIT_WINDOW_MS = 10 * 60_000;

/** A check-back or Bot wake-up due this soon holds the computer awake, on AC power only. */
export const KEEP_AWAKE_DUE_SOON_WINDOW_MS = 60 * 60_000;
/**
 * While something is due soon the power source is read again this often, so
 * plugging in or unplugging is noticed on a host that sends no power events
 * (Linux).
 */
export const KEEP_AWAKE_POWER_RECHECK_MS = 5 * 60_000;

/** The parts of a `HostRunSummary` this input reads. */
export interface KeepAwakeRun {
  chatId: string;
  state: string;
}

/** The parts of a `UsageLimitWait` the inputs read. */
export interface KeepAwakeUsageLimitWait {
  owner: { kind: string; id: string };
  nextTryAt: number;
}

/** The parts of a `BackgroundJobView` this input reads. */
export interface KeepAwakeJob {
  id: string;
  state: string;
  ports?: readonly number[];
  origin?: string;
}

/** The parts of a `DoneWhenRecord` this input reads. */
export interface KeepAwakeCheck {
  chatId: string;
  state: string;
}

/**
 * A chat answering right now. A run waiting for approval or an answer from
 * the person doesn't hold, and neither does one waiting on a usage limit that
 * ends more than 10 minutes from now (the usage-limit input takes over then).
 */
export function hostRunKeepAwakeInput(sources: {
  runs(): readonly KeepAwakeRun[];
  waits(): readonly KeepAwakeUsageLimitWait[];
}): KeepAwakeInput {
  return {
    read(now) {
      const farWaits = new Map<string, number>();
      for (const wait of sources.waits()) {
        if (wait.owner.kind !== "chat" || wait.nextTryAt - now <= KEEP_AWAKE_USAGE_LIMIT_WINDOW_MS) continue;
        const soonest = farWaits.get(wait.owner.id);
        farWaits.set(wait.owner.id, soonest === undefined ? wait.nextTryAt : Math.min(soonest, wait.nextTryAt));
      }
      const reasons: KeepAwakeReason[] = [];
      let recheckAt: number | undefined;
      for (const run of sources.runs()) {
        if (run.state !== "working") continue;
        const waitUntil = farWaits.get(run.chatId);
        if (waitUntil !== undefined) {
          const due = waitUntil - KEEP_AWAKE_USAGE_LIMIT_WINDOW_MS;
          recheckAt = recheckAt === undefined ? due : Math.min(recheckAt, due);
          continue;
        }
        reasons.push({ kind: "chat", id: run.chatId });
      }
      return recheckAt === undefined ? { reasons } : { reasons, recheckAt };
    },
  };
}

/** A provider usage-limit wait (chat or Bot) that ends within 10 minutes. */
export function usageLimitKeepAwakeInput(waits: () => readonly KeepAwakeUsageLimitWait[]): KeepAwakeInput {
  return {
    read(now) {
      const reasons: KeepAwakeReason[] = [];
      let recheckAt: number | undefined;
      for (const wait of waits()) {
        const id = `${wait.owner.kind}:${wait.owner.id}`;
        if (wait.nextTryAt - now <= KEEP_AWAKE_USAGE_LIMIT_WINDOW_MS) {
          reasons.push({ kind: "usage-limit", id });
        } else {
          const due = wait.nextTryAt - KEEP_AWAKE_USAGE_LIMIT_WINDOW_MS;
          recheckAt = recheckAt === undefined ? due : Math.min(recheckAt, due);
        }
      }
      return recheckAt === undefined ? { reasons } : { reasons, recheckAt };
    },
  };
}

/**
 * A running background job with no listening port: builds and tests hold,
 * servers don't. Processes a `run_command` call left running in the
 * background (`origin: "command"`) are servers and watchers, so they don't
 * hold either.
 */
export function backgroundJobKeepAwakeInput(jobs: () => readonly KeepAwakeJob[]): KeepAwakeInput {
  return {
    read() {
      return {
        reasons: jobs()
          .filter((job) => job.state === "running" && job.origin !== "command" && !(job.ports?.length))
          .map((job) => ({ kind: "job" as const, id: job.id })),
      };
    },
  };
}

/** A "done when" (`/until`) check whose command is running now. */
export function doneWhenKeepAwakeInput(checks: () => readonly KeepAwakeCheck[]): KeepAwakeInput {
  return {
    read() {
      return {
        reasons: checks()
          .filter((check) => check.state === "running")
          .map((check) => ({ kind: "check" as const, id: check.chatId })),
      };
    },
  };
}

/** The parts of a pending check-back or Bot wake-up this input reads. */
export interface KeepAwakeDue {
  id: string;
  /** When it fires (epoch ms). */
  fireAt: number;
}

/**
 * A pending check-back or Bot wake-up due within the hour, so the computer is
 * still awake when it fires. Only on AC power: on battery nothing holds in
 * advance. One that is already more than the window overdue no longer holds,
 * so a stuck record can't keep the computer awake for good. Recurring
 * schedules, triggers and watches never hold in advance.
 */
export function dueSoonKeepAwakeInput(sources: {
  checkBacks(): readonly KeepAwakeDue[];
  wakeUps(): readonly KeepAwakeDue[];
  onBattery(): boolean;
}): KeepAwakeInput {
  return {
    read(now) {
      const reasons: KeepAwakeReason[] = [];
      const recheckTimes: number[] = [];
      const due: Array<[kind: "check-back" | "wake-up", items: readonly KeepAwakeDue[]]> = [
        ["check-back", sources.checkBacks()],
        ["wake-up", sources.wakeUps()],
      ];
      for (const [kind, items] of due) {
        for (const item of items) {
          if (!Number.isFinite(item.fireAt)) continue;
          const until = item.fireAt - now;
          if (until > KEEP_AWAKE_DUE_SOON_WINDOW_MS) {
            recheckTimes.push(item.fireAt - KEEP_AWAKE_DUE_SOON_WINDOW_MS);
          } else if (until > -KEEP_AWAKE_DUE_SOON_WINDOW_MS) {
            reasons.push({ kind, id: item.id });
            recheckTimes.push(item.fireAt + KEEP_AWAKE_DUE_SOON_WINDOW_MS);
          }
        }
      }
      if (reasons.length > 0) recheckTimes.push(now + KEEP_AWAKE_POWER_RECHECK_MS);
      const reading = recheckTimes.length > 0 ? { recheckAt: Math.min(...recheckTimes) } : {};
      return { reasons: reasons.length > 0 && sources.onBattery() ? [] : reasons, ...reading };
    },
  };
}
