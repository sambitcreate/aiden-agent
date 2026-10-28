// Quiet hours and a daily cap on what a Bot sends unprompted (spec §6 P4).
//
// - Issues ignore the daily cap but wait out quiet hours.
// - Routine results and proposals wait out quiet hours, and past the cap they
//   are logged but not notified. The first such row of a day adds one digest
//   ("More updates are in the chat").
// - Digests are the funnel's own summaries and always go out.
// Times are wall-clock times in the Mac's time zone.

import type { BotInterruptions } from "../../../renderer/shared/bots.js";
import type { BotDeliveryClass, BotDeliveryRow } from "./log.js";
import type { BotDeliveryGate, BotDeliveryInput } from "./funnel.js";

export type BotDeliveryDecision =
  | { kind: "now" }
  | { kind: "defer"; until: number }
  | { kind: "suppress"; reason: "daily_limit"; digestKey: string };

/** Classes that count toward, and are limited by, the daily cap. */
export const BOT_DELIVERY_COUNTED_CLASSES: ReadonlySet<BotDeliveryClass> = new Set(["routine_result", "proposal"]);

interface WallClock { year: number; month: number; day: number; minutes: number }

function wallClock(at: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(at));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), minutes: value("hour") * 60 + value("minute") };
}

/** The UTC instant of a wall-clock time in `timeZone`, settling DST by re-checking the offset. */
export function zonedInstant(year: number, month: number, day: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let instant = guess;
  for (let pass = 0; pass < 3; pass += 1) {
    const seen = wallClock(instant, timeZone);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, Math.floor(seen.minutes / 60), seen.minutes % 60);
    const drift = seenUtc - guess;
    if (drift === 0) break;
    instant -= drift;
  }
  return instant;
}

function clockMinutes(text: string): number {
  const [hours, minutes] = text.split(":").map(Number);
  return hours! * 60 + minutes!;
}

/** Whether `at` falls inside quiet hours, which may cross midnight. */
export function inQuietHours(settings: BotInterruptions, at: number, timeZone: string): boolean {
  const { enabled, start, end } = settings.quietHours;
  if (!enabled || start === end) return false;
  const now = wallClock(at, timeZone).minutes;
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** The next moment quiet hours end after `at`. */
export function quietHoursEnd(settings: BotInterruptions, at: number, timeZone: string): number {
  const end = clockMinutes(settings.quietHours.end);
  const today = wallClock(at, timeZone);
  for (let offset = 0; offset < 3; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const candidate = zonedInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), end, timeZone);
    if (candidate > at) return candidate;
  }
  return at + 24 * 3_600_000;
}

/** The start of the local day containing `at`, and its date key. */
export function localDay(at: number, timeZone: string): { start: number; key: string } {
  const today = wallClock(at, timeZone);
  const key = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  return { start: zonedInstant(today.year, today.month, today.day, 0, timeZone), key };
}

export function decideBotDelivery(input: {
  settings: BotInterruptions;
  class: BotDeliveryClass;
  botId: string;
  now: number;
  timeZone: string;
  sentToday: number;
}): BotDeliveryDecision {
  if (input.class === "digest") return { kind: "now" };
  if (inQuietHours(input.settings, input.now, input.timeZone)) {
    return { kind: "defer", until: quietHoursEnd(input.settings, input.now, input.timeZone) };
  }
  if (input.class === "issue") return { kind: "now" };
  if (input.sentToday >= input.settings.dailyLimit) {
    return { kind: "suppress", reason: "daily_limit", digestKey: `digest:limit:${localDay(input.now, input.timeZone).key}` };
  }
  return { kind: "now" };
}

export function createBotDeliveryGate(deps: {
  settings(botId: string): Promise<BotInterruptions>;
  sentToday(botId: string, dayStart: number, now: number): Promise<number>;
  timeZone(): string;
}): BotDeliveryGate {
  return {
    async decide(input: BotDeliveryInput, now: number) {
      const timeZone = deps.timeZone();
      const settings = await deps.settings(input.botId);
      const sentToday = BOT_DELIVERY_COUNTED_CLASSES.has(input.class)
        ? await deps.sentToday(input.botId, localDay(now, timeZone).start, now)
        : 0;
      return decideBotDelivery({ settings, class: input.class, botId: input.botId, now, timeZone, sentToday });
    },
  };
}

/**
 * Proactive notifications that reached the person today: each counted row,
 * except that rows sent inside one "While you were away" digest count once.
 * Suppressed rows never count; held rows count once they come due.
 */
export function countedToday(rows: readonly BotDeliveryRow[], dayStart: number, now: number): number {
  const digests = new Set<string>();
  let count = 0;
  for (const row of rows) {
    if (!BOT_DELIVERY_COUNTED_CLASSES.has(row.class) || row.suppressed === true) continue;
    if (row.deliverAfter < dayStart || row.deliverAfter > now) continue;
    if (row.coveredBy !== undefined) digests.add(row.coveredBy);
    else count += 1;
  }
  return count + digests.size;
}
