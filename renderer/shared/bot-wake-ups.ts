/**
 * A Bot's own wake-ups: a bounded, one-time note-to-self the Bot sets with its
 * `wake_up` tool during a turn the person started. Each one is stored as a
 * one-time Bot routine marked as a wake-up, so it fires through the routine
 * machinery (claim and recovery, catch-up after a pause, quiet hours, the
 * daily limit and `[SILENT]`) into the same Bot chat.
 */
export const BOT_WAKE_UP_TOOL_NAME = "wake_up";

/** The transcript entry the tool appends when it sets a wake-up (the chat chip). */
export const BOT_WAKE_UP_ENTRY_KIND = "aiden.wake-up";

/** The routine name every wake-up carries, on the profile and on phones. */
export const BOT_WAKE_UP_ROUTINE_NAME = "Wake-up";

export const BOT_WAKE_UP_LIMITS = {
  minMinutes: 1,
  /** 24 hours: a wake-up is a short follow-up, not a schedule. */
  maxMinutes: 24 * 60,
  maxPending: 3,
  noteChars: 500,
} as const;

function dayKey(timestamp: number, zone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(timestamp),
  );
}

/**
 * When a wake-up fires, worded to follow "Wake-up": "at 3:10 PM" today,
 * "tomorrow at 9:00 AM" the next day, and the date otherwise (only seen
 * when a daylight-saving change or the clock moved).
 */
export function botWakeUpWhen(fireAt: number, now: number, zone?: string): string {
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(
    new Date(fireAt),
  );
  const day = dayKey(fireAt, zone);
  if (day === dayKey(now, zone)) return `at ${clock}`;
  if (day === dayKey(now + 24 * 60 * 60 * 1_000, zone)) return `tomorrow at ${clock}`;
  const date = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(new Date(fireAt));
  return `on ${date} at ${clock}`;
}
