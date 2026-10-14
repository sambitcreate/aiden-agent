// The Bots sidebar's per-device preferences (spec §9): which Bot is pinned and
// when each Bot was last viewed on this Mac. Not part of BotDefinition, never
// synced to phones. `since` is when the record began, so Bots never viewed here
// are not all unread after an update.

export const BOT_SIDEBAR_PREFERENCES_KEY = "aiden-agent.bots-sidebar.v1";
export const BOT_LAST_VIEWED_LIMIT = 200;

export interface BotSidebarPreferences {
  since: number;
  pinnedBotId: string | null;
  lastViewed: Readonly<Record<string, number>>;
}

function fresh(now: number): BotSidebarPreferences {
  return { since: now, pinnedBotId: null, lastViewed: {} };
}

const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function newest(lastViewed: Record<string, number>): Record<string, number> {
  const entries = Object.entries(lastViewed);
  if (entries.length <= BOT_LAST_VIEWED_LIMIT) return lastViewed;
  return Object.fromEntries(entries.sort((left, right) => right[1] - left[1]).slice(0, BOT_LAST_VIEWED_LIMIT));
}

// A view or start time in the future (clock skew, a hand-edited record) would
// hide every later reply as already seen, so times are clamped to `now`.
export function parseBotSidebarPreferences(raw: string | null, now: number = Date.now()): BotSidebarPreferences {
  if (raw === null) return fresh(now);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fresh(now);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fresh(now);
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return fresh(now);
  const lastViewed: Record<string, number> = {};
  if (record.lastViewed && typeof record.lastViewed === "object" && !Array.isArray(record.lastViewed)) {
    for (const [botId, at] of Object.entries(record.lastViewed as Record<string, unknown>)) {
      if (botId && validTime(at)) lastViewed[botId] = Math.min(at, now);
    }
  }
  return {
    since: validTime(record.since) ? Math.min(record.since, now) : now,
    pinnedBotId: typeof record.pinnedBotId === "string" && record.pinnedBotId ? record.pinnedBotId : null,
    lastViewed: newest(lastViewed),
  };
}

export function serializeBotSidebarPreferences(preferences: BotSidebarPreferences): string {
  return JSON.stringify({
    version: 1,
    since: preferences.since,
    pinnedBotId: preferences.pinnedBotId,
    lastViewed: preferences.lastViewed,
  });
}

export function withPinnedBot(preferences: BotSidebarPreferences, botId: string | null): BotSidebarPreferences {
  return preferences.pinnedBotId === botId ? preferences : { ...preferences, pinnedBotId: botId };
}

export function withBotViewed(preferences: BotSidebarPreferences, botId: string, at: number): BotSidebarPreferences {
  if (at <= (preferences.lastViewed[botId] ?? 0)) return preferences;
  return { ...preferences, lastViewed: newest({ ...preferences.lastViewed, [botId]: at }) };
}

// An empty live set means the Bots list is loading, failed or stale, not that
// every Bot was deleted, so it never prunes.
export function withoutMissingBots(
  preferences: BotSidebarPreferences,
  liveIds: ReadonlySet<string>,
): BotSidebarPreferences {
  if (liveIds.size === 0) return preferences;
  const pinGone = preferences.pinnedBotId !== null && !liveIds.has(preferences.pinnedBotId);
  const kept = Object.entries(preferences.lastViewed).filter(([botId]) => liveIds.has(botId));
  if (!pinGone && kept.length === Object.keys(preferences.lastViewed).length) return preferences;
  return {
    ...preferences,
    pinnedBotId: pinGone ? null : preferences.pinnedBotId,
    lastViewed: Object.fromEntries(kept),
  };
}

export function isBotUnread(preferences: BotSidebarPreferences, botId: string, lastReplyAt: number | null): boolean {
  return lastReplyAt !== null && lastReplyAt > (preferences.lastViewed[botId] ?? preferences.since);
}

export function lastViewedBotId(preferences: BotSidebarPreferences, liveIds: ReadonlySet<string>): string | null {
  let best: string | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const [botId, at] of Object.entries(preferences.lastViewed)) {
    if (liveIds.has(botId) && at > bestAt) {
      best = botId;
      bestAt = at;
    }
  }
  return best;
}
