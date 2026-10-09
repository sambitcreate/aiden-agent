const INVALIDATED = "Bot runtime capabilities changed.";

export class BotRuntimeInventoryLeaseInvalidError extends Error {
  readonly name = "BotRuntimeInventoryLeaseInvalidError";

  constructor() {
    super(INVALIDATED);
  }
}

export type BotRuntimeInventoryMutation =
  | "settings"
  | "provider_configuration"
  | "provider_credential"
  | "mcp_configuration"
  | "mcp_credential"
  | "skill_configuration"
  | "skill_content"
  | "inventory_changed";

export interface BotRuntimeInventoryLease {
  readonly generation: number;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  release(): void;
}

interface ActiveInventoryLease {
  generation: number;
  controller: AbortController;
}

/**
 * Process-owned fence for authority facts that live outside the durable Bot
 * policy store. Config, credentials, and skill contents can all change without
 * incrementing a Bot policy epoch, so every active Bot turn also holds this
 * lease.
 */
export class BotRuntimeInventoryLeaseRegistry {
  private generation = 1;
  private readonly active = new Set<ActiveInventoryLease>();
  private readonly fingerprints = new Map<string, string>();

  acquire(): BotRuntimeInventoryLease {
    const active: ActiveInventoryLease = {
      generation: this.generation,
      controller: new AbortController(),
    };
    this.active.add(active);
    let released = false;
    const assertCurrent = () => {
      if (
        released ||
        active.controller.signal.aborted ||
        active.generation !== this.generation
      ) {
        throw new BotRuntimeInventoryLeaseInvalidError();
      }
    };
    return Object.freeze({
      generation: active.generation,
      signal: active.controller.signal,
      assertCurrent,
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(active);
      },
    });
  }

  invalidate(_reason: BotRuntimeInventoryMutation): void {
    if (this.generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Bot runtime inventory generation is exhausted.");
    }
    this.generation += 1;
    // A controlled mutation already fenced the old facts. Let the next fresh
    // snapshot establish a baseline instead of aborting its own admission by
    // comparing against the deliberately invalidated pre-mutation snapshot.
    this.fingerprints.clear();
    const active = [...this.active];
    this.active.clear();
    for (const lease of active) {
      lease.controller.abort(new BotRuntimeInventoryLeaseInvalidError());
    }
  }

  /**
   * Publish a main-only snapshot fingerprint. First observation establishes a
   * baseline; a later observation of unhooked inventory drift fences all active
   * turns. Discovered skill files additionally have a live production watcher.
   */
  publishFingerprint(scope: string, fingerprint: string): void {
    const previous = this.fingerprints.get(scope);
    this.fingerprints.set(scope, fingerprint);
    if (previous !== undefined && previous !== fingerprint) {
      this.invalidate("inventory_changed");
    }
  }

  activeCount(): number {
    return this.active.size;
  }

  /** Read-only publication fence for other main-owned credential consumers. */
  revision(): number {
    return this.generation;
  }
}

export const botRuntimeInventoryLeases = new BotRuntimeInventoryLeaseRegistry();

export function invalidateBotRuntimeInventoryAuthority(
  reason: BotRuntimeInventoryMutation,
): void {
  botRuntimeInventoryLeases.invalidate(reason);
}

/**
 * Take a fresh read under a new lease and keep that lease. When a legitimate
 * global mutation fences the lease mid-read, the read is retried (bounded) so
 * a concurrent login or settings save cannot fail an unrelated Bot request.
 * The returned lease is still held; the caller releases it.
 */
export async function readUnderFreshBotRuntimeInventoryLease<Value>(
  registry: Pick<BotRuntimeInventoryLeaseRegistry, "acquire">,
  read: (lease: BotRuntimeInventoryLease) => Promise<Value>,
  attempts = 3,
): Promise<{ lease: BotRuntimeInventoryLease; value: Value }> {
  for (let attempt = 1; ; attempt += 1) {
    const lease = registry.acquire();
    try {
      const value = await read(lease);
      lease.assertCurrent();
      return { lease, value };
    } catch (error) {
      lease.release();
      const fenced = error instanceof BotRuntimeInventoryLeaseInvalidError || lease.signal.aborted;
      if (!fenced || attempt >= attempts) throw error;
    }
  }
}
