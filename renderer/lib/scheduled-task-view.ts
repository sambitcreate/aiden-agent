import type { ScheduledTask } from "./types";
import { formatScheduledTaskCadence } from "../shared/scheduled-task-presentation";

export type ScheduledTaskTab = "all" | "active" | "paused";

export type ScheduledTaskCadence =
  | "minutes"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

export interface ScheduledTaskScheduleDraft {
  cadence: ScheduledTaskCadence;
  time: string;
  weekday: number;
  monthDay: number;
  minuteInterval: number;
  customCron: string;
}

function numberField(value: string, minimum: number, maximum: number): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : undefined;
}

function timeValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeFields(value: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return undefined;
  const hour = numberField(match[1] ?? "", 0, 23);
  const minute = numberField(match[2] ?? "", 0, 59);
  return hour === undefined || minute === undefined ? undefined : { hour, minute };
}

/**
 * Projects the common schedules Aiden stores into the human controls used by
 * the desktop editor. Expressions outside this lossless subset stay custom so
 * an older or externally-created schedule is never rewritten on open.
 */
export function scheduleDraftFromCron(cron: string): ScheduledTaskScheduleDraft {
  const fallback: ScheduledTaskScheduleDraft = {
    cadence: "custom",
    time: "09:00",
    weekday: 1,
    monthDay: 1,
    minuteInterval: 15,
    customCron: cron,
  };
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) return fallback;
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minuteField === undefined ||
    hourField === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined ||
    month !== "*"
  ) {
    return fallback;
  }

  const intervalMatch = /^\*\/(\d+)$/u.exec(minuteField);
  if (intervalMatch && hourField === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    const minuteInterval = numberField(intervalMatch[1] ?? "", 2, 59);
    if (minuteInterval !== undefined) {
      return { ...fallback, cadence: "minutes", minuteInterval };
    }
  }

  const minute = numberField(minuteField, 0, 59);
  if (minute === undefined) return fallback;
  if (hourField === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    return { ...fallback, cadence: "hourly", time: timeValue(0, minute) };
  }

  const hour = numberField(hourField, 0, 23);
  if (hour === undefined) return fallback;
  const time = timeValue(hour, minute);
  if (dayOfMonth === "*" && dayOfWeek === "*") {
    return { ...fallback, cadence: "daily", time };
  }
  if (dayOfMonth === "*" && dayOfWeek === "1-5") {
    return { ...fallback, cadence: "weekdays", time };
  }
  if (dayOfMonth === "*") {
    const weekday = numberField(dayOfWeek, 0, 7);
    if (weekday !== undefined) {
      return { ...fallback, cadence: "weekly", time, weekday: weekday === 7 ? 0 : weekday };
    }
  }
  if (dayOfWeek === "*") {
    const monthDay = numberField(dayOfMonth, 1, 31);
    if (monthDay !== undefined) {
      return { ...fallback, cadence: "monthly", time, monthDay };
    }
  }
  return fallback;
}

/** Converts a human schedule draft back to the existing persisted cron contract. */
export function cronFromScheduleDraft(draft: ScheduledTaskScheduleDraft): string {
  if (draft.cadence === "custom") return draft.customCron.trim();
  if (draft.cadence === "minutes") {
    const interval = Number.isFinite(draft.minuteInterval)
      ? Math.min(59, Math.max(2, Math.round(draft.minuteInterval)))
      : 15;
    return `*/${interval} * * * *`;
  }
  const parsedTime = timeFields(draft.time) ?? { hour: 9, minute: 0 };
  const prefix = `${parsedTime.minute} ${parsedTime.hour}`;
  switch (draft.cadence) {
    case "hourly":
      return `${parsedTime.minute} * * * *`;
    case "daily":
      return `${prefix} * * *`;
    case "weekdays":
      return `${prefix} * * 1-5`;
    case "weekly":
      return `${prefix} * * ${Math.min(6, Math.max(0, Math.round(draft.weekday)))}`;
    case "monthly":
      return `${prefix} ${Math.min(31, Math.max(1, Math.round(draft.monthDay)))} * *`;
    default:
      return draft.customCron.trim();
  }
}

export const formatSchedule = formatScheduledTaskCadence;

export function filterScheduledTasks(
  tasks: ScheduledTask[],
  query: string,
  tab: ScheduledTaskTab,
): ScheduledTask[] {
  const normalized = query.trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    if (tab === "active" && !task.enabled) return false;
    if (tab === "paused" && task.enabled) return false;
    if (!normalized) return true;
    return `${task.name} ${task.cron} ${task.prompt ?? ""} ${task.script ?? ""}`
      .toLocaleLowerCase()
      .includes(normalized);
  });
}

export function formatNextRun(timestamp: number | undefined, now = Date.now()): string {
  if (timestamp === undefined) return "No next run";
  const delta = timestamp - now;
  const absolute = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 90_000) return formatter.format(Math.round(delta / 1_000), "second");
  if (absolute < 90 * 60_000) return formatter.format(Math.round(delta / 60_000), "minute");
  if (absolute < 36 * 3_600_000) return formatter.format(Math.round(delta / 3_600_000), "hour");
  return formatter.format(Math.round(delta / 86_400_000), "day");
}

export function scheduledTaskStatus(task: ScheduledTask): "active" | "paused" | "error" {
  if (task.lastResult === "error" || task.lastResult === "blocked") return "error";
  return task.enabled ? "active" : "paused";
}
