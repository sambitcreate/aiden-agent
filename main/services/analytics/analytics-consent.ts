// Consent state for product analytics, stored under `analytics` in the
// machine-local settings.json (never the portable config). Pure functions over
// a plain value so the desktop and the CLI can bind them to their own stores.

export interface AnalyticsState {
  readonly enabled: boolean;
  // Random per-install id. Created only once sending is allowed, deleted when
  // analytics is turned off, so data from before and after cannot be linked.
  readonly installId?: string;
  // Nothing is sent until the person has seen the notice (onboarding row, or
  // the one-time card for people upgrading into analytics).
  readonly noticeShownAt?: string;
  readonly lastActiveDay?: string;
  readonly lastVersion?: string;
}

export type AnalyticsBlockReason = "disabled" | "environment" | "notice_pending" | "no_key";

export type AnalyticsSendStatus =
  | { readonly canSend: true }
  | { readonly canSend: false; readonly reason: AnalyticsBlockReason };

export const DEFAULT_ANALYTICS_STATE: AnalyticsState = { enabled: true };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/u;

function validTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

// Unknown or damaged values fall back field by field; a damaged `enabled`
// keeps the default rather than silently turning analytics off or on.
export function parseAnalyticsState(raw: unknown): AnalyticsState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_ANALYTICS_STATE;
  const record = raw as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : DEFAULT_ANALYTICS_STATE.enabled;
  const installId = enabled ? matching(record.installId, UUID_V4) : undefined;
  const noticeShownAt = validTimestamp(record.noticeShownAt);
  const lastActiveDay = matching(record.lastActiveDay, DAY);
  const lastVersion = matching(record.lastVersion, VERSION);
  return {
    enabled,
    ...(installId ? { installId } : {}),
    ...(noticeShownAt ? { noticeShownAt } : {}),
    ...(lastActiveDay ? { lastActiveDay } : {}),
    ...(lastVersion ? { lastVersion } : {}),
  };
}

function truthyFlag(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function falsyFlag(value: string | undefined): boolean {
  return value !== undefined && ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

// `DO_NOT_TRACK=1` (consoledonottrack.com) or `AIDEN_ANALYTICS=0` turn
// analytics off regardless of the saved setting.
export function envDisablesAnalytics(env: Readonly<Record<string, string | undefined>>): boolean {
  return truthyFlag(env.DO_NOT_TRACK) || falsyFlag(env.AIDEN_ANALYTICS);
}

export function analyticsSendStatus(
  state: AnalyticsState,
  context: { readonly env: Readonly<Record<string, string | undefined>>; readonly hasKey: boolean },
): AnalyticsSendStatus {
  if (envDisablesAnalytics(context.env)) return { canSend: false, reason: "environment" };
  if (!state.enabled) return { canSend: false, reason: "disabled" };
  if (!context.hasKey) return { canSend: false, reason: "no_key" };
  if (!state.noticeShownAt) return { canSend: false, reason: "notice_pending" };
  return { canSend: true };
}

export function markNoticeShown(state: AnalyticsState, now: Date): AnalyticsState {
  return state.noticeShownAt ? state : { ...state, noticeShownAt: now.toISOString() };
}

export function ensureInstallId(state: AnalyticsState, randomUUID: () => string): AnalyticsState {
  if (!state.enabled || state.installId) return state;
  const installId = randomUUID();
  if (!UUID_V4.test(installId)) throw new Error("Analytics install id must be a random UUID v4.");
  return { ...state, installId };
}

export function disableAnalytics(state: AnalyticsState): AnalyticsState {
  const { installId: _installId, ...rest } = state;
  return { ...rest, enabled: false };
}

// A fresh install id is created on the next send, never the old one.
export function enableAnalytics(state: AnalyticsState): AnalyticsState {
  if (state.enabled) return state;
  const { installId: _installId, ...rest } = state;
  return { ...rest, enabled: true };
}
