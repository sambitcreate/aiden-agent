// Waiting out provider usage limits. When a model request is rejected before
// any content because of a rate limit, an overload or a subscription window,
// the request waits for the limit to clear and tries again instead of failing.
// This file holds the pure parts: what a rejection means (from its status,
// headers and text), how long to wait, and the gate that lets one waiting
// request per limit test it while the others queue behind it. Nothing here
// changes the model a request uses, and a rejected request costs nothing.

import {
  DEFAULT_USAGE_LIMIT_WAIT_HOURS,
  formatUsageLimitTime,
  isUsageLimitWaitHours,
} from "../../renderer/shared/usage-limits.js";

export {
  DEFAULT_USAGE_LIMIT_WAIT_HOURS,
  formatUsageLimitTime,
  isUsageLimitWaitHours,
  USAGE_LIMIT_WAIT_HOURS,
  type UsageLimitWaitHours,
} from "../../renderer/shared/usage-limits.js";

/** What a request's last HTTP response said, when the transport exposed it. */
export interface ProviderResponseObservation {
  status?: number;
  headers?: Readonly<Record<string, string>>;
}

/**
 * `account`: a limit of the whole sign-in or key (a subscription window), so
 * every model of the provider waits. `model`: a limit of one model (a 429, an
 * overload, a per-model cap).
 */
export type UsageLimitScope = "account" | "model";

export type UsageLimitVerdict =
  /** Not a usage limit: the error goes on as it does today. */
  | { kind: "none" }
  /**
   * Waitable. `resetAt` is the provider's own time, when it gave one. `plan`
   * marks a plan's usage limit with no time, which is retried slowly.
   */
  | { kind: "wait"; scope: UsageLimitScope; resetAt?: number; plan?: boolean }
  /**
   * A limit that is not worth waiting for: a window of days, or billing. The
   * run fails at once, with the reset time in its message when one is known.
   */
  | { kind: "stop"; reason: "long-window" | "billing"; resetAt?: number };

/** A rejection with no time is tried again at growing intervals, for at most this long. */
export const USAGE_LIMIT_BACKOFF_MAX_MS = 30 * 60_000;
const BACKOFF_STEPS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
const BACKOFF_FLOOR_MS = 600_000;
/** A plan's usage limit with no time is tried about this often, up to the longest wait. */
export const USAGE_LIMIT_PLAN_RETRY_MS = 15 * 60_000;
/** No wait is shorter, so `retry-after: 0` cannot make a loop. */
export const USAGE_LIMIT_MIN_WAIT_MS = 5_000;
/** Windows longer than this are days away: not waited for. */
const LONG_WINDOW_MINUTES = 300;
/** Retry now sends at most one test request per limit this often. */
export const USAGE_LIMIT_RETRY_NOW_INTERVAL_MS = 30_000;
/** After a give-up, new requests on that limit fail at once for this long (or until the reset). */
export const USAGE_LIMIT_REFUSE_MS = 5 * 60_000;
/** Entries older than this are dropped on load. */
const USAGE_LIMIT_ENTRY_TTL_MS = 25 * 60 * 60_000;
/** A limit nobody tried for this long after its try time starts over when it is hit again. */
const USAGE_LIMIT_STALE_MS = 15 * 60_000;

export function usageLimitMaxWaitMs(hours: unknown): number {
  return (isUsageLimitWaitHours(hours) ? hours : DEFAULT_USAGE_LIMIT_WAIT_HOURS) * 60 * 60_000;
}

function header(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

/**
 * A duration such as `20s`, `6m0s`, `1h2m3.5s`, `250ms`, `90` (seconds) or
 * `3 hours 12 minutes`. Undefined when nothing reads as a duration.
 */
export function parseUsageLimitDuration(text: string): number | undefined {
  const trimmed = text.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed) * 1_000;
  const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h)(?![a-z])/gu)];
  if (parts.length === 0) return undefined;
  let total = 0;
  for (const [, amount, unit] of parts) total += Number(amount) * (UNIT_MS[unit] ?? 0);
  return Number.isFinite(total) ? total : undefined;
}

/** An instant as epoch seconds, epoch milliseconds, or an RFC 3339 / HTTP date. */
function parseInstant(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const number = Number(trimmed);
    if (number >= 1e12) return Math.round(number);
    if (number >= 1e9) return Math.round(number * 1_000);
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `retry-after`: delta seconds or an HTTP date. */
function retryAfterAt(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return now + Number(trimmed) * 1_000;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A reset header that may be delta seconds, a duration, epoch seconds, or a date. */
function resetHeaderAt(value: string, now: number): number | undefined {
  const instant = parseInstant(value);
  if (instant !== undefined) return instant;
  const duration = parseUsageLimitDuration(value);
  return duration === undefined ? undefined : now + duration;
}

function future(at: number | undefined, now: number): number | undefined {
  return at !== undefined && Number.isFinite(at) && at > now ? at : undefined;
}

function earliest(values: readonly (number | undefined)[], now: number): number | undefined {
  const times = values.map((value) => future(value, now)).filter((value): value is number => value !== undefined);
  return times.length ? Math.min(...times) : undefined;
}

/** Claude subscription windows: the `anthropic-ratelimit-unified-*` headers. */
function anthropicUnifiedVerdict(
  headers: Readonly<Record<string, string>> | undefined,
  now: number,
): UsageLimitVerdict | undefined {
  const status = header(headers, "anthropic-ratelimit-unified-status");
  const weekly = header(headers, "anthropic-ratelimit-unified-7d-status");
  const session = header(headers, "anthropic-ratelimit-unified-5h-status");
  const claim = header(headers, "anthropic-ratelimit-unified-representative-claim") ?? "";
  const rejected = (value: string | undefined) => value?.toLowerCase() === "rejected";
  if (!rejected(status) && !rejected(weekly) && !rejected(session)) return undefined;
  const at = (name: string) => {
    const value = header(headers, name);
    return value === undefined ? undefined : future(parseInstant(value), now);
  };
  if (rejected(weekly) || (!rejected(session) && /seven_day|7d|week/iu.test(claim))) {
    return { kind: "stop", reason: "long-window", ...withReset(at("anthropic-ratelimit-unified-7d-reset") ?? at("anthropic-ratelimit-unified-reset")) };
  }
  return {
    kind: "wait",
    scope: "account",
    ...withReset(at("anthropic-ratelimit-unified-5h-reset") ?? at("anthropic-ratelimit-unified-reset")),
  };
}

/** ChatGPT sign-in windows: the `x-codex-{primary,secondary}-*` headers. */
function codexWindowVerdict(
  headers: Readonly<Record<string, string>> | undefined,
  now: number,
): UsageLimitVerdict | undefined {
  let wait: number | undefined;
  let waiting = false;
  for (const window of ["primary", "secondary"] as const) {
    const used = Number(header(headers, `x-codex-${window}-used-percent`));
    if (!Number.isFinite(used) || used < 100) continue;
    const afterSeconds = Number(header(headers, `x-codex-${window}-reset-after-seconds`));
    const resetAtHeader = header(headers, `x-codex-${window}-reset-at`);
    const resetAt = future(
      Number.isFinite(afterSeconds) ? now + afterSeconds * 1_000 : resetAtHeader ? parseInstant(resetAtHeader) : undefined,
      now,
    );
    const minutes = Number(header(headers, `x-codex-${window}-window-minutes`));
    if (Number.isFinite(minutes) && minutes > LONG_WINDOW_MINUTES) {
      return { kind: "stop", reason: "long-window", ...withReset(resetAt) };
    }
    waiting = true;
    wait = wait === undefined ? resetAt : resetAt === undefined ? wait : Math.max(wait, resetAt);
  }
  return waiting ? { kind: "wait", scope: "account", ...withReset(wait) } : undefined;
}

function withReset(resetAt: number | undefined): { resetAt?: number } {
  return resetAt === undefined ? {} : { resetAt };
}

/** Reset times in standard and per-provider rate-limit headers. */
function headerResetAt(headers: Readonly<Record<string, string>> | undefined, now: number): number | undefined {
  const retryAfterMs = header(headers, "retry-after-ms");
  if (retryAfterMs !== undefined && Number.isFinite(Number(retryAfterMs))) return now + Number(retryAfterMs);
  const retryAfter = header(headers, "retry-after");
  if (retryAfter !== undefined) {
    const at = retryAfterAt(retryAfter, now);
    if (at !== undefined) return at;
  }
  const resets = [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset",
    "ratelimit-reset",
    "x-ratelimit-reset",
  ].map((name) => {
    const value = header(headers, name);
    return value === undefined ? undefined : resetHeaderAt(value, now);
  });
  return earliest(resets, now);
}

const BILLING =
  /insufficient[_ -]?quota|credit balance|credits? (?:exhausted|depleted)|out of (?:budget|credits)|payment required|Monthly usage limit reached|GoUsageLimitError|FreeUsageLimitError|available balance|subscription_sharing_workplace_individual_usage_limit_exceeded/iu;
/**
 * "Check your plan and billing details": OpenAI's wording for an account out of
 * credit, which Google also uses for per-minute limits. Google's comes with a
 * retry delay in the text, so only the wording without one is billing.
 */
const BILLING_HINT = /billing|exceeded your current quota/iu;
const LONG_WINDOW_TEXT =
  /\b(?:weekly|monthly|daily|7[- ]day|seven[_ -]day)\b[^\n.]{0,40}\b(?:usage|rate)?\s*(?:limit|cap|quota)|requests? per day|PerDay/iu;
const PLAN_LIMIT = /subscription_sharing_usage_limit_exceeded|usage[_ ]limit[_ ]reached|usage limit has been reached|hit your [A-Za-z]+ usage limit/iu;
const RATE_LIMITED =
  /\b429\b|\b529\b|Server requested \d+(?:\.\d+)?s retry delay|rate[_ -]?limit|too many requests|resource[_ ]?exhausted|overloaded|server[_ ]?busy|servers are currently busy|currently experiencing high demand|model is at capacity|usage[_ ]limit/iu;
const CONTEXT_OVERFLOW =
  /context (?:window|length)|maximum context|prompt is too long|too many (?:input )?tokens|request (?:is )?too large/iu;

/** Reset times written into error text by providers and SDKs. */
export function textResetAt(text: string, now: number): number | undefined {
  const delay = /Server requested (\d+(?:\.\d+)?)s retry delay/iu.exec(text);
  if (delay) return now + Number(delay[1]) * 1_000;
  const resetsAt = /"resets?_at"\s*:\s*"?(\d{9,13}(?:\.\d+)?)"?/iu.exec(text);
  if (resetsAt) {
    const at = parseInstant(resetsAt[1]);
    if (at !== undefined) return at;
  }
  const resetsIn = /"resets?_in_seconds"\s*:\s*(\d+(?:\.\d+)?)/iu.exec(text);
  if (resetsIn) return now + Number(resetsIn[1]) * 1_000;
  const retryDelay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/iu.exec(text);
  if (retryDelay) return now + Number(retryDelay[1]) * 1_000;
  const resetAtDate = /\breset(?:s)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/iu.exec(text);
  if (resetAtDate) {
    const at = Date.parse(resetAtDate[1]);
    if (Number.isFinite(at)) return at;
  }
  const tryIn =
    /\b(?:try again|retry|resets?)\s+in\s+~?\s*((?:\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h)\b[\s,and]*)+)/iu.exec(
      text,
    );
  if (tryIn) {
    const duration = parseUsageLimitDuration(tryIn[1]);
    if (duration !== undefined) return now + duration;
  }
  return undefined;
}

function leadingStatus(text: string): number | undefined {
  const match = /^\s*(?:[A-Za-z][\w .-]{0,40}\()?(\d{3})\b/u.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * What a rejected request means for waiting. A known HTTP status decides
 * first: 429 and 529 wait; 503 and 408 wait only when they read as an
 * overload (a reset header, or limit or busy text); 409 only with a reset
 * header. Every other 4xx and 5xx, and a bare 503 or 408, is an ordinary
 * failure that a chat's automatic retries handle. Without a status, the
 * error text decides.
 */
export function classifyUsageLimit(input: {
  errorMessage?: string;
  observation?: ProviderResponseObservation;
  now: number;
}): UsageLimitVerdict {
  const text = input.errorMessage ?? "";
  const { now } = input;
  const headers = input.observation?.headers;
  const status = input.observation?.status ?? leadingStatus(text);

  if (status === 402 || BILLING.test(text)) return { kind: "stop", reason: "billing" };
  if (CONTEXT_OVERFLOW.test(text)) return { kind: "none" };

  const window = anthropicUnifiedVerdict(headers, now) ?? codexWindowVerdict(headers, now);
  if (window) return window;

  const fromHeaders = headerResetAt(headers, now);
  const fromText = textResetAt(text, now);
  const resetAt = future(fromHeaders, now) ?? future(fromText, now);
  if (BILLING_HINT.test(text) && fromText === undefined) return { kind: "stop", reason: "billing" };

  if (status !== undefined) {
    const overload = fromHeaders !== undefined || RATE_LIMITED.test(text);
    const waitable =
      status === 429 ||
      status === 529 ||
      ((status === 503 || status === 408) && overload) ||
      (status === 409 && fromHeaders !== undefined);
    if (!waitable) return { kind: "none" };
  } else if (!RATE_LIMITED.test(text)) {
    // Without a status, only text that reads as a limit waits; a reset time alone is not one.
    return { kind: "none" };
  }

  if (LONG_WINDOW_TEXT.test(text)) return { kind: "stop", reason: "long-window", ...withReset(resetAt) };
  const plan = PLAN_LIMIT.test(text);
  return {
    kind: "wait",
    scope: plan ? "account" : "model",
    ...withReset(resetAt),
    ...(plan && resetAt === undefined ? { plan: true } : {}),
  };
}

/**
 * A provider-free description of a usage-limit rejection that reads back as
 * the same verdict. An isolated helper process redacts provider error text
 * before it reaches the app, and sends this instead so the wait still works.
 */
export function usageLimitSafeErrorText(verdict: UsageLimitVerdict, now: number): string | undefined {
  if (verdict.kind === "none") return undefined;
  const after =
    verdict.resetAt !== undefined && verdict.resetAt > now ? ` Try again in ${Math.ceil((verdict.resetAt - now) / 1_000)}s.` : "";
  if (verdict.kind === "stop") {
    return verdict.reason === "billing"
      ? "The provider turned the request away: insufficient_quota."
      : `The provider turned the request away: weekly usage limit reached.${after}`;
  }
  return verdict.scope === "account"
    ? `The provider turned the request away: usage_limit_reached.${after}`
    : `The provider turned the request away: rate limit (429).${after}`;
}

/** The delay before try `attempt` (1-based) of a rejection with no time. */
export function usageLimitBackoffMs(attempt: number): number {
  return BACKOFF_STEPS_MS[Math.max(0, attempt - 1)] ?? BACKOFF_FLOOR_MS;
}

/** One limit the gate holds: requests on its key wait for it. */
export interface UsageLimitEntry {
  key: string;
  providerId: string;
  modelId?: string;
  /** When the limit was first hit; the longest wait counts from here, across restarts. */
  since: number;
  /** When the next test request may go. */
  nextTryAt: number;
  /** The provider's reset time, when it gave one. */
  resetAt?: number;
  /** Tries with no reset time so far, for the backoff steps. */
  attempts: number;
  plan?: boolean;
  /** After a give-up: new requests fail at once until then. */
  refuseUntil?: number;
}

export interface UsageLimitEntriesDocument {
  version: 1;
  entries: UsageLimitEntry[];
}

function nonNegativeSafe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Strict, closed parse of the persisted gate state. Bad entries are dropped. */
export function parseUsageLimitEntries(value: unknown, now: number): UsageLimitEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const document = value as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.entries)) return [];
  const entries: UsageLimitEntry[] = [];
  for (const raw of document.entries.slice(0, 500)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.key !== "string" ||
      !entry.key ||
      entry.key.length > 600 ||
      typeof entry.providerId !== "string" ||
      !entry.providerId ||
      (entry.modelId !== undefined && typeof entry.modelId !== "string") ||
      !nonNegativeSafe(entry.since) ||
      !nonNegativeSafe(entry.nextTryAt) ||
      !nonNegativeSafe(entry.attempts) ||
      (entry.resetAt !== undefined && !nonNegativeSafe(entry.resetAt)) ||
      (entry.refuseUntil !== undefined && !nonNegativeSafe(entry.refuseUntil)) ||
      (entry.plan !== undefined && typeof entry.plan !== "boolean")
    ) {
      continue;
    }
    if (now - (entry.since as number) > USAGE_LIMIT_ENTRY_TTL_MS) continue;
    entries.push({
      key: entry.key,
      providerId: entry.providerId,
      ...(typeof entry.modelId === "string" ? { modelId: entry.modelId } : {}),
      since: entry.since as number,
      nextTryAt: entry.nextTryAt as number,
      attempts: entry.attempts as number,
      ...(entry.resetAt !== undefined ? { resetAt: entry.resetAt as number } : {}),
      ...(entry.plan === true ? { plan: true } : {}),
      ...(entry.refuseUntil !== undefined ? { refuseUntil: entry.refuseUntil as number } : {}),
    });
  }
  return entries;
}

/** Gate keys of one request: the account first, then its model. */
export function usageLimitKeys(providerId: string, modelId: string): { account: string; model: string } {
  return { account: providerId, model: `${providerId}\u0000${modelId}` };
}

/** Who a waiting request works for, so the app can show the wait and offer Retry now. */
export interface UsageLimitOwner {
  kind: "chat" | "bot";
  id: string;
}

/** A wait as the app shows it. */
export interface UsageLimitWait {
  owner: UsageLimitOwner;
  providerId: string;
  providerLabel: string;
  modelId: string;
  /** When the next try goes. */
  nextTryAt: number;
  resetAt?: number;
  /** This request is the one that will test the limit. */
  testing: boolean;
  /** The test request is out now, waiting for the provider's answer. */
  trying: boolean;
}

export type UsageLimitDecision =
  | { kind: "wait"; entry: UsageLimitEntry }
  | { kind: "give-up"; resetAt?: number; reason: "long-window" | "billing" | "beyond-max-wait" | "backoff-exhausted" | "off" };

/**
 * What to do with a waitable verdict for `entry` (the existing limit, if any).
 * Pure: returns the updated entry or a give-up.
 */
export function decideUsageLimitWait(input: {
  verdict: Exclude<UsageLimitVerdict, { kind: "none" }>;
  existing?: UsageLimitEntry;
  key: string;
  providerId: string;
  modelId?: string;
  maxWaitMs: number;
  now: number;
  random?: () => number;
}): UsageLimitDecision {
  const { verdict, now, maxWaitMs } = input;
  const random = input.random ?? Math.random;
  if (verdict.kind === "stop") return { kind: "give-up", reason: verdict.reason, ...withReset(verdict.resetAt) };
  if (maxWaitMs <= 0) return { kind: "give-up", reason: "off", ...withReset(verdict.resetAt) };
  // A limit left untried for a while (its waiters stopped) is a new hit, not a long wait.
  const existing =
    input.existing && input.existing.refuseUntil === undefined && now - input.existing.nextTryAt <= USAGE_LIMIT_STALE_MS
      ? input.existing
      : undefined;
  const since = existing?.since ?? now;
  const deadline = since + maxWaitMs;
  const attempts = (existing?.attempts ?? 0) + 1;
  let nextTryAt: number;
  // Tests that keep meeting a reset a moment away mean the reset is wrong: back off instead.
  const trustReset = verdict.resetAt !== undefined && !(attempts > 8 && verdict.resetAt - now < 120_000);
  if (verdict.resetAt !== undefined && trustReset) {
    if (verdict.resetAt > deadline) return { kind: "give-up", reason: "beyond-max-wait", resetAt: verdict.resetAt };
    // A little after the reset, so the first try does not land a second early.
    nextTryAt = Math.max(now + USAGE_LIMIT_MIN_WAIT_MS, verdict.resetAt + 5_000 + Math.floor(random() * 25_000));
  } else if (verdict.plan) {
    nextTryAt = now + USAGE_LIMIT_PLAN_RETRY_MS;
    if (nextTryAt > deadline) return { kind: "give-up", reason: "beyond-max-wait" };
  } else {
    nextTryAt = now + Math.max(USAGE_LIMIT_MIN_WAIT_MS, usageLimitBackoffMs(attempts));
    if (nextTryAt > Math.min(deadline, since + USAGE_LIMIT_BACKOFF_MAX_MS)) {
      return { kind: "give-up", reason: "backoff-exhausted" };
    }
  }
  return {
    kind: "wait",
    entry: {
      key: input.key,
      providerId: input.providerId,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      since,
      nextTryAt,
      attempts,
      ...withReset(verdict.resetAt),
      ...(verdict.plan ? { plan: true } : {}),
    },
  };
}


function hoursText(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/**
 * The sentence added to a provider error when Aiden did not wait or stopped
 * waiting, so the chat says why and when the limit resets. Empty when there
 * is nothing to add.
 */
export function usageLimitGiveUpNote(
  decision: Extract<UsageLimitDecision, { kind: "give-up" }>,
  input: { maxWaitMs: number; now: number; locale?: string; timeZone?: string },
): string {
  const at = decision.resetAt !== undefined && decision.resetAt > input.now
    ? formatUsageLimitTime(decision.resetAt, input.now, input)
    : undefined;
  switch (decision.reason) {
    case "billing":
      return "";
    case "long-window":
      return at
        ? `This limit lasts days, so Aiden didn't wait. It resets ${at}.`
        : "This limit lasts days, so Aiden didn't wait.";
    case "off":
      return at ? `The limit resets ${at}. Waiting for usage limits is off in Settings.` : "";
    case "beyond-max-wait":
      return at
        ? `Aiden stopped waiting: the limit resets ${at}, after the longest wait you set (${hoursText(input.maxWaitMs)}).`
        : `Aiden waited ${hoursText(input.maxWaitMs)}, the longest wait you set, and the limit didn't clear.`;
    case "backoff-exhausted":
      return `Aiden tried again for ${Math.round(USAGE_LIMIT_BACKOFF_MAX_MS / 60_000)} minutes and the limit didn't clear.`;
  }
}

/**
 * The Mac notification for a reply that waited and then stopped waiting. A
 * limit that was never waited for fails in the chat at once, and turning
 * waiting off is the owner's own doing, so neither notifies.
 */
export function usageLimitGiveUpNotification(input: {
  providerLabel: string;
  decision: Extract<UsageLimitDecision, { kind: "give-up" }>;
  waited: boolean;
  maxWaitMs: number;
  now: number;
  locale?: string;
  timeZone?: string;
}): { title: string; body: string } | undefined {
  if (!input.waited) return undefined;
  if (input.decision.reason !== "beyond-max-wait" && input.decision.reason !== "backoff-exhausted") return undefined;
  const provider = input.providerLabel.trim() || "the provider";
  return {
    title: `Stopped waiting for ${provider}`,
    body: usageLimitGiveUpNote(input.decision, input),
  };
}

/** The error of a request that a recent give-up turned away without sending. */
export function usageLimitRefusedMessage(input: {
  providerLabel: string;
  resetAt?: number;
  now: number;
  locale?: string;
  timeZone?: string;
}): string {
  const at = input.resetAt !== undefined && input.resetAt > input.now
    ? ` It resets ${formatUsageLimitTime(input.resetAt, input.now, input)}.`
    : "";
  return `${input.providerLabel} is still at its usage limit, and Aiden stopped waiting for it a few minutes ago.${at}`;
}

const USAGE_LIMIT_FAILURE = "aidenUsageLimitFailure";

/**
 * Marks a reply's error as a usage limit's final word: the wait gave up, the
 * limit outlasts it, or a recent give-up turned the request away. The chat's
 * own retries then leave it alone, so the reply fails once with the reset time
 * instead of sending again into the same limit.
 */
export function markUsageLimitFailure<T extends object>(message: T): T {
  return Object.assign(message, { [USAGE_LIMIT_FAILURE]: true });
}

export function isUsageLimitFailure(message: object): boolean {
  return (message as Record<string, unknown>)[USAGE_LIMIT_FAILURE] === true;
}

export interface UsageLimitGateClock {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  random(): number;
}

const systemClock: UsageLimitGateClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

interface Holder {
  owner: UsageLimitOwner;
  providerLabel: string;
  modelId: string;
  key: string;
}

interface Waiter extends Holder {
  id: number;
  /** This request's longest wait, when it has one. */
  maxWaitMs?: number;
  /** Wakes the waiter to look at the gate again. */
  wake(): void;
}

/** A request's permission to send, returned by `acquire`. */
export type UsageLimitTicket =
  /**
   * `testing`: this request tests the limit held on `key`. `off`: waiting
   * was turned off while it waited, so a rejection now fails as it would
   * with waiting off.
   */
  | { kind: "send"; id: number; key?: string; testing: boolean; off?: true }
  | { kind: "refused"; resetAt?: number }
  /**
   * The held limit's next try is past this request's longest wait: it stops
   * waiting. `waited`: it had been waiting before it found out.
   */
  | { kind: "too-long"; resetAt?: number; maxWaitMs: number; waited: boolean }
  | { kind: "aborted" };

export interface UsageLimitAcquireOptions {
  owner: UsageLimitOwner;
  providerLabel: string;
  modelId: string;
  signal?: AbortSignal;
  /** The same request's last ticket, when it met the limit and waits again: a test stays the test. */
  previous?: UsageLimitTicket;
  /**
   * The longest wait in force: a held limit whose next try lands past it ends
   * the wait, and 0 (waiting off) lets the request go straight through.
   */
  maxWaitMs?: number;
}

/**
 * Per-limit coordination for every request in the process. A request asks
 * `acquire` before it sends. While a limit holds, one request (the test) waits
 * for the next try time and sends; the others wait in line without sending.
 * When the test gets an answer, the line leaves one request at a time, 1 to 5
 * seconds apart, so many chats do not wake in the same second.
 */
export class UsageLimitGate {
  private readonly entries = new Map<string, UsageLimitEntry>();
  /** Key → the request testing it, waiting or out. */
  private readonly testers = new Map<string, number>();
  private readonly waiters = new Map<number, Waiter>();
  /** Test requests out now, waiting for the provider's answer. */
  private readonly flights = new Map<number, Holder>();
  /** Key → waiters in line behind the test, oldest first. */
  private readonly lines = new Map<string, number[]>();
  /** Key → the timer that releases the next in line, while a line drains. */
  private readonly draining = new Map<string, unknown>();
  private readonly lastRetryNow = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  constructor(private readonly clock: UsageLimitGateClock = systemClock) {}

  /** Add held limits, for example from the file a previous run left. */
  load(entries: readonly UsageLimitEntry[]): void {
    for (const entry of entries) this.entries.set(entry.key, { ...entry });
    this.changed();
  }

  snapshot(): UsageLimitEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  entry(key: string): UsageLimitEntry | undefined {
    const entry = this.entries.get(key);
    return entry ? { ...entry } : undefined;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every request waiting now, and every test out now, for the app to show. */
  waits(): UsageLimitWait[] {
    const result: UsageLimitWait[] = [];
    const add = (holder: Holder, testing: boolean, trying: boolean) => {
      const entry = this.entries.get(holder.key);
      if (!entry) return;
      result.push({
        owner: { ...holder.owner },
        providerId: entry.providerId,
        providerLabel: holder.providerLabel,
        modelId: holder.modelId,
        nextTryAt: entry.nextTryAt,
        ...withReset(entry.resetAt),
        testing,
        trying,
      });
    };
    for (const waiter of this.waiters.values()) add(waiter, this.testers.get(waiter.key) === waiter.id, false);
    for (const flight of this.flights.values()) add(flight, true, true);
    return result;
  }

  /** Whether a request of this owner waits for a limit to clear. A test request already sent is not waiting. */
  isHeld(owner: UsageLimitOwner): boolean {
    for (const waiter of this.waiters.values()) {
      if (waiter.owner.kind === owner.kind && waiter.owner.id === owner.id) return true;
    }
    return false;
  }

  /** The limit that holds a request on these keys now, account first. */
  private holding(keys: readonly string[]): UsageLimitEntry | undefined {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) return entry;
    }
    return undefined;
  }

  /** A tester that neither waits nor is out was lost; it holds nobody up. */
  private liveTester(key: string): number | undefined {
    const tester = this.testers.get(key);
    if (tester === undefined) return undefined;
    if (this.waiters.has(tester) || this.flights.has(tester)) return tester;
    this.testers.delete(key);
    return undefined;
  }

  /**
   * Wait until a request on `keys` may send. Resolves at once when no limit
   * holds. Aborting `signal` ends the wait.
   */
  acquire(keys: readonly string[], options: UsageLimitAcquireOptions): Promise<UsageLimitTicket> {
    const { signal } = options;
    const id = options.previous?.kind === "send" ? options.previous.id : this.nextId++;
    this.flights.delete(id);
    if (signal?.aborted) {
      this.leaveTesting(id);
      return Promise.resolve({ kind: "aborted" });
    }
    if (!this.holding(keys)) {
      this.leaveTesting(id);
      return Promise.resolve({ kind: "send", id, testing: false });
    }
    return new Promise<UsageLimitTicket>((resolve) => {
      let timer: unknown;
      let settled = false;
      const finish = (ticket: UsageLimitTicket) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.clock.clearTimer(timer);
        signal?.removeEventListener("abort", onAbort);
        const waiter = this.waiters.get(id);
        this.waiters.delete(id);
        if (waiter) this.leaveLine(waiter.key, id);
        if (ticket.kind === "send" && ticket.testing && waiter) {
          this.flights.set(id, { owner: waiter.owner, providerLabel: waiter.providerLabel, modelId: waiter.modelId, key: waiter.key });
        } else {
          this.leaveTesting(id);
        }
        this.changed();
        resolve(ticket);
      };
      const onAbort = () => finish({ kind: "aborted" });
      signal?.addEventListener("abort", onAbort, { once: true });
      const look = () => {
        if (settled) return;
        if (timer !== undefined) {
          this.clock.clearTimer(timer);
          timer = undefined;
        }
        const now = this.clock.now();
        let entry = this.holding(keys);
        if (!entry) {
          finish({ kind: "send", id, testing: false });
          return;
        }
        if (entry.refuseUntil !== undefined) {
          if (entry.refuseUntil > now) {
            finish({ kind: "refused", ...withReset(entry.resetAt) });
            return;
          }
          // The refusal ran out: the next request tests the limit again.
          const { refuseUntil: _expired, ...rest } = entry;
          entry = { ...rest, nextTryAt: now };
          this.entries.set(entry.key, entry);
        }
        let waiter = this.waiters.get(id);
        const maxWaitMs = waiter?.maxWaitMs ?? options.maxWaitMs;
        if (maxWaitMs !== undefined && maxWaitMs <= 0) {
          finish({ kind: "send", id, testing: false, off: true });
          return;
        }
        // A reset counts as the time the limit clears; the try lands a little after it.
        if (maxWaitMs !== undefined && entry.nextTryAt > now && (entry.resetAt ?? entry.nextTryAt) > entry.since + maxWaitMs) {
          finish({ kind: "too-long", ...withReset(entry.resetAt), maxWaitMs, waited: waiter !== undefined });
          return;
        }
        if (waiter && waiter.key !== entry.key) {
          this.leaveLine(waiter.key, id);
          this.leaveTesting(id);
          waiter.key = entry.key;
        }
        if (!waiter) {
          waiter = {
            id,
            owner: options.owner,
            providerLabel: options.providerLabel,
            modelId: options.modelId,
            key: entry.key,
            ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
            wake: look,
          };
          this.waiters.set(id, waiter);
        }
        const tester = this.liveTester(entry.key);
        if (tester === undefined || tester === id) {
          this.testers.set(entry.key, id);
          this.leaveLine(entry.key, id);
          const delay = entry.nextTryAt - now;
          if (delay <= 0) {
            finish({ kind: "send", id, key: entry.key, testing: true });
            return;
          }
          timer = this.clock.setTimer(look, delay);
          this.changed();
          return;
        }
        const line = this.lines.get(entry.key) ?? [];
        if (!line.includes(id)) {
          line.push(id);
          this.lines.set(entry.key, line);
        }
        this.changed();
      };
      look();
    });
  }

  private leaveLine(key: string, id: number): void {
    const line = this.lines.get(key);
    if (!line) return;
    const index = line.indexOf(id);
    if (index >= 0) line.splice(index, 1);
    if (line.length === 0) this.lines.delete(key);
  }

  /** `id` no longer tests anything: the next in line of each key it tested takes over. */
  private leaveTesting(id: number): void {
    for (const [key, tester] of [...this.testers]) {
      if (tester !== id) continue;
      this.testers.delete(key);
      this.promote(key);
    }
  }

  /** The next in line tests instead. */
  private promote(key: string): void {
    const line = this.lines.get(key);
    const next = line?.shift();
    if (line && line.length === 0) this.lines.delete(key);
    if (next === undefined) return;
    this.waiters.get(next)?.wake();
  }

  /** Release the line of `key` one request at a time, 1 to 5 seconds apart. */
  private drain(key: string): void {
    if (this.draining.has(key)) return;
    const step = () => {
      this.draining.delete(key);
      if (this.entries.has(key)) return;
      const line = this.lines.get(key);
      const next = line?.shift();
      if (line && line.length === 0) this.lines.delete(key);
      if (next === undefined) return;
      this.waiters.get(next)?.wake();
      if (this.lines.has(key)) this.draining.set(key, this.clock.setTimer(step, this.spacing()));
    };
    this.draining.set(key, this.clock.setTimer(step, this.spacing()));
  }

  private stopDraining(key: string): void {
    const pending = this.draining.get(key);
    if (pending === undefined) return;
    this.clock.clearTimer(pending);
    this.draining.delete(key);
  }

  private spacing(): number {
    return 1_000 + Math.floor(this.clock.random() * 4_000);
  }

  /** The provider answered the request with something other than a limit: the limit it tested is gone. */
  answered(ticket: UsageLimitTicket): void {
    if (ticket.kind !== "send") return;
    const wasOut = this.flights.delete(ticket.id);
    if (!ticket.testing || !ticket.key) {
      if (wasOut) this.changed();
      return;
    }
    if (this.testers.get(ticket.key) === ticket.id) this.testers.delete(ticket.key);
    this.entries.delete(ticket.key);
    this.lastRetryNow.delete(ticket.key);
    this.drain(ticket.key);
    this.changed();
  }

  /** The request ended without an answer (it was stopped): whoever is next in line tests instead. */
  release(ticket: UsageLimitTicket): void {
    if (ticket.kind !== "send") return;
    const wasOut = this.flights.delete(ticket.id);
    if (ticket.testing && ticket.key && this.testers.get(ticket.key) === ticket.id) {
      this.testers.delete(ticket.key);
      this.promote(ticket.key);
    }
    if (wasOut) this.changed();
  }

  /** Hold a limit. The request that hit it waits again with `acquire({ previous })` and tests it next. */
  hold(entry: UsageLimitEntry): void {
    this.stopDraining(entry.key);
    this.entries.set(entry.key, { ...entry });
    this.changed();
  }

  /** The wait was given up: new requests on this limit fail at once for a while, and so does the line. */
  refuse(
    entry: Pick<UsageLimitEntry, "key" | "providerId" | "modelId">,
    resetAt: number | undefined,
    ticket?: UsageLimitTicket,
  ): void {
    const now = this.clock.now();
    const existing = this.entries.get(entry.key);
    const refuseUntil = Math.min(resetAt ?? now + USAGE_LIMIT_REFUSE_MS, now + USAGE_LIMIT_REFUSE_MS);
    this.stopDraining(entry.key);
    this.entries.set(entry.key, {
      key: entry.key,
      providerId: entry.providerId,
      ...(entry.modelId ? { modelId: entry.modelId } : {}),
      since: existing?.since ?? now,
      nextTryAt: refuseUntil,
      attempts: existing?.attempts ?? 0,
      ...withReset(resetAt ?? existing?.resetAt),
      refuseUntil,
    });
    if (ticket?.kind === "send") {
      this.flights.delete(ticket.id);
      if (this.testers.get(entry.key) === ticket.id) this.testers.delete(entry.key);
    }
    for (const waiter of [...this.waiters.values()]) if (waiter.key === entry.key) waiter.wake();
    this.changed();
  }

  /**
   * Retry now for one owner: each limit it waits on is tested at once, at most
   * once per `USAGE_LIMIT_RETRY_NOW_INTERVAL_MS`. Returns whether a test started.
   */
  /**
   * The owner changed the longest wait: every waiting request looks again, so
   * a shorter wait ends waits now past it and "Don't wait" sends them.
   */
  setMaxWait(maxWaitMs: number): void {
    const waiters = [...this.waiters.values()];
    for (const waiter of waiters) waiter.maxWaitMs = maxWaitMs;
    for (const waiter of waiters) waiter.wake();
  }

  retryNow(owner: UsageLimitOwner): boolean {
    const now = this.clock.now();
    let started = false;
    const keys = new Set<string>();
    for (const waiter of this.waiters.values()) {
      if (waiter.owner.kind === owner.kind && waiter.owner.id === owner.id) keys.add(waiter.key);
    }
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry || entry.refuseUntil !== undefined) continue;
      if (now - (this.lastRetryNow.get(key) ?? Number.NEGATIVE_INFINITY) < USAGE_LIMIT_RETRY_NOW_INTERVAL_MS) continue;
      const tester = this.liveTester(key);
      // A test is already out: its answer comes first.
      if (tester !== undefined && this.flights.has(tester)) continue;
      this.lastRetryNow.set(key, now);
      this.entries.set(key, { ...entry, nextTryAt: now });
      const waiter = tester === undefined ? undefined : this.waiters.get(tester);
      if (waiter) waiter.wake();
      else this.promote(key);
      started = true;
    }
    if (started) this.changed();
    return started;
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener never stops the gate.
      }
    }
  }
}
