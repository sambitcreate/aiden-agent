import type { CreateImagesAssetGrantView } from "../shared/create-images/ipc";

export class AssetPreviewLoadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AssetPreviewLoadError";
  }
}

interface AssetPreviewEntry {
  failures: number;
  grant?: CreateImagesAssetGrantView;
  inFlight: boolean;
  retryAt: number;
  terminal: boolean;
}

export type AssetPreviewLifecycleStatus = "loading" | "retrying" | "ready" | "unavailable";

interface AssetPreviewTimerHost {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface AssetPreviewLifecycleOptions {
  load(assetId: string): Promise<CreateImagesAssetGrantView>;
  revoke(token: string): Promise<unknown>;
  now?: () => number;
  maxConcurrent?: number;
  renewBeforeMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  loadTimeoutMs?: number;
  timers?: AssetPreviewTimerHost;
}

const DEFAULT_TIMERS: AssetPreviewTimerHost = {
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clear: (handle) => window.clearTimeout(handle as number),
};

function snapshotOf(
  entries: ReadonlyMap<string, AssetPreviewEntry>,
): Readonly<Record<string, CreateImagesAssetGrantView>> {
  const snapshot: Record<string, CreateImagesAssetGrantView> = {};
  for (const [assetId, entry] of entries) {
    if (entry.grant) snapshot[assetId] = entry.grant;
  }
  return snapshot;
}

/**
 * Owns renderer preview grants independently of React renders. It limits grant
 * requests, renews before expiry, retains the previous URL until its
 * replacement is ready, and makes every token leave through one revoke path.
 */
export class AssetPreviewLifecycleManager {
  private readonly entries = new Map<string, AssetPreviewEntry>();
  private readonly desired = new Set<string>();
  private readonly retained = new Map<string, number>();
  private readonly adopted = new Set<string>();
  private readonly listeners = new Set<
    (snapshot: Readonly<Record<string, CreateImagesAssetGrantView>>) => void
  >();
  private readonly queued = new Set<string>();
  private readonly queue: string[] = [];
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly renewBeforeMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly loadTimeoutMs: number;
  private readonly timers: AssetPreviewTimerHost;
  private active = 0;
  private disposed = false;
  private wakeTimer: unknown;
  private snapshotValue: Readonly<Record<string, CreateImagesAssetGrantView>> = Object.freeze({});

  constructor(private readonly options: AssetPreviewLifecycleOptions) {
    this.now = options.now ?? Date.now;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.renewBeforeMs = options.renewBeforeMs ?? 15_000;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 10_000;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    if (
      !Number.isSafeInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      this.maxConcurrent > 16
    ) {
      throw new Error("Asset previews require 1–16 concurrent grant requests.");
    }
    if (!Number.isFinite(this.renewBeforeMs) || this.renewBeforeMs < 1_000) {
      throw new Error("Asset preview renewal must begin at least one second before expiry.");
    }
    if (
      !Number.isFinite(this.retryBaseMs) ||
      !Number.isFinite(this.retryMaxMs) ||
      this.retryBaseMs < 100 ||
      this.retryMaxMs < this.retryBaseMs
    ) {
      throw new Error("Asset preview retry bounds are invalid.");
    }
    if (!Number.isFinite(this.loadTimeoutMs) || this.loadTimeoutMs < 1_000) {
      throw new Error("Asset preview loading must have a timeout of at least one second.");
    }
  }

  snapshot(): Readonly<Record<string, CreateImagesAssetGrantView>> {
    return this.snapshotValue;
  }

  status(assetId: string): AssetPreviewLifecycleStatus | undefined {
    const entry = this.entries.get(assetId);
    if (!entry || !this.desired.has(assetId)) return undefined;
    if (entry.grant) return "ready";
    if (entry.terminal) return "unavailable";
    return entry.failures > 0 ? "retrying" : "loading";
  }

  subscribe(
    listener: (snapshot: Readonly<Record<string, CreateImagesAssetGrantView>>) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    this.snapshotValue = Object.freeze(snapshotOf(this.entries));
    for (const listener of this.listeners) listener(this.snapshotValue);
  }

  private revoke(token: string): Promise<void> {
    return this.options.revoke(token).then(
      () => undefined,
      () => undefined,
    );
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer === undefined) return;
    this.timers.clear(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private scheduleWake(): void {
    this.clearWakeTimer();
    if (this.disposed) return;
    const now = this.now();
    let nextAt = Number.POSITIVE_INFINITY;
    for (const [assetId, entry] of this.entries) {
      if (!this.desired.has(assetId) || entry.inFlight || this.queued.has(assetId)) {
        continue;
      }
      if (entry.terminal) {
        if (entry.grant) nextAt = Math.min(nextAt, entry.grant.expiresAt);
        continue;
      }
      const renewalAt = entry.grant ? entry.grant.expiresAt - this.renewBeforeMs : entry.retryAt;
      nextAt = Math.min(nextAt, Math.max(entry.retryAt, renewalAt));
    }
    if (!Number.isFinite(nextAt)) return;
    const delay = Math.min(2_147_483_647, Math.max(0, nextAt - now));
    this.wakeTimer = this.timers.set(() => {
      this.wakeTimer = undefined;
      this.refresh();
    }, delay);
  }

  private enqueue(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (
      this.disposed ||
      !entry ||
      !this.desired.has(assetId) ||
      entry.inFlight ||
      entry.terminal ||
      this.queued.has(assetId)
    ) {
      return;
    }
    this.queued.add(assetId);
    this.queue.push(assetId);
  }

  private pump(): void {
    while (!this.disposed && this.active < this.maxConcurrent && this.queue.length > 0) {
      const assetId = this.queue.shift();
      if (!assetId) continue;
      this.queued.delete(assetId);
      const entry = this.entries.get(assetId);
      if (!entry || !this.desired.has(assetId) || entry.inFlight || entry.terminal) continue;
      entry.inFlight = true;
      this.active += 1;
      this.publish();
      void this.load(assetId, entry);
    }
    this.scheduleWake();
  }

  private async load(assetId: string, entry: AssetPreviewEntry): Promise<void> {
    try {
      const grant = await this.loadWithTimeout(assetId);
      if (this.disposed || !this.desired.has(assetId) || this.entries.get(assetId) !== entry) {
        await this.revoke(grant.token);
        return;
      }
      const previous = entry.grant;
      entry.grant = grant;
      entry.retryAt = this.now();
      entry.terminal = false;
      this.publish();
      if (previous && previous.token !== grant.token) await this.revoke(previous.token);
    } catch (error) {
      if (!this.disposed && this.desired.has(assetId) && this.entries.get(assetId) === entry) {
        entry.failures += 1;
        entry.terminal = error instanceof AssetPreviewLoadError && !error.retryable;
        const delay = Math.min(
          this.retryMaxMs,
          this.retryBaseMs * 2 ** Math.min(16, entry.failures - 1),
        );
        entry.retryAt = this.now() + delay;
        this.publish();
      }
    } finally {
      entry.inFlight = false;
      this.active -= 1;
      this.refresh();
    }
  }

  private loadWithTimeout(assetId: string): Promise<CreateImagesAssetGrantView> {
    let source: Promise<CreateImagesAssetGrantView>;
    try {
      source = Promise.resolve(this.options.load(assetId));
    } catch (error) {
      source = Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = this.timers.set(() => {
        if (settled) return;
        settled = true;
        reject(new AssetPreviewLoadError("The preview request timed out.", true));
      }, this.loadTimeoutMs);
      void source.then(
        (grant) => {
          if (settled) {
            void this.revoke(grant.token);
            return;
          }
          settled = true;
          this.timers.clear(timeout);
          resolve(grant);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          this.timers.clear(timeout);
          reject(error);
        },
      );
    });
  }

  setAssets(assetIds: readonly string[]): void {
    if (this.disposed) return;
    const next = new Set(assetIds);
    for (const assetId of [...this.desired]) {
      if (next.has(assetId)) continue;
      this.desired.delete(assetId);
      this.retained.delete(assetId);
      this.adopted.delete(assetId);
      this.drop(assetId);
    }
    this.refresh();
  }

  /** Keep one preview live for each mounted virtualized node that consumes it. */
  retain(assetId: string): () => void {
    if (this.disposed) return () => undefined;
    this.adopted.delete(assetId);
    this.retained.set(assetId, (this.retained.get(assetId) ?? 0) + 1);
    this.desired.add(assetId);
    if (!this.entries.has(assetId)) {
      this.entries.set(assetId, {
        failures: 0,
        inFlight: false,
        retryAt: this.now(),
        terminal: false,
      });
    }
    this.refresh();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (this.retained.get(assetId) ?? 1) - 1;
      if (remaining > 0) {
        this.retained.set(assetId, remaining);
        return;
      }
      this.retained.delete(assetId);
      if (this.adopted.has(assetId)) return;
      this.desired.delete(assetId);
      this.drop(assetId);
      this.scheduleWake();
    };
  }

  adopt(assetId: string, grant: CreateImagesAssetGrantView): void {
    if (this.disposed) {
      void this.revoke(grant.token);
      return;
    }
    if ((this.retained.get(assetId) ?? 0) === 0) this.adopted.add(assetId);
    else this.adopted.delete(assetId);
    this.desired.add(assetId);
    const previous = this.entries.get(assetId)?.grant;
    this.entries.set(assetId, {
      failures: 0,
      grant,
      inFlight: false,
      retryAt: this.now(),
      terminal: false,
    });
    this.publish();
    if (previous && previous.token !== grant.token) void this.revoke(previous.token);
    this.scheduleWake();
  }

  reportLoadError(assetId: string, token: string): void {
    const entry = this.entries.get(assetId);
    if (!entry?.grant || entry.grant.token !== token || !this.desired.has(assetId)) return;
    const failed = entry.grant;
    delete entry.grant;
    entry.failures += 1;
    entry.retryAt =
      this.now() +
      Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(16, entry.failures - 1));
    entry.terminal = false;
    this.publish();
    void this.revoke(failed.token);
    this.refresh();
  }

  reportLoadSuccess(assetId: string, token: string): void {
    const entry = this.entries.get(assetId);
    if (!entry?.grant || entry.grant.token !== token || !this.desired.has(assetId)) return;
    entry.failures = 0;
    entry.retryAt = this.now();
    entry.terminal = false;
    this.scheduleWake();
  }

  refresh(): void {
    if (this.disposed) return;
    const now = this.now();
    let changed = false;
    for (const [assetId, entry] of this.entries) {
      if (!this.desired.has(assetId)) continue;
      if (entry.grant && entry.grant.expiresAt <= now) {
        const expired = entry.grant;
        delete entry.grant;
        changed = true;
        void this.revoke(expired.token);
      }
      if (
        !entry.inFlight &&
        !entry.terminal &&
        entry.retryAt <= now &&
        (!entry.grant || entry.grant.expiresAt - now <= this.renewBeforeMs)
      ) {
        this.enqueue(assetId);
      }
    }
    if (changed) this.publish();
    this.pump();
  }

  private drop(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    this.entries.delete(assetId);
    this.queued.delete(assetId);
    if (entry.grant) void this.revoke(entry.grant.token);
    this.publish();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearWakeTimer();
    this.desired.clear();
    this.retained.clear();
    this.adopted.clear();
    this.queued.clear();
    this.queue.length = 0;
    const tokens = [...this.entries.values()].flatMap((entry) =>
      entry.grant ? [entry.grant.token] : [],
    );
    this.entries.clear();
    this.listeners.clear();
    this.snapshotValue = Object.freeze({});
    await Promise.all(tokens.map((token) => this.revoke(token)));
  }
}

/**
 * Defers permanent disposal until the next task so React development Strict
 * Mode can replay an effect cleanup/setup pair without poisoning the manager
 * that remains mounted. A real unmount still revokes every grant promptly.
 */
export function deferAssetPreviewLifecycleDisposal(
  manager: AssetPreviewLifecycleManager,
): () => void {
  let cancelled = false;
  const timer = setTimeout(() => {
    if (cancelled) return;
    void manager.dispose();
  }, 0);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
