// A Bot's own bounded wake-ups (bot-wake-sources plan, Step 2). A wake-up is a
// one-time Bot routine marked `wakeUp`, so it fires through the routine
// machinery: claim and recovery, catch-up after a pause, the delivery funnel
// (quiet hours, daily limit, `[SILENT]`) and the Bot's own model, in the same
// Bot chat. This module owns only the bounds: when, how many, and how long the
// note may be. It never runs a turn itself.

import {
  BOT_WAKE_UP_LIMITS,
  BOT_WAKE_UP_ROUTINE_NAME,
} from "../../../renderer/shared/bot-wake-ups.js";
import { botRoutineCron, type BotRoutineSchedule } from "../../../renderer/shared/bot-routine-schedule.js";
import { nextScheduledRun } from "../schedule-store-core.js";
import { BOT_ROUTINE_CATCH_UP_WINDOW_MS, isSpentBotWakeUp, type BotRoutineService } from "../scheduled-bot-routines.js";
import type { ScheduledTask } from "../types.js";

export interface BotWakeUp {
  id: string;
  /** When it fires (epoch ms, minute resolution). */
  fireAt: number;
  /** The same moment as the host's local clock reads it: `YYYY-MM-DD HH:MM`. */
  localTime: string;
  note: string;
  setAt: number;
}

export type BotWakeUpWhen = { inMinutes: number } | { at: string };

export type BotWakeUpFailureCode =
  | "invalid_time"
  | "invalid_note"
  | "too_many_pending"
  | "not_found"
  | "off";

export type BotWakeUpOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; code: BotWakeUpFailureCode; message: string; pending?: BotWakeUp[] };

export interface BotWakeUpDependencies {
  store: { list(): Promise<ScheduledTask[]> };
  routines: Pick<BotRoutineService, "create" | "delete">;
  /** The zone wake-ups are set and shown in (the host's, like every Bot routine). */
  timezone(): string;
  /** The per-Bot switch ("Let <Bot> set its own wake-ups"); read at call time. */
  enabled(botId: string): Promise<boolean>;
  now?: () => number;
}

const MINUTE = 60_000;
/** A fire is never set closer than this, so the minute can't pass while the routine is saved. */
const HEADWAY_MS = 30_000;
const AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;

function localParts(timestamp: number, zone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

/**
 * The minute a wake-up fires and the one-time schedule that names it, or
 * `undefined` when `when` is out of bounds. `in_minutes` rounds down to a whole
 * minute but never to one less than 30 seconds away; `at` is the next time the
 * local clock reads that time (today, or tomorrow when it has passed). A time
 * the schedule can't name is refused: the second pass through an hour a
 * daylight-saving change repeats reads the same as the first, and the routine
 * would fire at the first.
 */
export function resolveBotWakeUpTime(
  when: BotWakeUpWhen,
  now: number,
  zone: string,
): { fireAt: number; schedule: Extract<BotRoutineSchedule, { kind: "once" }> } | undefined {
  let fireAt: number;
  if ("inMinutes" in when) {
    const minutes = when.inMinutes;
    if (
      !Number.isInteger(minutes) ||
      minutes < BOT_WAKE_UP_LIMITS.minMinutes ||
      minutes > BOT_WAKE_UP_LIMITS.maxMinutes
    ) {
      return undefined;
    }
    fireAt = Math.floor((now + minutes * MINUTE) / MINUTE) * MINUTE;
    if (fireAt - now < HEADWAY_MS) fireAt += MINUTE;
  } else {
    const match = AT_PATTERN.exec(when.at.trim());
    if (!match) return undefined;
    try {
      fireAt = nextScheduledRun(`${Number(match[2])} ${Number(match[1])} * * *`, zone, new Date(now));
    } catch {
      return undefined;
    }
    // A daylight-saving change can stretch "tomorrow at this time" past a day.
    if (fireAt - now > (BOT_WAKE_UP_LIMITS.maxMinutes + 60) * MINUTE) return undefined;
  }
  const local = localParts(fireAt, zone);
  const schedule = { kind: "once" as const, date: local.date, time: local.time };
  try {
    if (nextScheduledRun(botRoutineCron(schedule), zone, new Date(now)) !== fireAt) return undefined;
  } catch {
    return undefined;
  }
  return { fireAt, schedule };
}

function projectWakeUp(task: ScheduledTask, zone: string): BotWakeUp {
  const fireAt = task.nextRunAt ?? 0;
  const local = localParts(fireAt, task.timezone || zone);
  return {
    id: task.id,
    fireAt,
    localTime: `${local.date} ${local.time}`,
    note: task.prompt ?? "",
    setAt: task.wakeUp?.setAt ?? task.createdAt,
  };
}

/** Whether `task` is a wake-up of `botId` still waiting for its time. */
function isPendingWakeUp(task: ScheduledTask, botId: string): boolean {
  return task.botId === botId && task.wakeUp !== undefined && task.enabled && task.nextRunAt !== undefined;
}

const INVALID_TIME_MESSAGE = `Pick in_minutes from ${BOT_WAKE_UP_LIMITS.minMinutes} to ${BOT_WAKE_UP_LIMITS.maxMinutes}, or a local time "HH:MM" within the next 24 hours. A time in the hour a daylight-saving change repeats can't be set; pick one after it.`;

export function createBotWakeUps(dependencies: BotWakeUpDependencies) {
  const now = dependencies.now ?? Date.now;
  // One change at a time per Bot, so two calls in one turn can't both pass the cap.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(botId: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(botId) ?? Promise.resolve()).then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(botId, settled);
    void settled.then(() => {
      if (queues.get(botId) === settled) queues.delete(botId);
    });
    return run;
  };

  const pendingTasks = async (botId: string) =>
    (await dependencies.store.list())
      .filter((task) => isPendingWakeUp(task, botId))
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));

  const pending = async (botId: string): Promise<BotWakeUp[]> =>
    (await pendingTasks(botId)).map((task) => projectWakeUp(task, dependencies.timezone()));

  /** Spent wake-ups stay for the catch-up window, then go. */
  const prune = async (botId: string): Promise<void> => {
    const cutoff = now() - BOT_ROUTINE_CATCH_UP_WINDOW_MS;
    for (const task of await dependencies.store.list()) {
      if (task.botId !== botId || !isSpentBotWakeUp(task) || (task.lastRunAt ?? 0) >= cutoff) continue;
      await dependencies.routines.delete({ botId, id: task.id }, { cleanup: "background" }).catch(() => undefined);
    }
  };

  return {
    pending,

    async set(botId: string, input: { when: BotWakeUpWhen; note: string }): Promise<BotWakeUpOutcome<{ wakeUp: BotWakeUp }>> {
      const note = input.note.trim();
      if (!note || [...note].length > BOT_WAKE_UP_LIMITS.noteChars) {
        return {
          ok: false,
          code: "invalid_note",
          message: `Write a note of 1 to ${BOT_WAKE_UP_LIMITS.noteChars} characters for your future self.`,
        };
      }
      return serial(botId, async () => {
        // Read inside the queue: a switch turned off before this runs wins, and
        // one turned off after it is followed by `cancelAll` in the same queue.
        if (!(await dependencies.enabled(botId))) {
          return { ok: false, code: "off", message: "The person turned off wake-ups for this Bot." };
        }
        const zone = dependencies.timezone();
        const at = now();
        const resolved = resolveBotWakeUpTime(input.when, at, zone);
        if (!resolved) {
          return {
            ok: false,
            code: "invalid_time",
            message: INVALID_TIME_MESSAGE,
          };
        }
        await prune(botId);
        const current = await pending(botId);
        if (current.length >= BOT_WAKE_UP_LIMITS.maxPending) {
          return {
            ok: false,
            code: "too_many_pending",
            message: `You already have ${current.length} wake-ups pending. Cancel one before setting another.`,
            pending: current,
          };
        }
        let routine: Awaited<ReturnType<BotWakeUpDependencies["routines"]["create"]>>;
        try {
          routine = await dependencies.routines.create({
            botId,
            name: BOT_WAKE_UP_ROUTINE_NAME,
            schedule: resolved.schedule,
            prompt: note,
            timezone: zone,
            wakeUp: { setAt: at },
          });
        } catch {
          // The minute passed while the routine was saved (an `at` set for the next minute).
          return { ok: false, code: "invalid_time", message: INVALID_TIME_MESSAGE };
        }
        const wakeUp: BotWakeUp = {
          id: routine.id,
          fireAt: routine.nextRunAt ?? resolved.fireAt,
          localTime: `${resolved.schedule.date} ${resolved.schedule.time}`,
          note,
          setAt: at,
        };
        return { ok: true, wakeUp };
      });
    },

    async cancel(botId: string, id: string): Promise<BotWakeUpOutcome<{ cancelled: BotWakeUp }>> {
      return serial(botId, async () => {
        const task = (await pendingTasks(botId)).find((candidate) => candidate.id === id);
        if (!task) return { ok: false, code: "not_found", message: "No pending wake-up has that id.", pending: await pending(botId) };
        // In the background: settling the wake-up's issues appends to this
        // Bot's chat, which waits for the calling tool's turn to end.
        await dependencies.routines.delete(
          { botId, id: task.id, expectedUpdatedAt: task.updatedAt },
          { cleanup: "background" },
        );
        return { ok: true, cancelled: projectWakeUp(task, dependencies.timezone()) };
      });
    },

    /**
     * Remove every wake-up the Bot set (the person turned the switch off),
     * including one that fired while the Bot was paused and is still owed a
     * catch-up, or one whose fire is still being recovered. Returns how many
     * had not run yet.
     */
    async cancelAll(botId: string): Promise<number> {
      return serial(botId, async () => {
        let cancelled = 0;
        for (const task of await dependencies.store.list()) {
          if (task.botId !== botId || task.wakeUp === undefined) continue;
          const ran = isSpentBotWakeUp(task) && task.lastResult !== "skipped";
          await dependencies.routines.delete({ botId, id: task.id });
          if (!ran) cancelled += 1;
        }
        return cancelled;
      });
    },
  };
}

export type BotWakeUps = ReturnType<typeof createBotWakeUps>;
