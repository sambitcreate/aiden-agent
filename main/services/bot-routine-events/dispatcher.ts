// Every event goes through here (spec §6 P1): at most one run per routine every
// 5 minutes, at most 24 a day, a repeated event id is dropped, and an event
// that arrives too soon is held (the newest wins) and runs once the gap allows.

import { BOT_ROUTINE_EVENT_LIMITS, type BotRoutineTriggerKind } from "../../../renderer/shared/bot-routine-trigger.js";
import { BOT_EVENT_RUNNING_MAX, type BotEventRoutine, type BotEventRoutineStore } from "./store.js";

export type BotRoutineEventOutcome = "queued" | "held" | "duplicate" | "daily_limit" | "disabled" | "unknown";

export interface BotRoutineEventDispatcherDependencies {
  store: Pick<BotEventRoutineStore, "mutate" | "list">;
  /**
   * Runs the routine once with this event; resolves when the run is recorded.
   * The same event may be run again after a restart: the run must read the
   * recorded run or the admitted turn by the event's id before sending.
   * `settled: false` (or a throw): the outcome is unknown, so the receipt
   * stays for the next start to replay.
   */
  run(routine: BotEventRoutine, event: { eventId: string; source: BotRoutineTriggerKind; payload: string }): Promise<{ settled: boolean } | void>;
  isPaused(botId: string): Promise<boolean>;
  now(): number;
  timeZone(): string;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  onError?(error: unknown): void;
}

function dayKey(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

export function createBotRoutineEventDispatcher(dependencies: BotRoutineEventDispatcherDependencies) {
  const heldTimers = new Map<string, { cancel(): void }>();
  /** Runs started and not yet settled in the store, for `idle()`. */
  const pending = new Set<Promise<void>>();
  let disposed = false;

  function track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => dependencies.onError?.(error)).finally(() => pending.delete(tracked));
    pending.add(tracked);
  }

  /** The receipt list with this event added. Callers admit only below the bound, so none is dropped. */
  function withRunning(routine: BotEventRoutine, event: { eventId: string; payload: string }, at: number) {
    const others = (routine.running ?? []).filter((entry) => entry.eventId !== event.eventId);
    return [...others, { eventId: event.eventId, payload: event.payload, at }];
  }

  /** Every receipt slot holds an unfinished run: a new event waits as the held one. */
  function full(routine: BotEventRoutine): boolean {
    return (routine.running?.length ?? 0) >= BOT_EVENT_RUNNING_MAX;
  }

  /** Runs an accepted event, then drops its receipt once the run is recorded. */
  async function start(routine: BotEventRoutine, event: { eventId: string; payload: string }): Promise<void> {
    let settled = false;
    try {
      settled = (await dependencies.run(routine, { ...event, source: routine.trigger.kind }))?.settled !== false;
    } finally {
      if (settled) await dependencies.store.mutate(routine.botId, routine.id, (current) => {
        const running = (current.running ?? []).filter((entry) => entry.eventId !== event.eventId);
        if (running.length === (current.running ?? []).length) return { result: undefined };
        const { running: _previous, ...rest } = current;
        return { next: running.length ? { ...rest, running } : rest, result: undefined };
      }).catch((error: unknown) => dependencies.onError?.(error));
    }
  }

  function armHeld(botId: string, routineId: string, at: number): void {
    const key = `${botId}\0${routineId}`;
    heldTimers.get(key)?.cancel();
    heldTimers.set(key, dependencies.setTimer(() => {
      heldTimers.delete(key);
      if (!disposed) track(releaseHeld(botId, routineId));
    }, Math.max(0, at - dependencies.now())));
  }

  async function releaseHeld(botId: string, routineId: string): Promise<void> {
    const now = dependencies.now();
    const today = dayKey(now, dependencies.timeZone());
    let retryAt: number | undefined;
    const claimed = await dependencies.store.mutate(botId, routineId, (routine) => {
      if (!routine.held || !routine.enabled) return { result: undefined };
      // Still inside the 5-minute gap (a newer event ran since this was held),
      // or every receipt slot is busy: wait for whichever ends later.
      const gapEnds = (routine.lastRunAt ?? -Infinity) + BOT_ROUTINE_EVENT_LIMITS.minGapMs;
      if (full(routine) || now < gapEnds) {
        retryAt = Math.max(gapEnds, full(routine) ? now + BOT_ROUTINE_EVENT_LIMITS.minGapMs : now);
        return { result: undefined };
      }
      const count = routine.day?.key === today ? routine.day.count : 0;
      if (count >= BOT_ROUTINE_EVENT_LIMITS.perDay) return { next: { ...routine, held: undefined }, result: undefined };
      const event = routine.held;
      return {
        next: { ...routine, held: undefined, running: withRunning(routine, event, now), lastRunAt: now, day: { key: today, count: count + 1 } },
        result: { routine, event },
      };
    });
    if (claimed) await start(claimed.routine, claimed.event);
    else if (retryAt !== undefined) armHeld(botId, routineId, retryAt);
  }

  return {
    async emit(botId: string, routineId: string, event: { eventId: string; payload: string }): Promise<BotRoutineEventOutcome> {
      if (await dependencies.isPaused(botId)) return "disabled";
      const now = dependencies.now();
      const today = dayKey(now, dependencies.timeZone());
      // Cut by length first, so a huge payload is never spread into an array.
      const payload = [...event.payload.slice(0, BOT_ROUTINE_EVENT_LIMITS.payloadChars * 2)]
        .slice(0, BOT_ROUTINE_EVENT_LIMITS.payloadChars).join("");
      type Decision =
        | { kind: "disabled" | "duplicate" | "daily_limit" }
        | { kind: "held"; at: number }
        | { kind: "queued"; routine: BotEventRoutine };
      const decision = await dependencies.store.mutate<Decision>(botId, routineId, (routine) => {
        if (!routine.enabled) return { result: { kind: "disabled" as const } };
        if (routine.seenEventIds.includes(event.eventId) || routine.held?.eventId === event.eventId) {
          return { result: { kind: "duplicate" as const } };
        }
        const seenEventIds = [...routine.seenEventIds, event.eventId].slice(-BOT_ROUTINE_EVENT_LIMITS.seenIds);
        const count = routine.day?.key === today ? routine.day.count : 0;
        if (count >= BOT_ROUTINE_EVENT_LIMITS.perDay) {
          return { next: { ...routine, seenEventIds }, result: { kind: "daily_limit" as const } };
        }
        const gapEnds = (routine.lastRunAt ?? -Infinity) + BOT_ROUTINE_EVENT_LIMITS.minGapMs;
        // Too soon, or every receipt slot is busy: hold it (the newest wins).
        const nextAllowed = full(routine) ? Math.max(gapEnds, now + BOT_ROUTINE_EVENT_LIMITS.minGapMs) : gapEnds;
        if (now < nextAllowed) {
          return {
            next: { ...routine, seenEventIds, held: { eventId: event.eventId, payload, at: now } },
            result: { kind: "held" as const, at: nextAllowed },
          };
        }
        // The receipt is written with the claim, before the caller hears
        // "queued": a quit before the run is recorded replays it.
        return {
          next: { ...routine, seenEventIds, running: withRunning(routine, { eventId: event.eventId, payload }, now), lastRunAt: now, day: { key: today, count: count + 1 } },
          result: { kind: "queued" as const, routine },
        };
      });
      if (!decision) return "unknown";
      if (decision.kind === "held") {
        armHeld(botId, routineId, decision.at);
        return "held";
      }
      if (decision.kind === "queued") {
        track(start(decision.routine, { eventId: event.eventId, payload }));
        return "queued";
      }
      return decision.kind;
    },

    /** After a restart: replay accepted events whose run wasn't recorded, and re-arm held ones. */
    async rearm(routines: readonly BotEventRoutine[]): Promise<void> {
      for (const routine of routines) {
        for (const event of routine.running ?? []) {
          track(start(routine, event));
        }
        if (!routine.held) continue;
        armHeld(routine.botId, routine.id, (routine.lastRunAt ?? 0) + BOT_ROUTINE_EVENT_LIMITS.minGapMs);
      }
    },

    dispose(): void {
      disposed = true;
      for (const timer of heldTimers.values()) timer.cancel();
      heldTimers.clear();
    },

    /** Resolves once every run started so far is recorded and its receipt settled (or kept). */
    async idle(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export type BotRoutineEventDispatcher = ReturnType<typeof createBotRoutineEventDispatcher>;
