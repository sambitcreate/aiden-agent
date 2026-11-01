// The Bots sidebar's per-device preferences (spec §9): which Bot is pinned,
// when each Bot's chat was last open on this Mac, and the newest reply seen in
// it. Not part of BotDefinition, never synced to phones. `since` is when the
// record began, so Bots never viewed here are not all unread after an update.
//
// Unread compares a Bot's newest reply with the newest reply seen in its chat,
// both as main timed them. Main times a reply when it starts streaming, so a
// view time from this window's clock would hide a reply that started before
// the person left and finished after.

export const BOT_SIDEBAR_PREFERENCES_KEY = "aiden-agent.bots-sidebar.v1";
export const BOT_LAST_VIEWED_LIMIT = 200;

export interface BotSidebarPreferences {
  since: number;
  pinnedBotId: string | null;
  /** When each Bot's chat was last open here; `/bots` opens the newest. */
  lastViewed: Readonly<Record<string, number>>;
  /** The newest reply each Bot's chat showed here (main's `at`); a newer reply is unread. */
  seenReplyAt: Readonly<Record<string, number>>;
}

function fresh(now: number): BotSidebarPreferences {
  return { since: now, pinnedBotId: null, lastViewed: {}, seenReplyAt: {} };
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
  return {
    since: validTime(record.since) ? Math.min(record.since, now) : now,
    pinnedBotId: typeof record.pinnedBotId === "string" && record.pinnedBotId ? record.pinnedBotId : null,
    lastViewed: parseTimes(record.lastViewed, now),
    // Added after the first records were written; a record without it has seen nothing yet.
    seenReplyAt: parseTimes(record.seenReplyAt, now),
  };
}

function parseTimes(value: unknown, now: number): Record<string, number> {
  const times: Record<string, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [botId, at] of Object.entries(value as Record<string, unknown>)) {
      if (botId && validTime(at)) times[botId] = Math.min(at, now);
    }
  }
  return newest(times);
}

export function serializeBotSidebarPreferences(preferences: BotSidebarPreferences): string {
  return JSON.stringify({
    version: 1,
    since: preferences.since,
    pinnedBotId: preferences.pinnedBotId,
    lastViewed: preferences.lastViewed,
    seenReplyAt: preferences.seenReplyAt,
  });
}

export function withPinnedBot(preferences: BotSidebarPreferences, botId: string | null): BotSidebarPreferences {
  return preferences.pinnedBotId === botId ? preferences : { ...preferences, pinnedBotId: botId };
}

/**
 * The chat was open at `at`, showing replies up to `replyAt` (main's time of
 * its newest reply, null when it has none). Both only move forward.
 */
export function withBotViewed(
  preferences: BotSidebarPreferences,
  botId: string,
  at: number,
  replyAt: number | null = null,
): BotSidebarPreferences {
  const viewed = at > (preferences.lastViewed[botId] ?? 0);
  const seen = replyAt !== null && replyAt > (preferences.seenReplyAt[botId] ?? 0);
  if (!viewed && !seen) return preferences;
  return {
    ...preferences,
    ...(viewed ? { lastViewed: newest({ ...preferences.lastViewed, [botId]: at }) } : {}),
    ...(seen ? { seenReplyAt: newest({ ...preferences.seenReplyAt, [botId]: replyAt }) } : {}),
  };
}

/**
 * The person marked the Bot's reply at `replyAt` read without opening its
 * chat (the Inbox's Mark read). Only the seen reply moves, and only forward:
 * the Bot's last view, which decides where `/bots` opens, stays as it was.
 */
export function withBotReplySeen(
  preferences: BotSidebarPreferences,
  botId: string,
  replyAt: number | null,
): BotSidebarPreferences {
  if (replyAt === null || replyAt <= (preferences.seenReplyAt[botId] ?? 0)) return preferences;
  return { ...preferences, seenReplyAt: newest({ ...preferences.seenReplyAt, [botId]: replyAt }) };
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
  const keptSeen = Object.entries(preferences.seenReplyAt).filter(([botId]) => liveIds.has(botId));
  if (
    !pinGone &&
    kept.length === Object.keys(preferences.lastViewed).length &&
    keptSeen.length === Object.keys(preferences.seenReplyAt).length
  ) {
    return preferences;
  }
  return {
    ...preferences,
    pinnedBotId: pinGone ? null : preferences.pinnedBotId,
    lastViewed: Object.fromEntries(kept),
    seenReplyAt: Object.fromEntries(keptSeen),
  };
}

/** A deleted Bot leaves no pin and no view behind, even when it was the last Bot (which `withoutMissingBots` can't tell). */
export function withoutBot(preferences: BotSidebarPreferences, botId: string): BotSidebarPreferences {
  const pinned = preferences.pinnedBotId === botId;
  if (!pinned && !(botId in preferences.lastViewed) && !(botId in preferences.seenReplyAt)) return preferences;
  const { [botId]: _dropped, ...lastViewed } = preferences.lastViewed;
  const { [botId]: _droppedSeen, ...seenReplyAt } = preferences.seenReplyAt;
  return { ...preferences, pinnedBotId: pinned ? null : preferences.pinnedBotId, lastViewed, seenReplyAt };
}

/** A reply newer than the newest one its chat showed here, or than the record's start when it never showed one. */
export function isBotUnread(preferences: BotSidebarPreferences, botId: string, lastReplyAt: number | null): boolean {
  return lastReplyAt !== null && lastReplyAt > (preferences.seenReplyAt[botId] ?? preferences.since);
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
