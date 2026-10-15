// One per-window view of the Bots sidebar preferences, kept in step across
// windows by the `storage` event. Storage can be missing or throw (a private
// profile, cleared site data): the sidebar then works for this session only.

import * as React from "react";
import {
  BOT_SIDEBAR_PREFERENCES_KEY,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
  withBotViewed,
  withoutBot,
  withoutMissingBots,
  withPinnedBot,
  type BotSidebarPreferences,
} from "../../lib/bot-sidebar-preferences";

const listeners = new Set<() => void>();
let cache: { raw: string | null; value: BotSidebarPreferences } | null = null;
/**
 * Whether storage may hold something the cache hasn't read. Reads are cheap
 * between changes: storage is read again only after another window's
 * `storage` event, or while nothing is subscribed (no event would say so).
 */
let stale = true;

function readRaw(): string | null {
  try {
    return localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY);
  } catch {
    return null;
  }
}

function snapshot(): BotSidebarPreferences {
  if (cache && !stale && listeners.size > 0) return cache.value;
  const raw = readRaw();
  if (!cache || cache.raw !== raw) cache = { raw, value: parseBotSidebarPreferences(raw, Date.now()) };
  stale = false;
  return cache.value;
}

function persist(preferences: BotSidebarPreferences): void {
  try {
    localStorage.setItem(BOT_SIDEBAR_PREFERENCES_KEY, serializeBotSidebarPreferences(preferences));
  } catch {
    // Per-device convenience only.
  }
}

// Writes the record once when none is stored, so `since` sticks across launches.
function persistIfMissing(): void {
  const current = snapshot();
  if (readRaw() !== null) return;
  persist(current);
  cache = { raw: readRaw(), value: current };
}

function update(change: (current: BotSidebarPreferences) => BotSidebarPreferences): void {
  const current = snapshot();
  const next = change(current);
  if (next === current) return;
  persist(next);
  cache = { raw: readRaw(), value: next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // Storage may have changed while nothing listened.
  if (listeners.size === 0) stale = true;
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== BOT_SIDEBAR_PREFERENCES_KEY) return;
    stale = true;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The preference writes, usable without subscribing to the preferences. */
export const botSidebarPreferenceActions = {
  /** Pins the Bot, or unpins it when it is the pinned one; reads the stored pin, not a render's copy. */
  togglePin: (botId: string) =>
    update((current) => withPinnedBot(current, current.pinnedBotId === botId ? null : botId)),
  /**
   * The Bot's chat is open now, showing replies up to `replyAt`: main's time
   * for its newest reply (`botLastReplyAt`), or null when it shows none.
   */
  markViewed: (botId: string, replyAt: number | null) =>
    update((current) => withBotViewed(current, botId, Date.now(), replyAt)),
  /**
   * Drops the pin and views of deleted Bots. Call it only after a settled,
   * successful Bots load: an empty set is ignored, but a partial or stale list
   * would still unpin a Bot that exists.
   */
  prune: (liveIds: ReadonlySet<string>) => update((current) => withoutMissingBots(current, liveIds)),
  /** Drops a deleted Bot's pin and view; call it once its delete has succeeded. */
  forget: (botId: string) => update((current) => withoutBot(current, botId)),
} as const;

/** Whether the Bot is the pinned one; re-renders only when that answer changes. */
export function useIsBotPinned(botId: string): boolean {
  const pinned = () => snapshot().pinnedBotId === botId;
  return React.useSyncExternalStore(subscribe, pinned, pinned);
}

export function useBotSidebarPreferences() {
  const preferences = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  React.useEffect(persistIfMissing, []);
  return { preferences, ...botSidebarPreferenceActions };
}
