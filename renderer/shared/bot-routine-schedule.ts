/**
 * Frequency-first schedule for a Bot routine. People pick one of these in the
 * routine editor; main derives the cron expression, so raw cron never reaches
 * a Bot surface. Days of the week use 0 = Sunday … 6 = Saturday.
 */
export type BotRoutineSchedule =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "monthly"; day: number; time: string };

export type BotRoutineScheduleKind = BotRoutineSchedule["kind"];

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function invalid(): never {
  throw new Error("Invalid routine schedule.");
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(record);
  if (actual.length !== keys.length || !actual.every((key) => keys.includes(key))) invalid();
}

export function parseBotRoutineTime(value: unknown): { hour: number; minute: number } {
  if (typeof value !== "string") invalid();
  const match = TIME_PATTERN.exec(value);
  if (!match) invalid();
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function parseBotRoutineDate(value: unknown): { year: number; month: number; day: number } {
  if (typeof value !== "string") invalid();
  const match = DATE_PATTERN.exec(value);
  if (!match) invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) invalid();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) invalid();
  return { year, month, day };
}

/** Strict parser for untrusted (IPC, Remote, tool) schedule input. */
export function parseBotRoutineSchedule(value: unknown): BotRoutineSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "daily":
    case "weekdays":
      exactKeys(record, ["kind", "time"]);
      parseBotRoutineTime(record.time);
      return { kind: record.kind, time: record.time as string };
    case "weekly": {
      exactKeys(record, ["kind", "days", "time"]);
      parseBotRoutineTime(record.time);
      if (!Array.isArray(record.days) || record.days.length === 0 || record.days.length > 7) invalid();
      const days = new Set<number>();
      for (const day of record.days) {
        if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) invalid();
        days.add(day);
      }
      return { kind: "weekly", days: [...days].sort((a, b) => a - b), time: record.time as string };
    }
    case "monthly":
      exactKeys(record, ["kind", "day", "time"]);
      parseBotRoutineTime(record.time);
      if (
        typeof record.day !== "number" ||
        !Number.isInteger(record.day) ||
        record.day < 1 ||
        record.day > 31
      ) {
        invalid();
      }
      return { kind: "monthly", day: record.day, time: record.time as string };
    case "once":
      exactKeys(record, ["kind", "date", "time"]);
      parseBotRoutineTime(record.time);
      parseBotRoutineDate(record.date);
      return { kind: "once", date: record.date as string, time: record.time as string };
    default:
      return invalid();
  }
}

/** Five-part cron expression for a parsed schedule, interpreted in the routine's timezone. */
export function botRoutineCron(schedule: BotRoutineSchedule): string {
  const { hour, minute } = parseBotRoutineTime(schedule.time);
  switch (schedule.kind) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${schedule.days.join(",")}`;
    case "monthly":
      return `${minute} ${hour} ${schedule.day} * *`;
    case "once": {
      const { month, day } = parseBotRoutineDate(schedule.date);
      // Cron has no year field; the scheduler disables a one-off routine
      // when it claims its first run, so it never repeats next year.
      return `${minute} ${hour} ${day} ${month} *`;
    }
  }
}
