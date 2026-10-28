// Every event goes through here (spec §6 P1): at most one run per routine every
// 5 minutes, at most 24 a day, a repeated event id is dropped, and an event
// that arrives too soon is held (the newest wins) and runs once the gap allows.

import { BOT_ROUTINE_EVENT_LIMITS, type BotRoutineTriggerKind } from "../../../renderer/shared/bot-routine-trigger.js";
import type { BotEventRoutine, BotEventRoutineStore } from "./store.js";

export type BotRoutineEventOutcome = "queued" | "held" | "duplicate" | "daily_limit" | "disabled" | "unknown";

export interface BotRoutineEventDispatcherDependencies {
  store: Pick<BotEventRoutineStore, "mutate" | "list">;
  /** Runs the routine once with this event; resolves when the run is recorded. */
  run(routine: BotEventRoutine, event: { eventId: string; source: BotRoutineTriggerKind; payload: string }): Promise<void>;
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

  async function start(routine: BotEventRoutine, event: { eventId: string; payload: string }): Promise<void> {
    await dependencies.run(routine, { ...event, source: routine.trigger.kind });
  }

  function armHeld(botId: string, routineId: string, at: number): void {
    const key = `${botId}\0${routineId}`;
    heldTimers.get(key)?.cancel();
    heldTimers.set(key, dependencies.setTimer(() => {
      heldTimers.delete(key);
      void releaseHeld(botId, routineId).catch((error: unknown) => dependencies.onError?.(error));
    }, Math.max(0, at - dependencies.now())));
  }

  async function releaseHeld(botId: string, routineId: string): Promise<void> {
    const now = dependencies.now();
    const today = dayKey(now, dependencies.timeZone());
    const claimed = await dependencies.store.mutate(botId, routineId, (routine) => {
      if (!routine.held || !routine.enabled) return { result: undefined };
      const count = routine.day?.key === today ? routine.day.count : 0;
      if (count >= BOT_ROUTINE_EVENT_LIMITS.perDay) return { next: { ...routine, held: undefined }, result: undefined };
      const event = routine.held;
      return {
        next: { ...routine, held: undefined, lastRunAt: now, day: { key: today, count: count + 1 } },
        result: { routine, event },
      };
    });
    if (claimed) await start(claimed.routine, claimed.event);
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
        const nextAllowed = (routine.lastRunAt ?? -Infinity) + BOT_ROUTINE_EVENT_LIMITS.minGapMs;
        if (now < nextAllowed) {
          return {
            next: { ...routine, seenEventIds, held: { eventId: event.eventId, payload, at: now } },
            result: { kind: "held" as const, at: nextAllowed },
          };
        }
        return {
          next: { ...routine, seenEventIds, lastRunAt: now, day: { key: today, count: count + 1 } },
          result: { kind: "queued" as const, routine },
        };
      });
      if (!decision) return "unknown";
      if (decision.kind === "held") {
        armHeld(botId, routineId, decision.at);
        return "held";
      }
      if (decision.kind === "queued") {
        void start(decision.routine, { eventId: event.eventId, payload }).catch((error: unknown) => dependencies.onError?.(error));
        return "queued";
      }
      return decision.kind;
    },

    /** Re-arm held events after a restart. */
    async rearm(routines: readonly BotEventRoutine[]): Promise<void> {
      for (const routine of routines) {
        if (!routine.held) continue;
        armHeld(routine.botId, routine.id, (routine.lastRunAt ?? 0) + BOT_ROUTINE_EVENT_LIMITS.minGapMs);
      }
    },

    dispose(): void {
      for (const timer of heldTimers.values()) timer.cancel();
      heldTimers.clear();
    },
  };
}

export type BotRoutineEventDispatcher = ReturnType<typeof createBotRoutineEventDispatcher>;
