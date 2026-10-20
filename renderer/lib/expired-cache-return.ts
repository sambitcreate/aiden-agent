import type { CompactionEngine } from "../shared/compaction";
import type { ChatContextPressureV1 } from "../shared/context-pressure";

/**
 * Below this projected history size, resending an uncached chat costs little,
 * so returning to it never compacts or asks to.
 */
export const EXPIRED_CACHE_COMPACTION_MIN_TOKENS = 100_000;

/** A return starts an automatic compaction only if the chat settles this soon after it. */
export const EXPIRED_CACHE_RETURN_GRACE_MS = 30_000;

const HANDLED_STORAGE_KEY = "aiden.expired-cache-returns.v1";
const HANDLED_LIMIT = 200;

export interface ExpiredCacheInput {
  /** The chat's reading without the composer draft, which compaction cannot shrink. */
  pressure: ChatContextPressureV1 | null | undefined;
  engine: CompactionEngine;
  /** Nothing is running, queued, held, recorded or being sent in this chat. */
  idle: boolean;
  now: number;
}

/** When the chat's prompt cache lapses, or undefined when no lifetime is known. */
export function promptCacheExpiresAt(pressure: ChatContextPressureV1 | null | undefined): number | undefined {
  const cache = pressure?.promptCache;
  return cache ? cache.lastRequestAt + cache.ttlMs : undefined;
}

/**
 * The expired cache window a return at `returnedAt` would rebuild, keyed by
 * the request that last used the cache: the cache had lapsed by then, the next
 * request is large, and compacting could shrink it. A chat the runtime already
 * compacts before its next request is left to that.
 */
function expiredWindow(pressure: ChatContextPressureV1 | null | undefined, returnedAt: number): number | undefined {
  const expiresAt = promptCacheExpiresAt(pressure);
  if (!pressure?.promptCache || expiresAt === undefined || returnedAt < expiresAt) return undefined;
  if (pressure.shouldCompact || pressure.compressibleHistoryMessages === 0) return undefined;
  if (pressure.contextTokens < EXPIRED_CACHE_COMPACTION_MIN_TOKENS) return undefined;
  return pressure.promptCache.lastRequestAt;
}

interface HandledStore {
  load(): Record<string, number>;
  save(handled: Record<string, number>): void;
}

const localHandledStore: HandledStore = {
  load() {
    try {
      const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(HANDLED_STORAGE_KEY) ?? "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1])),
      );
    } catch {
      return {};
    }
  },
  save(handled) {
    try {
      globalThis.localStorage?.setItem(HANDLED_STORAGE_KEY, JSON.stringify(handled));
    } catch {
      // Best-effort: without storage a restart may offer the same window again.
    }
  },
};

/**
 * Decides what returning to a chat with an expired prompt cache does.
 *
 * A return is opening the chat, bringing the window back, or starting to
 * type, and it counts only once the cache has lapsed, so expiry while the user
 * sits idle never compacts. pi-vcc compacts locally for free, so a return
 * compacts on its own. LLM compaction spends model tokens, so a return only
 * offers it. Either happens at most once per cache window: only a new request
 * that uses the cache, or a compaction that changes the reading, brings the
 * offer or the compaction back.
 */
export class ExpiredCacheReturns {
  private readonly returnedAt = new Map<string, number>();
  private handled: Map<string, number> | undefined;

  constructor(private readonly store: HandledStore = localHandledStore) {}

  /** The user came back to this chat. */
  returned(chatId: string, now: number): void {
    this.returnedAt.set(chatId, now);
  }

  /**
   * Whether to start a pi-vcc compaction now. Claims the window when it says
   * yes, so callers start exactly one compaction for it.
   */
  takeAutomatic(chatId: string, input: ExpiredCacheInput): boolean {
    if (input.engine !== "vcc" || !input.idle) return false;
    const returnedAt = this.returnedAt.get(chatId);
    if (returnedAt === undefined || input.now - returnedAt > EXPIRED_CACHE_RETURN_GRACE_MS) return false;
    const window = expiredWindow(input.pressure, returnedAt);
    if (window === undefined || this.handledMap().get(chatId) === window) return false;
    this.returnedAt.delete(chatId);
    this.markHandled(chatId, window);
    return true;
  }

  /** The "Compact first?" offer for LLM compaction, if one stands. */
  offer(chatId: string, input: ExpiredCacheInput): { contextTokens: number } | undefined {
    if (input.engine !== "llm" || !input.idle || !input.pressure) return undefined;
    const returnedAt = this.returnedAt.get(chatId);
    if (returnedAt === undefined) return undefined;
    const window = expiredWindow(input.pressure, returnedAt);
    if (window === undefined || this.handledMap().get(chatId) === window) return undefined;
    return { contextTokens: input.pressure.contextTokens };
  }

  /**
   * The window is answered: the user accepted or dismissed the offer, or any
   * compaction ran in it. Its reading may not refresh before the next render.
   */
  settle(chatId: string, pressure: ChatContextPressureV1 | null | undefined): void {
    this.returnedAt.delete(chatId);
    if (pressure?.promptCache) this.markHandled(chatId, pressure.promptCache.lastRequestAt);
  }

  private handledMap(): Map<string, number> {
    this.handled ??= new Map(Object.entries(this.store.load()));
    return this.handled;
  }

  private markHandled(chatId: string, window: number): void {
    const handled = this.handledMap();
    handled.delete(chatId);
    handled.set(chatId, window);
    // Keep the most recently handled chats.
    while (handled.size > HANDLED_LIMIT) handled.delete(handled.keys().next().value as string);
    this.store.save(Object.fromEntries(handled));
  }
}

/** Shared across Composer remounts, which happen on every chat switch. */
export const expiredCacheReturns = new ExpiredCacheReturns();
