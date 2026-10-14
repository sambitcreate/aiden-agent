// One per-window view of the Bots sidebar preferences, kept in step across
// windows by the `storage` event. Storage can be missing or throw (a private
// profile, cleared site data): the sidebar then works for this session only.

import * as React from "react";
import {
  BOT_SIDEBAR_PREFERENCES_KEY,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
  withBotViewed,
  withoutMissingBots,
  withPinnedBot,
  type BotSidebarPreferences,
} from "../../lib/bot-sidebar-preferences";

const listeners = new Set<() => void>();
let cache: { raw: string | null; value: BotSidebarPreferences } | null = null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY);
  } catch {
    return null;
  }
}

function snapshot(): BotSidebarPreferences {
  const raw = readRaw();
  if (!cache || cache.raw !== raw) cache = { raw, value: parseBotSidebarPreferences(raw, Date.now()) };
  return cache.value;
}

function update(change: (current: BotSidebarPreferences) => BotSidebarPreferences): void {
  const current = snapshot();
  const next = change(current);
  // An unchanged record is still written once, so `since` sticks across launches.
  if (next === current && cache?.raw !== null) return;
  try {
    localStorage.setItem(BOT_SIDEBAR_PREFERENCES_KEY, serializeBotSidebarPreferences(next));
  } catch {
    // Per-device convenience only.
  }
  cache = { raw: readRaw(), value: next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === BOT_SIDEBAR_PREFERENCES_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const ACTIONS = {
  pin: (botId: string) => update((current) => withPinnedBot(current, botId)),
  unpin: () => update((current) => withPinnedBot(current, null)),
  markViewed: (botId: string) => update((current) => withBotViewed(current, botId, Date.now())),
  prune: (liveIds: ReadonlySet<string>) => update((current) => withoutMissingBots(current, liveIds)),
} as const;

export function useBotSidebarPreferences() {
  const preferences = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  return { preferences, ...ACTIONS };
}
