import type { ScheduledTask } from "./types";

export type ScheduledTaskTab = "all" | "active" | "paused";

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
