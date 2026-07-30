import type { ScheduledTask } from "./types";

export type ScheduledTaskTab = "all" | "active" | "paused";

const WEEKDAY_DATE_OFFSETS = [7, 8, 9, 10, 11, 12, 13] as const;

function numberField(value: string, minimum: number, maximum: number): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : undefined;
}

function clockLabel(hour: number, minute: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2024, 0, 1, hour, minute)));
}

function weekdayLabel(day: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2024, 0, WEEKDAY_DATE_OFFSETS[day] ?? 2)));
}

function conjunctionLabel(labels: string[]): string {
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function ordinal(value: number): string {
  const remainder = value % 100;
  if (remainder >= 11 && remainder <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function timezoneSuffix(timezone: string, referenceDate: Date): string {
  try {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === timezone) return "";
    const formatter = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      timeZoneName: "longGeneric",
    });
    const timezoneName = formatter
      .formatToParts(referenceDate)
      .find((part) => part.type === "timeZoneName")?.value;
    return timezoneName ? ` (${timezoneName})` : "";
  } catch {
    return "";
  }
}

function weekdayScheduleLabel(dayOfWeek: string, at: string): string | undefined {
  if (dayOfWeek === "1-5") return `Weekdays at ${at}`;

  const days = dayOfWeek.split(",").map((value) => {
    const day = numberField(value, 0, 7);
    return day === 7 ? 0 : day;
  });
  if (days.some((day) => day === undefined)) return undefined;

  const labels = [...new Set(days as number[])].map(weekdayLabel);
  if (labels.length === 1) return `Every ${labels[0]} at ${at}`;
  if (labels.length > 1) return `Every ${conjunctionLabel(labels)} at ${at}`;
  return undefined;
}

/**
 * Turns the common schedules Aiden creates into confirmation copy. Unusual
 * expressions remain valid, but the approval surface never leaks cron syntax.
 */
export function formatSchedule(cron: string, timezone: string, referenceDate = new Date()): string {
  const fields = cron.trim().split(/\s+/u);
  const normalized = fields.length === 5 ? fields : fields.length === 6 ? fields.slice(1) : [];
  if (normalized.length !== 5 || (fields.length === 6 && fields[0] !== "0")) {
    return "Custom schedule";
  }

  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = normalized;
  if (
    minuteField === undefined ||
    hourField === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    return "Custom schedule";
  }

  const suffix = timezoneSuffix(timezone, referenceDate);
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (minuteField === "*" && hourField === "*") return `Every minute${suffix}`;
    const minuteInterval = minuteField.match(/^\*\/(\d+)$/u);
    if (minuteInterval && hourField === "*") {
      const interval = numberField(minuteInterval[1] ?? "", 2, 59);
      if (interval !== undefined) return `Every ${interval} minutes${suffix}`;
    }
    if (minuteField === "0" && hourField === "*") return `Every hour${suffix}`;
  }

  const minute = numberField(minuteField, 0, 59);
  const hour = numberField(hourField, 0, 23);
  if (minute === undefined || hour === undefined || month !== "*") return "Custom schedule";
  const at = clockLabel(hour, minute);

  if (dayOfMonth === "*" && dayOfWeek === "*") return `Every day at ${at}${suffix}`;
  if (dayOfMonth === "*") {
    const schedule = weekdayScheduleLabel(dayOfWeek, at);
    return schedule ? `${schedule}${suffix}` : "Custom schedule";
  }

  const monthDay = numberField(dayOfMonth, 1, 31);
  if (monthDay !== undefined && dayOfWeek === "*") {
    return `Monthly on the ${ordinal(monthDay)} at ${at}${suffix}`;
  }
  return "Custom schedule";
}

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
