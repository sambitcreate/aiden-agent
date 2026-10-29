// Stuck-run watchdog (spec §5 S4). A running Bot turn that makes no progress
// for 10 minutes is stuck, unless it is waiting on the person (a hand-off, an
// approval, a question card, a computer give-back). A request waiting out a
// provider's usage limit counts as progress, so the 10 minutes start again
// when the limit clears.
//
// - A routine run is stopped and recorded as `stalled`, so routine recovery
//   retries it in the same conversation, which keeps the partial work.
// - A run the person started is never stopped on its own. The person gets one
//   issue with Stop and Keep waiting; Keep waiting snoozes another 10 minutes.
// - Time the computer spent asleep is not a stall: on wake every running Bot
//   gets a fresh window, since no run can make progress while suspended.

export const BOT_RUN_STALL_MS = 10 * 60_000;
export const BOT_RUN_WATCHDOG_INTERVAL_MS = 60_000;

export interface BotRunWatchdogDependencies {
  running(): string[];
  lastProgressAt(botId: string): number | undefined;
  runKind(botId: string): "routine" | "attended" | null;
  isWaitingOnPerson(botId: string): boolean;
  /** A request of this Bot's is held back until a provider's usage limit clears (not one already sent). */
  isWaitingOnUsageLimit?(botId: string): boolean;
  stopForStall(botId: string): Promise<void>;
  raiseStall(botId: string): Promise<void>;
  now(): number;
  setInterval(fn: () => void, ms: number): { cancel(): void };
  onError?(botId: string, error: unknown): void;
}

export interface BotRunWatchdog {
  snooze(botId: string): void;
  /** Restart every running Bot's window; call it when the computer wakes from sleep. */
  resume(): void;
  /** One pass, for tests and for the interval. */
  check(): Promise<void>;
  dispose(): void;
}

export function createBotRunWatchdog(dependencies: BotRunWatchdogDependencies): BotRunWatchdog {
  /** Per Bot: progress before this time is already handled (snoozed or flagged). */
  const handledUntil = new Map<string, number>();
  const acting = new Set<string>();

  async function check(): Promise<void> {
    const now = dependencies.now();
    const running = new Set(dependencies.running());
    for (const botId of handledUntil.keys()) if (!running.has(botId)) handledUntil.delete(botId);
    for (const botId of running) {
      if (acting.has(botId) || dependencies.isWaitingOnPerson(botId)) continue;
      if (dependencies.isWaitingOnUsageLimit?.(botId)) {
        handledUntil.set(botId, now);
        continue;
      }
      const progress = Math.max(dependencies.lastProgressAt(botId) ?? now, handledUntil.get(botId) ?? 0);
      if (now - progress < BOT_RUN_STALL_MS) continue;
      const kind = dependencies.runKind(botId);
      if (!kind) continue;
      acting.add(botId);
      try {
        if (kind === "routine") await dependencies.stopForStall(botId);
        else {
          await dependencies.raiseStall(botId);
          // Flag once per stall: wait another full window before asking again.
          handledUntil.set(botId, now);
        }
      } catch (error) {
        dependencies.onError?.(botId, error);
      } finally {
        acting.delete(botId);
      }
    }
  }

  function resume(): void {
    const now = dependencies.now();
    for (const botId of dependencies.running()) handledUntil.set(botId, now);
  }

  const timer = dependencies.setInterval(() => void check(), BOT_RUN_WATCHDOG_INTERVAL_MS);
  return {
    snooze(botId) {
      handledUntil.set(botId, dependencies.now());
    },
    resume,
    check,
    dispose: () => timer.cancel(),
  };
}

/**
 * Which Bots' current runs the watchdog stopped. The routine executor consumes
 * the mark to record the run as `stalled` rather than as an ordinary stop.
 */
export function createBotRunStalls() {
  const stalled = new Set<string>();
  return {
    mark(botId: string): void {
      stalled.add(botId);
    },
    consume(botId: string): boolean {
      return stalled.delete(botId);
    },
  };
}

export const botRunStalls = createBotRunStalls();
