/**
 * Background compaction summaries, at most one per chat.
 *
 * When an attended chat's turn ends close to its compaction trigger, the
 * coordinator writes the summary in the background on the chat's cached
 * prefix (see side-call-prefix). The next turn boundary applies it only when
 * the chat has not moved: the same context messages, model and approved
 * memory facts as when the summary was started. Anything else, and a summary still
 * being written, is aborted and discarded, so a turn never waits for one.
 *
 * Entries live in memory only. They hold the summary and the retained tail
 * the coordinator would publish, never credentials, and nothing is logged or
 * persisted. Each run is bounded by a timeout, and the registry by a chat
 * count.
 */
import type { CompactResult } from "./pi-legacy-harness.js";

/** What the chat looked like when its summary was started. */
export interface CompactionPrecomputeSnapshot {
  /**
   * Hash of the context messages the summary covers. Bookkeeping entries the
   * turn's commit appends after the reply leave it unchanged; a new message,
   * an edit, a branch or a compaction changes it.
   */
  readonly contextKey: string;
  /** The model the summary is written by; see `sideCallModelKey`. */
  readonly modelKey: string;
  /** Hash of the memory fact lines the chat could be told. */
  readonly memoryKey: string;
}

export interface CompactionPrecomputes {
  /**
   * Starts `run` for the chat. A chat already writing or holding a summary
   * for the same snapshot keeps it, and this returns false; one for another
   * snapshot is aborted and replaced.
   */
  start(
    chatKey: string,
    snapshot: CompactionPrecomputeSnapshot,
    run: (signal: AbortSignal) => Promise<CompactResult | undefined>,
  ): boolean;
  /**
   * Removes the chat's entry and returns its summary when it is finished and
   * was started for `snapshot`. Anything else is aborted and discarded.
   */
  take(chatKey: string, snapshot: CompactionPrecomputeSnapshot): CompactResult | undefined;
  /** Aborts and drops the chat's entry: the chat stopped, was deleted or compacted. */
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

function sameSnapshot(left: CompactionPrecomputeSnapshot, right: CompactionPrecomputeSnapshot): boolean {
  return left.contextKey === right.contextKey && left.modelKey === right.modelKey && left.memoryKey === right.memoryKey;
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
      if (existing && sameSnapshot(existing.snapshot, snapshot)) return false;
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
      return true;
    },
    take(chatKey, snapshot) {
      const entry = entries.get(chatKey);
      if (!entry) return undefined;
      const result = entry.result;
      drop(chatKey, entry);
      return result && sameSnapshot(entry.snapshot, snapshot) ? result : undefined;
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
