// The app's one usage-limit gate: shared by every chat, Bot and helper on this
// Mac, saved to `userData/usage-limits.json` so a wait survives a restart, and
// mirrored to the windows so a waiting reply can say when it tries again.

import type { UsageLimitWaitView, UsageLimitsChangedEvent } from "../../renderer/shared/usage-limits.js";
import {
  parseUsageLimitEntries,
  usageLimitMaxWaitMs,
  UsageLimitGate,
  type UsageLimitEntriesDocument,
  type UsageLimitGateClock,
  type UsageLimitOwner,
} from "./usage-limit-core.js";
import type { UsageLimitStreamOptions, UsageLimitWaitEvent } from "./usage-limit-stream.js";

export const USAGE_LIMITS_FILE = "usage-limits.json";
const SAVE_DEBOUNCE_MS = 500;
const BROADCAST_DEBOUNCE_MS = 50;

export interface UsageLimitPersistence {
  load(): Promise<unknown>;
  save(document: UsageLimitEntriesDocument): Promise<void>;
}

export interface UsageLimitServiceDependencies {
  persistence: UsageLimitPersistence;
  /** The owner's longest-wait setting, read at every hit. */
  waitHours(): Promise<unknown>;
  broadcast(event: UsageLimitsChangedEvent): void;
  clock?: UsageLimitGateClock;
  onError?(error: unknown): void;
  onWait?(event: UsageLimitWaitEvent): void;
  onGiveUp?(event: UsageLimitWaitEvent): void;
}

export class UsageLimitService {
  readonly gate: UsageLimitGate;
  private loading: Promise<void> | undefined;
  private savedJson = "";
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly dependencies: UsageLimitServiceDependencies) {
    this.gate = new UsageLimitGate(dependencies.clock);
    this.gate.onChange(() => {
      this.scheduleSave();
      this.scheduleBroadcast();
    });
  }

  private now(): number {
    return this.dependencies.clock?.now() ?? Date.now();
  }

  /** Load what an earlier run saved. Never fails: a bad file means no held limits. */
  ready(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const entries = parseUsageLimitEntries(await this.dependencies.persistence.load(), this.now());
        // Entries held since startup win over the saved ones.
        const live = new Set(this.gate.snapshot().map((entry) => entry.key));
        this.gate.load(entries.filter((entry) => !live.has(entry.key)));
        this.savedJson = JSON.stringify(entries);
      } catch (error) {
        this.dependencies.onError?.(error);
      }
    })();
    return this.loading;
  }

  async maxWaitMs(): Promise<number> {
    try {
      return usageLimitMaxWaitMs(await this.dependencies.waitHours());
    } catch (error) {
      this.dependencies.onError?.(error);
      return usageLimitMaxWaitMs(undefined);
    }
  }

  waits(): UsageLimitWaitView[] {
    return this.gate.waits().map((wait) => ({
      ownerKind: wait.owner.kind,
      ownerId: wait.owner.id,
      providerLabel: wait.providerLabel,
      modelId: wait.modelId,
      nextTryAt: wait.nextTryAt,
      ...(wait.resetAt !== undefined ? { resetAt: wait.resetAt } : {}),
      trying: wait.trying,
    }));
  }

  retryNow(owner: UsageLimitOwner): boolean {
    return this.gate.retryNow(owner);
  }

  /** Options for one chat's, Bot's or helper's requests. */
  streamOptions(
    owner: UsageLimitOwner,
    providerLabel: string,
    extra: Pick<UsageLimitStreamOptions, "observeFetch"> = {},
  ): UsageLimitStreamOptions {
    return {
      gate: this.gate,
      owner,
      providerLabel,
      maxWaitMs: () => this.maxWaitMs(),
      ready: () => this.ready(),
      ...(this.dependencies.clock ? { now: this.dependencies.clock.now, random: this.dependencies.clock.random } : {}),
      ...(this.dependencies.onWait ? { onWait: this.dependencies.onWait } : {}),
      ...(this.dependencies.onGiveUp ? { onGiveUp: this.dependencies.onGiveUp } : {}),
      ...extra,
    };
  }

  /** Write pending changes now, for quit. */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.save();
    }
    await this.saving;
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private save(): void {
    const entries = this.gate.snapshot();
    const json = JSON.stringify(entries);
    if (json === this.savedJson) return;
    this.savedJson = json;
    this.saving = this.saving
      .then(() => this.dependencies.persistence.save({ version: 1, entries }))
      .catch((error: unknown) => this.dependencies.onError?.(error));
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer !== undefined) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      try {
        this.dependencies.broadcast({ waits: this.waits() });
      } catch (error) {
        this.dependencies.onError?.(error);
      }
    }, BROADCAST_DEBOUNCE_MS);
    this.broadcastTimer.unref?.();
  }
}
