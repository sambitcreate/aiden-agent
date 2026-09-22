import * as React from "react";
import type { BotRendererCanonicalPhoto } from "../shared/bots";
import { botsApi } from "./ipc";

export const BOT_CANONICAL_PHOTO_MAX_CONCURRENT = 4;
export const BOT_CANONICAL_PHOTO_CACHE_MAX_BYTES = 32 * 1_048_576;
export const BOT_CANONICAL_PHOTO_CACHE_MAX_ENTRIES = 64;
const BOT_CANONICAL_PHOTO_MAX_BYTES = 4 * 1_048_576;

type Priority = "visible" | "selected";
type Snapshot = BotRendererCanonicalPhoto | null | undefined;
type Loader = (botId: string) => Promise<BotRendererCanonicalPhoto | null>;

interface Entry {
  value: BotRendererCanonicalPhoto | null;
  bytes: number;
  lastUsed: number;
}

interface Pending {
  botId: string;
  priority: Priority;
  epoch: number;
}

interface Subscriber {
  listener(): void;
  priority: Priority;
}

function priorityRank(priority: Priority): number {
  return priority === "selected" ? 1 : 0;
}

function decodedDataUrlBytes(value: BotRendererCanonicalPhoto): number | null {
  const prefix = "data:image/png;base64,";
  if (!value.dataUrl.startsWith(prefix)) return null;
  const encoded = value.dataUrl.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return (encoded.length / 4) * 3 - padding;
}

export class BotCanonicalPhotoCache {
  private readonly entries = new Map<string, Entry>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly pending = new Map<string, Pending>();
  private readonly activeBotEpochs = new Map<string, number>();
  private readonly idleWaiters = new Set<() => void>();
  private active = 0;
  private bytes = 0;
  private clock = 0;
  private epoch = 0;

  constructor(
    private readonly load: Loader,
    private readonly limits = {
      maxConcurrent: BOT_CANONICAL_PHOTO_MAX_CONCURRENT,
      maxBytes: BOT_CANONICAL_PHOTO_CACHE_MAX_BYTES,
      maxEntries: BOT_CANONICAL_PHOTO_CACHE_MAX_ENTRIES,
    },
  ) {}

  snapshot(botId: string): Snapshot {
    const entry = this.entries.get(botId);
    if (!entry) return undefined;
    entry.lastUsed = ++this.clock;
    return entry.value;
  }

  subscribe(botId: string, priority: Priority, listener: () => void): () => void {
    const subscriber = { listener, priority };
    const current = this.subscribers.get(botId) ?? new Set<Subscriber>();
    current.add(subscriber);
    this.subscribers.set(botId, current);
    return () => {
      current.delete(subscriber);
      if (current.size === 0) {
        this.subscribers.delete(botId);
        this.pending.delete(botId);
        this.resolveIdle();
      } else {
        const pending = this.pending.get(botId);
        if (pending) {
          pending.priority = [...current].some(({ priority }) => priority === "selected")
            ? "selected"
            : "visible";
        }
      }
    };
  }

  request(botId: string, priority: Priority): void {
    if (this.entries.has(botId)) {
      this.snapshot(botId);
      return;
    }
    const queued = this.pending.get(botId);
    if (queued) {
      if (priorityRank(priority) > priorityRank(queued.priority)) queued.priority = priority;
      return;
    }
    if (this.activeBotEpochs.get(botId) === this.epoch) return;
    this.pending.set(botId, { botId, priority, epoch: this.epoch });
    this.drain();
  }

  invalidateAll(): void {
    this.epoch += 1;
    this.entries.clear();
    this.pending.clear();
    this.bytes = 0;
    const activeSubscribers = [...this.subscribers.entries()].map(([botId, subscribers]) => ({
      botId,
      priority: [...subscribers].some(({ priority }) => priority === "selected")
        ? "selected" as const
        : "visible" as const,
    }));
    this.notifyAll();
    for (const { botId, priority } of activeSubscribers) this.request(botId, priority);
  }

  stats(): Readonly<{ active: number; queued: number; entries: number; bytes: number }> {
    return {
      active: this.active,
      queued: this.pending.size,
      entries: this.entries.size,
      bytes: this.bytes,
    };
  }

  settle(): Promise<void> {
    if (this.active === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private drain(): void {
    while (this.active < this.limits.maxConcurrent && this.pending.size > 0) {
      const next = [...this.pending.values()].sort(
        (left, right) => priorityRank(right.priority) - priorityRank(left.priority),
      )[0]!;
      this.pending.delete(next.botId);
      this.active += 1;
      this.activeBotEpochs.set(next.botId, next.epoch);
      void this.load(next.botId).then(
        (value) => this.publish(next, value),
        () => this.publish(next, null),
      ).finally(() => {
        if (this.activeBotEpochs.get(next.botId) === next.epoch) {
          this.activeBotEpochs.delete(next.botId);
        }
        this.active -= 1;
        this.drain();
        this.resolveIdle();
      });
    }
  }

  private publish(pending: Pending, value: BotRendererCanonicalPhoto | null): void {
    if (pending.epoch !== this.epoch) return;
    const decodedBytes = value ? decodedDataUrlBytes(value) : 0;
    const accepted = decodedBytes !== null && decodedBytes <= BOT_CANONICAL_PHOTO_MAX_BYTES
      ? value
      : null;
    const bytes = accepted ? decodedBytes! : 0;
    const previous = this.entries.get(pending.botId);
    if (previous) this.bytes -= previous.bytes;
    this.entries.set(pending.botId, { value: accepted, bytes, lastUsed: ++this.clock });
    this.bytes += bytes;
    this.prune(pending.botId);
    this.notify(pending.botId);
  }

  private prune(protectedBotId: string): void {
    while (this.bytes > this.limits.maxBytes || this.entries.size > this.limits.maxEntries) {
      const oldest = [...this.entries.entries()]
        .filter(([botId]) => botId !== protectedBotId)
        .sort((left, right) => {
          const leftSelected = [...(this.subscribers.get(left[0]) ?? [])]
            .some(({ priority }) => priority === "selected");
          const rightSelected = [...(this.subscribers.get(right[0]) ?? [])]
            .some(({ priority }) => priority === "selected");
          return Number(leftSelected) - Number(rightSelected) || left[1].lastUsed - right[1].lastUsed;
        })[0];
      if (!oldest) {
        const only = this.entries.get(protectedBotId);
        if (only && only.bytes > this.limits.maxBytes) {
          this.entries.delete(protectedBotId);
          this.bytes -= only.bytes;
        }
        break;
      }
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
      this.notify(oldest[0]);
    }
  }

  private notify(botId: string): void {
    for (const { listener } of this.subscribers.get(botId) ?? []) listener();
  }

  private notifyAll(): void {
    for (const subscribers of this.subscribers.values()) {
      for (const { listener } of subscribers) listener();
    }
  }

  private resolveIdle(): void {
    if (this.active !== 0 || this.pending.size !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

const botCanonicalPhotos = new BotCanonicalPhotoCache(botsApi.getCanonicalPhoto);

export function useBotCanonicalPhoto(
  botId: string | undefined,
  enabled: boolean,
  priority: Priority,
): Snapshot {
  const subscribe = React.useCallback(
    (listener: () => void) => botId && enabled
      ? botCanonicalPhotos.subscribe(botId, priority, listener)
      : () => undefined,
    [botId, enabled, priority],
  );
  const getSnapshot = React.useCallback(
    () => botId && enabled ? botCanonicalPhotos.snapshot(botId) : undefined,
    [botId, enabled],
  );
  const value = React.useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  React.useEffect(() => {
    if (botId && enabled) botCanonicalPhotos.request(botId, priority);
  }, [botId, enabled, priority]);
  return value;
}

export function invalidateBotCanonicalPhotos(): void {
  botCanonicalPhotos.invalidateAll();
}
