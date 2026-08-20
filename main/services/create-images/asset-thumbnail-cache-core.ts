export interface ByteSizedValue {
  byteLength: number;
}

/** Strict byte-bounded LRU. Values larger than the entire budget are never retained. */
export class ByteBoundedLru<Value extends ByteSizedValue> {
  private readonly entries = new Map<string, Value>();
  private retainedBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Thumbnail cache capacity must be a positive integer byte count.");
    }
  }

  get(key: string): Value | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Value): void {
    if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
      throw new Error("Cached values require an exact non-negative byte length.");
    }
    this.delete(key);
    if (value.byteLength > this.maxBytes) return;
    while (this.retainedBytes + value.byteLength > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(key, value);
    this.retainedBytes += value.byteLength;
  }

  delete(key: string): boolean {
    const value = this.entries.get(key);
    if (!value) return false;
    this.entries.delete(key);
    this.retainedBytes -= value.byteLength;
    return true;
  }

  deletePrefix(prefix: string): number {
    let deleted = 0;
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.delete(key);
      deleted += 1;
    }
    return deleted;
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteLength(): number {
    return this.retainedBytes;
  }
}
