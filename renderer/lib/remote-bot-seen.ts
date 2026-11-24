// The newest reply of each paired Mac's Bot this Mac has shown, so a newer
// one reads as unread (the dot on its row). Kept per device in local storage,
// keyed `hostId/botId`, apart from this Mac's own Bots' preferences, which
// drop any Bot this Mac doesn't have. Times are the host's (`lastReplyAt` on
// its feed rows, revision 52), compared only with each other. `since` is when
// the record began, so a paired Mac's Bots are not all unread the first time.

import * as React from "react";

export const REMOTE_BOT_SEEN_KEY = "aiden-agent.remote-bots-seen.v1";
export const REMOTE_BOT_SEEN_LIMIT = 200;

export interface RemoteBotSeen {
  since: number;
  /** The newest reply each remote Bot's chat showed here, by `hostId/botId`. */
  seenReplyAt: Readonly<Record<string, number>>;
}

const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function newest(times: Record<string, number>): Record<string, number> {
  const entries = Object.entries(times);
  if (entries.length <= REMOTE_BOT_SEEN_LIMIT) return times;
  return Object.fromEntries(entries.sort((left, right) => right[1] - left[1]).slice(0, REMOTE_BOT_SEEN_LIMIT));
}

export function parseRemoteBotSeen(raw: string | null, now: number = Date.now()): RemoteBotSeen {
  const fresh = { since: now, seenReplyAt: {} };
  if (raw === null) return fresh;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fresh;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fresh;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return fresh;
  const seenReplyAt: Record<string, number> = {};
  if (record.seenReplyAt && typeof record.seenReplyAt === "object" && !Array.isArray(record.seenReplyAt)) {
    for (const [key, at] of Object.entries(record.seenReplyAt as Record<string, unknown>)) {
      if (key && validTime(at)) seenReplyAt[key] = at;
    }
  }
  return { since: validTime(record.since) ? Math.min(record.since, now) : now, seenReplyAt: newest(seenReplyAt) };
}

export function serializeRemoteBotSeen(seen: RemoteBotSeen): string {
  return JSON.stringify({ version: 1, since: seen.since, seenReplyAt: seen.seenReplyAt });
}

/** The remote Bot's chat showed the reply at `replyAt`; the seen time only moves forward. */
export function withRemoteBotSeen(seen: RemoteBotSeen, key: string, replyAt: number | undefined): RemoteBotSeen {
  if (replyAt === undefined || !validTime(replyAt) || replyAt <= (seen.seenReplyAt[key] ?? 0)) return seen;
  return { ...seen, seenReplyAt: newest({ ...seen.seenReplyAt, [key]: replyAt }) };
}

/** A reply newer than the newest one its chat showed here, or than the record's start when it never showed one. */
export function isRemoteBotUnread(seen: RemoteBotSeen, key: string, lastReplyAt: number | undefined): boolean {
  return lastReplyAt !== undefined && lastReplyAt > (seen.seenReplyAt[key] ?? seen.since);
}

// One record per window, shared by every row and chat view and kept in step
// with other windows through `storage` events.
let current: RemoteBotSeen | null = null;
const listeners = new Set<() => void>();

function read(): RemoteBotSeen {
  if (current) return current;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(REMOTE_BOT_SEEN_KEY);
  } catch {
    raw = null;
  }
  current = parseRemoteBotSeen(raw);
  // Save the start time, so a reload doesn't move it and hide replies that came in between.
  if (raw === null) write(current);
  return current;
}

function write(next: RemoteBotSeen): void {
  current = next;
  try {
    window.localStorage.setItem(REMOTE_BOT_SEEN_KEY, serializeRemoteBotSeen(next));
  } catch {
    // Storage is full or off: the dot still works for this window.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== REMOTE_BOT_SEEN_KEY) return;
    current = parseRemoteBotSeen(event.newValue);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** This window's record of what each paired Mac's Bot has shown. */
export function useRemoteBotSeen(): RemoteBotSeen {
  return React.useSyncExternalStore(subscribe, read, read);
}

/** Records that the remote Bot's chat shows its reply at `replyAt`. */
export function markRemoteBotSeen(key: string, replyAt: number | undefined): void {
  const before = read();
  const next = withRemoteBotSeen(before, key, replyAt);
  if (next !== before) write(next);
}

/** Tests start each case from an empty record. */
export function resetRemoteBotSeenForTests(): void {
  current = null;
}
