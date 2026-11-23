// When a short "come back later" fires: the time rules a Bot's `wake_up` and a
// workspace chat's `check_back` share. Each takes `in_minutes` (a whole number
// of minutes from now) or `at` ("HH:MM", the next time the local clock reads
// it, within 24 hours) and turns it into one minute on the clock. What happens
// at that minute (a one-time Bot routine, a chat notice) is the caller's.

import { nextScheduledRun } from "./schedule-store-core.js";

export const WAKE_UP_TIME_LIMITS = {
  minMinutes: 1,
  /** 24 hours: a wake-up or check-back is a short follow-up, not a schedule. */
  maxMinutes: 24 * 60,
} as const;

export type WakeUpWhen = { inMinutes: number } | { at: string };

const MINUTE = 60_000;
/** A fire is never set closer than this, so the minute can't pass while it is saved. */
const HEADWAY_MS = 30_000;
const AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;

/** What the model reads when `when` is out of bounds. */
export const WAKE_UP_INVALID_TIME_MESSAGE = `Pick in_minutes from ${WAKE_UP_TIME_LIMITS.minMinutes} to ${WAKE_UP_TIME_LIMITS.maxMinutes}, or a local time "HH:MM" within the next 24 hours.`;

/** The local calendar date and clock time of `timestamp` in `zone`. */
export function localClockParts(timestamp: number, zone: string): { date: string; time: string } {
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
 * The minute `when` names, or `undefined` when it is out of bounds.
 * `in_minutes` rounds down to a whole minute but never to one less than 30
 * seconds away; `at` is the next time the local clock in `zone` reads that
 * time (today, or tomorrow once it has passed).
 */
export function resolveWakeUpTime(
  when: WakeUpWhen,
  now: number,
  zone: string,
): { fireAt: number; local: { date: string; time: string } } | undefined {
  let fireAt: number;
  if ("inMinutes" in when) {
    const minutes = when.inMinutes;
    if (
      !Number.isInteger(minutes) ||
      minutes < WAKE_UP_TIME_LIMITS.minMinutes ||
      minutes > WAKE_UP_TIME_LIMITS.maxMinutes
    ) {
      return undefined;
    }
    fireAt = Math.floor((now + minutes * MINUTE) / MINUTE) * MINUTE;
    if (fireAt - now < HEADWAY_MS) fireAt += MINUTE;
  } else {
    if (typeof when.at !== "string") return undefined;
    const match = AT_PATTERN.exec(when.at.trim());
    if (!match) return undefined;
    try {
      fireAt = nextScheduledRun(`${Number(match[2])} ${Number(match[1])} * * *`, zone, new Date(now));
    } catch {
      return undefined;
    }
    // A daylight-saving change can stretch "tomorrow at this time" past a day.
    if (fireAt - now > (WAKE_UP_TIME_LIMITS.maxMinutes + 60) * MINUTE) return undefined;
  }
  return { fireAt, local: localClockParts(fireAt, zone) };
}
