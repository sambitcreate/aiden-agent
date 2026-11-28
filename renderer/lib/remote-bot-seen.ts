// The newest reply of each paired Mac's Bot this Mac has shown, so a newer
// one reads as unread (the dot on its row). Kept per device in local storage,
// keyed `hostId/botId`, apart from this Mac's own Bots' preferences, which
// drop any Bot this Mac doesn't have. Every time here is the host's
// (`lastReplyAt` on its feed rows, revision 52, and its session entries'
// `createdAt`), never this Mac's clock, so a host whose clock is ahead or
// behind still gets the right dots. `hostSince` is the newest reply a host's
// Bots had when this Mac first listed them: those replies start read. A host
// first listed with Bots but no replies gets 0, so its first reply is unread.
// Only a revision 66 host reports every Bot's reply, so the baseline waits for
// a listing whose every row it marked `summarized`.

import * as React from "react";
import { botLastReplyAt } from "../shared/bot-live";
import type { BotTranscriptEntry } from "../shared/bot-live";

export const REMOTE_BOT_SEEN_KEY = "aiden-agent.remote-bots-seen.v1";
export const REMOTE_BOT_SEEN_LIMIT = 200;

export interface RemoteBotSeen {
  /** Each host's newest reply when this Mac first listed its Bots (0 when none had replied), by host id. */
  hostSince: Readonly<Record<string, number>>;
  /** The newest reply each remote Bot's chat showed here, by `hostId/botId`. */
  seenReplyAt: Readonly<Record<string, number>>;
}

const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function newest(times: Record<string, number>): Record<string, number> {
  const entries = Object.entries(times);
  if (entries.length <= REMOTE_BOT_SEEN_LIMIT) return times;
  return Object.fromEntries(
    entries.sort((left, right) => right[1] - left[1]).slice(0, REMOTE_BOT_SEEN_LIMIT),
  );
}

const validBaseline = (value: unknown): value is number => value === 0 || validTime(value);

function times(
  value: unknown,
  valid: (at: unknown) => at is number = validTime,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
    if (key && valid(at)) out[key] = at;
  }
  return newest(out);
}

export function parseRemoteBotSeen(raw: string | null): RemoteBotSeen {
  const fresh = { hostSince: {}, seenReplyAt: {} };
  if (raw === null) return fresh;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fresh;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fresh;
  const record = value as Record<string, unknown>;
  if (record.version !== 2) return fresh;
  return {
    hostSince: times(record.hostSince, validBaseline),
    seenReplyAt: times(record.seenReplyAt),
  };
}

export function serializeRemoteBotSeen(seen: RemoteBotSeen): string {
  return JSON.stringify({ version: 2, hostSince: seen.hostSince, seenReplyAt: seen.seenReplyAt });
}

/** What a listed remote Bot row says about its messages (`RemoteBotChoice`). */
export interface RemoteBotListedRow {
  lastReplyAt?: number;
  preview?: string;
  /** The host read the Bot's summary (revision 66), so no `lastReplyAt` means no reply yet. */
  summarized?: true;
}

/**
 * The first time this Mac lists a host's Bots, their replies so far start
 * read: the host's newest reply becomes its baseline. Bots with no reply yet
 * get a baseline of 0, so the first reply that arrives later is unread.
 *
 * Nothing is set until a listing reports every Bot's reply: a revision 66
 * host marks each Bot whose summary it read `summarized`, and the baseline
 * waits until every listed Bot is. An older host marks none and sends reply
 * times only for Bots whose chat is open there, and a Bot whose summary read
 * failed this time is unmarked; a baseline taken without them would be too low
 * and their earlier replies would read as new later. An empty list sets
 * nothing either.
 */
export function withRemoteBotHostListed(
  seen: RemoteBotSeen,
  hostId: string,
  rows: readonly RemoteBotListedRow[],
): RemoteBotSeen {
  if (seen.hostSince[hostId] !== undefined) return seen;
  if (rows.length === 0 || !rows.every((row) => row.summarized === true)) return seen;
  const known = rows.map((row) => row.lastReplyAt).filter(validTime);
  const since = known.length === 0 ? 0 : Math.max(...known);
  return { ...seen, hostSince: newest({ ...seen.hostSince, [hostId]: since }) };
}

/** The remote Bot's chat showed the reply at `replyAt`; the seen time only moves forward. */
export function withRemoteBotSeen(
  seen: RemoteBotSeen,
  key: string,
  replyAt: number | undefined,
): RemoteBotSeen {
  if (replyAt === undefined || !validTime(replyAt) || replyAt <= (seen.seenReplyAt[key] ?? 0))
    return seen;
  return { ...seen, seenReplyAt: newest({ ...seen.seenReplyAt, [key]: replyAt }) };
}

/** A reply newer than the newest one its chat showed here, or than its host's baseline when it never showed one. */
export function isRemoteBotUnread(
  seen: RemoteBotSeen,
  hostId: string,
  botId: string,
  lastReplyAt: number | undefined,
): boolean {
  const baseline = seen.seenReplyAt[`${hostId}/${botId}`] ?? seen.hostSince[hostId];
  return lastReplyAt !== undefined && baseline !== undefined && lastReplyAt > baseline;
}

/**
 * The newest reply a remote Bot's chat shows, in the host's clock: the feed's
 * `lastReplyAt` once the shown session reaches it, otherwise the newest reply
 * among the shown entries. Null while nothing is shown, so a slow or failed
 * read never clears a dot for a reply the person hasn't seen.
 */
export function remoteBotShownReplyAt(
  entries: readonly BotTranscriptEntry[] | undefined,
  feedLastReplyAt: number | undefined,
): number | null {
  if (!entries || entries.length === 0) return null;
  let reached = -Infinity;
  for (const entry of entries) {
    const at = (entry as { at?: number }).at;
    if (at !== undefined && at > reached) reached = at;
  }
  if (feedLastReplyAt !== undefined && validTime(feedLastReplyAt) && reached >= feedLastReplyAt)
    return feedLastReplyAt;
  return botLastReplyAt(entries);
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

/** Sets a host's baseline the first time its Bots are listed here (`withRemoteBotHostListed`). */
export function markRemoteBotHostListed(hostId: string, rows: readonly RemoteBotListedRow[]): void {
  const before = read();
  const next = withRemoteBotHostListed(before, hostId, rows);
  if (next !== before) write(next);
}

/** Records that the remote Bot's chat shows its reply at `replyAt`. */
export function markRemoteBotSeen(key: string, replyAt: number | null | undefined): void {
  const before = read();
  const next = withRemoteBotSeen(before, key, replyAt ?? undefined);
  if (next !== before) write(next);
}

/** Tests start each case from an empty record. */
export function resetRemoteBotSeenForTests(): void {
  current = null;
}
