/**
 * Waiting out provider usage limits, as the app shows it. When a provider
 * turns a request away for a rate limit or a subscription window before any
 * reply, the request waits for the limit to clear and sends again with the
 * same model. Device-local; nothing here leaves the Mac.
 */

/** The longest waits the owner can choose, in hours. 0 turns waiting off. */
export const USAGE_LIMIT_WAIT_HOURS = [0, 1, 6, 12, 24] as const;
export type UsageLimitWaitHours = (typeof USAGE_LIMIT_WAIT_HOURS)[number];
export const DEFAULT_USAGE_LIMIT_WAIT_HOURS: UsageLimitWaitHours = 6;

export function isUsageLimitWaitHours(value: unknown): value is UsageLimitWaitHours {
  return (USAGE_LIMIT_WAIT_HOURS as readonly unknown[]).includes(value);
}

/** A time as people read it after "resets": "at 3:40 PM" today, "Thursday at 9:00 AM" this week, else "Nov 3 at 9:00 AM". */
export function formatUsageLimitTime(at: number, now: number, options: { locale?: string; timeZone?: string } = {}): string {
  const zone = options.timeZone ? { timeZone: options.timeZone } : {};
  const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...zone });
  const time = new Intl.DateTimeFormat(options.locale, { hour: "numeric", minute: "2-digit", ...zone }).format(at);
  if (day.format(at) === day.format(now)) return `at ${time}`;
  if (at > now && at - now < 6 * 24 * 60 * 60_000) {
    return `${new Intl.DateTimeFormat(options.locale, { weekday: "long", ...zone }).format(at)} at ${time}`;
  }
  return `${new Intl.DateTimeFormat(options.locale, { month: "short", day: "numeric", ...zone }).format(at)} at ${time}`;
}

export const USAGE_LIMITS_CHANGED_CHANNEL = "usageLimits:changed";

/** One chat or Bot reply that is waiting for a usage limit. */
export interface UsageLimitWaitView {
  ownerKind: "chat" | "bot";
  ownerId: string;
  /** The provider's name, such as "Claude" or "ChatGPT". */
  providerLabel: string;
  modelId: string;
  /** Epoch ms of the next try. */
  nextTryAt: number;
  /** Epoch ms the provider said the limit resets, when it said. */
  resetAt?: number;
  /** The test request is out now. */
  trying: boolean;
}

export interface UsageLimitsChangedEvent {
  waits: UsageLimitWaitView[];
}

function finiteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Strict parse of one wait from main; anything malformed is dropped. */
export function parseUsageLimitWaitView(value: unknown): UsageLimitWaitView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wait = value as Record<string, unknown>;
  if (
    (wait.ownerKind !== "chat" && wait.ownerKind !== "bot") ||
    typeof wait.ownerId !== "string" ||
    !wait.ownerId ||
    typeof wait.providerLabel !== "string" ||
    typeof wait.modelId !== "string" ||
    !finiteTime(wait.nextTryAt) ||
    (wait.resetAt !== undefined && !finiteTime(wait.resetAt)) ||
    typeof wait.trying !== "boolean"
  ) {
    return null;
  }
  return {
    ownerKind: wait.ownerKind,
    ownerId: wait.ownerId,
    providerLabel: wait.providerLabel.slice(0, 120),
    modelId: wait.modelId.slice(0, 200),
    nextTryAt: wait.nextTryAt,
    ...(wait.resetAt !== undefined ? { resetAt: wait.resetAt } : {}),
    trying: wait.trying,
  };
}

export function parseUsageLimitWaits(value: unknown): UsageLimitWaitView[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((wait) => {
    const parsed = parseUsageLimitWaitView(wait);
    return parsed ? [parsed] : [];
  });
}

/** The wait to show for one chat or Bot: the soonest try among its waiting requests. */
export function usageLimitWaitFor(
  waits: readonly UsageLimitWaitView[],
  ownerKind: UsageLimitWaitView["ownerKind"],
  ownerId: string,
): UsageLimitWaitView | undefined {
  let found: UsageLimitWaitView | undefined;
  for (const wait of waits) {
    if (wait.ownerKind !== ownerKind || wait.ownerId !== ownerId) continue;
    if (!found || (wait.trying && !found.trying) || (!found.trying && wait.nextTryAt < found.nextTryAt)) found = wait;
  }
  return found;
}

/** The one-line status of a waiting reply: "Waiting for Claude's usage limit · next try at 3:40 PM". */
export function usageLimitWaitLabel(
  wait: Pick<UsageLimitWaitView, "providerLabel" | "nextTryAt" | "trying">,
  now: number,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const provider = wait.providerLabel.trim() || "the provider";
  if (wait.trying || wait.nextTryAt <= now) return `Trying ${provider} again…`;
  return `Waiting for ${provider}’s usage limit · next try ${formatUsageLimitTime(wait.nextTryAt, now, options)}`;
}
