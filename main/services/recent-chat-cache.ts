/**
 * A per-chat cache that keeps only the most recently used chats. Main-process
 * caches keyed by chat id otherwise live until the chat is deleted, so a week
 * of opening long chats would keep every one of them in memory. A miss only
 * costs a recompute, so entries must be safe to drop at any time.
 */
export class RecentChatCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("A recent-chat cache needs room for at least one chat.");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Read an entry and mark its chat as the most recently used. */
  get(chatId: string): V | undefined {
    if (!this.entries.has(chatId)) return undefined;
    const value = this.entries.get(chatId) as V;
    this.entries.delete(chatId);
    this.entries.set(chatId, value);
    return value;
  }

  /** Store an entry, dropping the least recently used chat beyond the limit. */
  set(chatId: string, value: V): void {
    this.entries.delete(chatId);
    this.entries.set(chatId, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  delete(chatId: string): void {
    this.entries.delete(chatId);
  }
}
