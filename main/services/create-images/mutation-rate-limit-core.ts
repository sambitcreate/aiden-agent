export class CreateImagesMutationRateLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxMutations = 120,
    private readonly windowMs = 60_000,
    private readonly maxOwners = 64,
  ) {
    if (
      !Number.isSafeInteger(maxMutations) ||
      maxMutations < 1 ||
      maxMutations > 10_000
    ) {
      throw new Error("Create Images mutation capacity is invalid.");
    }
    if (
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1_000 ||
      windowMs > 60 * 60_000
    ) {
      throw new Error("Create Images mutation window is invalid.");
    }
    if (
      !Number.isSafeInteger(maxOwners) ||
      maxOwners < 1 ||
      maxOwners > 1_024
    ) {
      throw new Error("Create Images owner capacity is invalid.");
    }
  }

  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.events) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length === 0) this.events.delete(key);
      else this.events.set(key, active);
    }
  }

  consume(ownerKey: string, cost = 1): boolean {
    if (!ownerKey || ownerKey.length > 768) return false;
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > this.maxMutations)
      return false;
    const now = this.now();
    const cutoff = now - this.windowMs;
    if (!this.events.has(ownerKey) && this.events.size >= this.maxOwners) {
      this.pruneExpired(now);
      if (this.events.size >= this.maxOwners) return false;
    }
    const recent = (this.events.get(ownerKey) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length + cost > this.maxMutations) {
      this.events.set(ownerKey, recent);
      return false;
    }
    for (let index = 0; index < cost; index += 1) recent.push(now);
    this.events.set(ownerKey, recent);

    if (this.events.size > Math.min(32, this.maxOwners)) this.pruneExpired(now);
    return true;
  }

  retryAfterMs(ownerKey: string): number {
    if (!ownerKey || ownerKey.length > 768) return this.windowMs;
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.events.get(ownerKey) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length < this.maxMutations) return 0;
    return Math.max(1, recent[0]! + this.windowMs - now);
  }

  ownerCountForTests(): number {
    return this.events.size;
  }
}
