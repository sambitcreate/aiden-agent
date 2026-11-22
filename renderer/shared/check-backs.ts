// Chats that check back: during a turn the person started, the agent in a
// workspace chat can promise to look again later ("I'll check the deploy in
// 20 minutes") with its `check_back` tool. Main keeps the promise: at that
// minute it posts a "Checking back" notice into the same chat, which wakes the
// chat like any other follow-up. This file is the contract main and the
// renderer share: the tool name, the bounds and how a time reads.

import { botWakeUpWhen } from "./bot-wake-ups.js";

export const CHECK_BACK_TOOL_NAME = "check_back";

export const CHECK_BACK_LIMITS = {
  minMinutes: 1,
  /** 24 hours: a check-back is a short follow-up, not a schedule. */
  maxMinutes: 24 * 60,
  maxPendingPerChat: 3,
  maxPendingTotal: 20,
  noteChars: 500,
  /** A check-back found this late (Aiden was asleep or closed) still wakes the chat; older ones leave a note. */
  lateWindowMs: 2 * 60 * 60 * 1_000,
} as const;

/** One promise the chat made, as the composer chip and the tool's `list` show it. */
export interface CheckBackView {
  id: string;
  /** When it fires (epoch ms, minute resolution). */
  fireAt: number;
  note: string;
  setAt: number;
}

/** "3:10 PM" in `zone` (the host's when omitted). */
export function checkBackClock(timestamp: number, zone?: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

/**
 * When a check-back fires, worded to follow "Checking back": "at 3:10 PM"
 * today, "tomorrow at 9:00 AM" the next day, the date otherwise.
 */
export function checkBackWhen(fireAt: number, now: number, zone?: string): string {
  return botWakeUpWhen(fireAt, now, zone);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape check for one check-back in the follow-through IPC answer. */
export function parseCheckBackView(value: unknown): CheckBackView | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.fireAt !== "number" ||
    !Number.isFinite(value.fireAt) ||
    typeof value.note !== "string" ||
    typeof value.setAt !== "number" ||
    !Number.isFinite(value.setAt)
  ) {
    return undefined;
  }
  return { id: value.id, fireAt: value.fireAt, note: value.note, setAt: value.setAt };
}
