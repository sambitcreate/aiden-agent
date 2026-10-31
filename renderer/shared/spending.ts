/**
 * Spending limits, as the app and the phones show them. Each chat has a total
 * limit, each Bot a monthly one, and each routine run its own. Only requests
 * paid for with an API key count: a Claude or ChatGPT sign-in, and models on
 * this Mac, count as $0. Device-local; nothing here leaves the Mac.
 */

/** The amounts the owner can pick, in US dollars. */
export const SPENDING_LIMIT_PRESETS_USD = [1, 2, 5, 10, 25, 50, 100, 250, 500] as const;
/** The largest limit a stored setting may hold. */
export const SPENDING_LIMIT_MAX_USD = 100_000;
/** A heads-up shows from this share of the limit on. */
export const SPENDING_NEARING_SHARE = 0.8;
/** The latest day a Bot's month may start on, so every month has it. */
export const SPENDING_MONTH_START_DAY_MAX = 28;
export const DEFAULT_SPENDING_MONTH_START_DAY = 1;

export const SPENDING_CHANGED_CHANNEL = "spending:changed";

/** Settings → Limits & spending. An absent amount means no limit. */
export interface SpendingLimitsSettings {
  /** Each chat's total, including the helpers it starts. */
  chatUsd?: number;
  /** Each Bot's month, routines included, unless the Bot sets its own. */
  botMonthUsd?: number;
  /** Each routine run. */
  routineRunUsd?: number;
  /** The day of the month a Bot's month starts over, 1 to 28, in local time. */
  monthStartDay?: number;
}

/** A limit as stored: more than zero, at most the maximum, whole cents. */
export function parseSpendingLimitUsd(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > SPENDING_LIMIT_MAX_USD) return undefined;
  const cents = Math.round(value * 100);
  return cents > 0 ? cents / 100 : undefined;
}

export function isSpendingMonthStartDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= SPENDING_MONTH_START_DAY_MAX;
}

/**
 * Strict parse of the setting. Undefined when the value is not an object or
 * holds a bad amount, so a bad patch is refused rather than half-applied.
 */
export function parseSpendingLimitsSettings(value: unknown): SpendingLimitsSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const allowed = new Set(["chatUsd", "botMonthUsd", "routineRunUsd", "monthStartDay"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return undefined;
  const parsed: SpendingLimitsSettings = {};
  for (const key of ["chatUsd", "botMonthUsd", "routineRunUsd"] as const) {
    if (input[key] === undefined) continue;
    const amount = parseSpendingLimitUsd(input[key]);
    if (amount === undefined) return undefined;
    parsed[key] = amount;
  }
  if (input.monthStartDay !== undefined) {
    if (!isSpendingMonthStartDay(input.monthStartDay)) return undefined;
    parsed.monthStartDay = input.monthStartDay;
  }
  return parsed;
}

/** "$5.00", "$0.42", "$1,250.00". An amount under a cent reads "less than $0.01". */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.005) return "less than $0.01";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "1st", "2nd", "3rd", "28th". */
export function ordinalDay(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${{ 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th"}`;
}

export type SpendingState = "under" | "nearing" | "reached";

/** One chat's or Bot's spending against its limit. Only owners with a limit have one. */
export interface SpendingStatusView {
  ownerKind: "chat" | "bot";
  ownerId: string;
  /** A chat's limit covers the whole chat; a Bot's covers its current month. */
  period: "chat" | "month";
  /** The limit in Settings, or the Bot's own. */
  limitUsd: number;
  /** What "Allow more" added on top, this period. */
  extraUsd: number;
  spentUsd: number;
  state: SpendingState;
  /** Epoch ms the Bot's month started over and starts over next. */
  periodStart?: number;
  periodEnd?: number;
}

export interface SpendingChangedEvent {
  ownerKind: "chat" | "bot";
  ownerId: string;
}

export function spendingAllowedUsd(view: Pick<SpendingStatusView, "limitUsd" | "extraUsd">): number {
  return view.limitUsd + view.extraUsd;
}

export function spendingState(spentUsd: number, allowedUsd: number): SpendingState {
  if (spentUsd >= allowedUsd) return "reached";
  return spentUsd >= allowedUsd * SPENDING_NEARING_SHARE ? "nearing" : "under";
}

function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= SPENDING_LIMIT_MAX_USD * 100;
}

function time(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Strict parse of a status from main or a host; anything malformed is dropped. */
export function parseSpendingStatusView(value: unknown): SpendingStatusView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const view = value as Record<string, unknown>;
  if (
    (view.ownerKind !== "chat" && view.ownerKind !== "bot") ||
    typeof view.ownerId !== "string" ||
    !view.ownerId ||
    (view.period !== "chat" && view.period !== "month") ||
    !amount(view.limitUsd) ||
    view.limitUsd <= 0 ||
    !amount(view.extraUsd) ||
    !amount(view.spentUsd) ||
    (view.state !== "under" && view.state !== "nearing" && view.state !== "reached") ||
    (view.periodStart !== undefined && !time(view.periodStart)) ||
    (view.periodEnd !== undefined && !time(view.periodEnd))
  ) {
    return null;
  }
  return {
    ownerKind: view.ownerKind,
    ownerId: view.ownerId,
    period: view.period,
    limitUsd: view.limitUsd,
    extraUsd: view.extraUsd,
    spentUsd: view.spentUsd,
    state: view.state,
    ...(view.periodStart !== undefined ? { periodStart: view.periodStart } : {}),
    ...(view.periodEnd !== undefined ? { periodEnd: view.periodEnd } : {}),
  };
}

/**
 * What a chat or Bot says about its spending: a quiet line while nearing, a
 * notice once reached. `name` is the Bot's name; chats say "This chat".
 */
export function spendingNotice(
  view: SpendingStatusView,
  name?: string,
): { title: string; body: string; allowMoreLabel: string } | undefined {
  if (view.state === "under") return undefined;
  const who = view.ownerKind === "bot" ? (name?.trim() || "This Bot") : "This chat";
  const allowed = spendingAllowedUsd(view);
  const period = view.period === "month" ? " this month" : "";
  const allowMoreLabel = `Allow ${formatUsd(view.limitUsd)} more`;
  if (view.state === "nearing") {
    return {
      title: `${who} has used ${formatUsd(view.spentUsd)} of its ${formatUsd(allowed)} limit${period}.`,
      body: view.ownerKind === "bot"
        ? `${who} stops when it reaches the limit.`
        : "Replies stop when the chat reaches its limit.",
      allowMoreLabel,
    };
  }
  return {
    title: `${who} reached its ${formatUsd(allowed)} spending limit${period}.`,
    body: `It has spent ${formatUsd(view.spentUsd)}. ${allowMoreLabel} to keep going, or change the limit in Settings.`,
    allowMoreLabel,
  };
}
