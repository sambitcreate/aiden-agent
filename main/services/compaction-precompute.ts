/**
 * Background compaction summaries, at most one per chat.
 *
 * When an attended chat's turn ends close to its compaction trigger, the
 * coordinator writes the summary in the background on the chat's cached
 * prefix (see side-call-prefix). The summary stays usable while the chat is
 * only appended to: the same branch, model and approved memory facts, with
 * the messages it covers still the start of the chat's context. When
 * compaction is due, the coordinator stores it with everything after those
 * messages as the kept tail. Anything else discards it, and one still being
 * written when compaction is due is aborted, so a turn never waits for one.
 *
 * Entries live in memory only. They hold the summary and the retained tail
 * the coordinator would publish, never credentials, and nothing is logged or
 * persisted. Each run is bounded by a timeout, and the registry by a chat
 * count.
 */
import type { CompactResult } from "./pi-legacy-harness.js";

/** What the chat looked like when its summary was started. */
export interface CompactionPrecomputeSnapshot {
  /** The journal branch's entry ids, oldest first; a later branch must start with them. */
  readonly branchIds: readonly string[];
  /** Hash of the context messages the summary covers. */
  readonly contextKey: string;
  /** How many context messages it covers; the chat's context must still start with them. */
  readonly contextLength: number;
  /** The model the summary is written by; see `sideCallModelKey`. */
  readonly modelKey: string;
  /** Hash of the memory fact lines the chat could be told. */
  readonly memoryKey: string;
  /**
   * Tokens the request sends besides its messages (system prompt and tools),
   * as the provider counted them for the prefix the summary continues.
   */
  readonly overheadTokens: number;
}

export interface CompactionPrecomputes {
  /** Starts `run` for the chat, aborting and replacing the chat's earlier entry. */
  start(
    chatKey: string,
    snapshot: CompactionPrecomputeSnapshot,
    run: (signal: AbortSignal) => Promise<CompactResult | undefined>,
  ): void;
  /** The snapshot of the chat's entry, written or still being written. */
  current(chatKey: string): CompactionPrecomputeSnapshot | undefined;
  /**
   * Removes the chat's entry and returns it when its summary is finished. One
   * still being written is aborted.
   */
  take(chatKey: string): { snapshot: CompactionPrecomputeSnapshot; result: CompactResult } | undefined;
  /** Aborts and drops the chat's entry: the chat stopped, moved, was deleted or compacted. */
  discard(chatKey: string): void;
  /** Whether the chat has an entry, written or still being written. */
  has(chatKey: string): boolean;
  /** Whether the chat has a summary being written. */
  running(chatKey: string): boolean;
}

export interface CompactionPrecomputeClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

const realClock: CompactionPrecomputeClock = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

interface Entry {
  readonly snapshot: CompactionPrecomputeSnapshot;
  readonly controller: AbortController;
  timer?: unknown;
  result?: CompactResult;
}

export function createCompactionPrecomputes(
  settings: { maxChats?: number; timeoutMs?: number; clock?: CompactionPrecomputeClock } = {},
): CompactionPrecomputes {
  const maxChats = settings.maxChats ?? 8;
  const timeoutMs = settings.timeoutMs ?? 5 * 60_000;
  const clock = settings.clock ?? realClock;
  const entries = new Map<string, Entry>();

  const drop = (chatKey: string, entry: Entry) => {
    if (entries.get(chatKey) === entry) entries.delete(chatKey);
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.controller.abort();
  };

  return {
    start(chatKey, snapshot, run) {
      const existing = entries.get(chatKey);
      if (existing) drop(chatKey, existing);
      const entry: Entry = { snapshot, controller: new AbortController() };
      entries.set(chatKey, entry);
      while (entries.size > maxChats) {
        const oldest = entries.entries().next().value;
        if (!oldest) break;
        drop(oldest[0], oldest[1]);
      }
      entry.timer = clock.setTimeout(() => drop(chatKey, entry), timeoutMs);
      void Promise.resolve()
        .then(() => run(entry.controller.signal))
        .then(
          (result) => {
            if (entries.get(chatKey) !== entry || entry.controller.signal.aborted || !result) {
              drop(chatKey, entry);
              return;
            }
            if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
            entry.timer = undefined;
            entry.result = result;
          },
          () => drop(chatKey, entry),
        );
    },
    current(chatKey) {
      return entries.get(chatKey)?.snapshot;
    },
    take(chatKey) {
      const entry = entries.get(chatKey);
      if (!entry) return undefined;
      const result = entry.result;
      drop(chatKey, entry);
      return result ? { snapshot: entry.snapshot, result } : undefined;
    },
    discard(chatKey) {
      const entry = entries.get(chatKey);
      if (entry) drop(chatKey, entry);
    },
    has(chatKey) {
      return entries.has(chatKey);
    },
    running(chatKey) {
      const entry = entries.get(chatKey);
      return entry !== undefined && entry.result === undefined;
    },
  };
}

/** One registry per process, for the desktop's attended chats. */
export const chatCompactionPrecomputes: CompactionPrecomputes = createCompactionPrecomputes();

/**
 * Whether the chat's spending limit leaves room for a background summary.
 * Counted usage settles first; a failing check counts as no room.
 */
export async function precomputeWithinSpendingLimit<Owner>(
  spending: { refusal(owner: Owner): Promise<string | undefined> },
  owner: Owner,
  settled?: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await settled?.();
    return (await spending.refusal(owner)) === undefined;
  } catch {
    return false;
  }
}
