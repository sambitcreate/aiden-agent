// What starts a scheduled task that has no cron: a trigger. A watch checks an
// address or a project script every N minutes and runs the task only when
// something changed (docs/plans/proactive-aiden-plan.md, Phase 4). The check
// itself never runs a model; an unchanged page or a quiet script costs nothing.
//
// Main validates every trigger with `parseScheduledTaskTrigger`; renderer and
// phone input is never trusted as-is.

import { BOT_WATCH_LIMITS, formatBotWatchInterval, parseBotWatchUrl } from "./bot-routine-trigger.js";

/** A watch checks one https address (http only to this computer) or one script from `.aiden/scripts`. */
export type ScheduledTaskWatchSource = { type: "url"; url: string } | { type: "script"; script: string };

export type ScheduledTaskTrigger = { kind: "watch"; source: ScheduledTaskWatchSource; everyMinutes: number };

export type ScheduledTaskTriggerKind = ScheduledTaskTrigger["kind"];

/** Per-task limits for trigger runs, and the overall cap on trigger runs at once. */
export const SCHEDULED_TASK_TRIGGER_LIMITS = {
  /** At most one run every 5 minutes per task. */
  minGapMs: 5 * 60_000,
  /** At most 48 runs a day per task. */
  perDay: 48,
  /** Trigger runs across every task at once. */
  runningOverall: 4,
  /** A script check's private state file. */
  checkStateBytes: 8 * 1024,
} as const;

/** The intervals the editor offers, in minutes. Any whole number from 5 to 1440 is valid. */
export const SCHEDULED_TASK_WATCH_INTERVALS = [5, 10, 15, 30, 60, 120, 360, 720, 1_440] as const;

function scriptName(value: unknown): string | undefined {
  const script = typeof value === "string" ? value.trim() : "";
  if (!script || script.length > 255 || script === "." || script === ".." ||
    script.includes("/") || script.includes("\\") || script.includes("\0")) return undefined;
  return script;
}

function invalid(): never {
  throw new Error("Invalid task trigger.");
}

/** Strict: only these shapes, nothing extra. Throws a message for the person otherwise. */
export function parseScheduledTaskTrigger(value: unknown): ScheduledTaskTrigger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (record.kind !== "watch") return invalid();
  if (!Object.keys(record).every((key) => key === "kind" || key === "source" || key === "everyMinutes")) return invalid();
  const every = record.everyMinutes;
  if (typeof every !== "number" || !Number.isInteger(every) ||
    every < BOT_WATCH_LIMITS.minMinutes || every > BOT_WATCH_LIMITS.maxMinutes) {
    throw new Error(`A watch checks every ${BOT_WATCH_LIMITS.minMinutes} to ${BOT_WATCH_LIMITS.maxMinutes} minutes.`);
  }
  const source = record.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return invalid();
  const fields = source as Record<string, unknown>;
  if (Object.keys(fields).length !== 2) return invalid();
  if (fields.type === "url") {
    const url = parseBotWatchUrl(fields.url);
    if (!url) throw new Error("Watch an https address, or http only on this computer.");
    return { kind: "watch", source: { type: "url", url }, everyMinutes: every };
  }
  if (fields.type === "script") {
    const script = scriptName(fields.script);
    if (!script) throw new Error("Choose one script file from an .aiden/scripts folder.");
    return { kind: "watch", source: { type: "script", script }, everyMinutes: every };
  }
  return invalid();
}

function shortened(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** "Every 15 min, when example.com/status changes": the line a task row shows instead of its schedule. */
export function formatScheduledTaskTriggerLabel(trigger: ScheduledTaskTrigger): string {
  const every = formatBotWatchInterval(trigger.everyMinutes);
  if (trigger.source.type === "url") {
    let shown = trigger.source.url;
    try {
      const url = new URL(trigger.source.url);
      shown = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      // Keep the address as written.
    }
    return `Every ${every}, when ${shortened(shown, 80)} changes`;
  }
  return `Every ${every}, when ${shortened(trigger.source.script, 60)} prints something`;
}
