// Bot live view IPC (plan Task 1.4).
//
// `bots:live:subscribe(botId)` returns a full snapshot and then pushes
// `bots:live:event` to that renderer document only. A document holds at most
// one subscription per Bot: subscribing again (a reload, a remount) replaces
// it. Every subscription ends with its document.

import type { BotLiveEvent, BotLiveSnapshot, BotLiveSummary } from "../../renderer/shared/bot-live.js";
import type { BotLiveProjection } from "../services/bot-runtime/live-projection.js";

export const BOT_LIVE_EVENT_CHANNEL = "bots:live:event";

/** The renderer document that made a request. */
export interface BotLiveOwner {
  /** Stable for one document; a reload is a new owner. */
  readonly key: string;
  isDestroyed(): boolean;
  onInvalidated(listener: () => void): () => void;
  send(channel: typeof BOT_LIVE_EVENT_CHANNEL, event: BotLiveEvent): void;
}

export interface BotLiveHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  /** Throws for a sender that is not the current main frame. */
  owner(event: Event): BotLiveOwner;
  projection(): BotLiveProjection;
  parseBotId(value: unknown): string;
}

const INACTIVE = "The application document changed.";

export function registerBotLiveHandlers<Event>(dependencies: BotLiveHandlerDependencies<Event>): void {
  const { handle } = dependencies;
  /** owner key → botId → unsubscribe. */
  const subscriptions = new Map<string, Map<string, () => void>>();
  const watched = new Map<string, () => void>();

  const release = (ownerKey: string, botId?: string) => {
    const byBot = subscriptions.get(ownerKey);
    if (!byBot) return;
    for (const [id, unsubscribe] of [...byBot]) {
      if (botId !== undefined && id !== botId) continue;
      byBot.delete(id);
      unsubscribe();
    }
    if (byBot.size === 0) subscriptions.delete(ownerKey);
  };

  handle("bots:live:subscribe", async (event, rawBotId): Promise<BotLiveSnapshot> => {
    const owner = dependencies.owner(event);
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    const botId = dependencies.parseBotId(rawBotId);
    if (!watched.has(owner.key)) {
      watched.set(
        owner.key,
        owner.onInvalidated(() => {
          watched.delete(owner.key);
          release(owner.key);
        }),
      );
    }
    release(owner.key, botId);
    const subscription = await dependencies.projection().subscribe(botId, {
      send: (live) => {
        if (owner.isDestroyed()) throw new Error(INACTIVE);
        owner.send(BOT_LIVE_EVENT_CHANNEL, live);
      },
    });
    if (owner.isDestroyed()) {
      subscription.unsubscribe();
      throw new Error(INACTIVE);
    }
    let byBot = subscriptions.get(owner.key);
    if (!byBot) subscriptions.set(owner.key, (byBot = new Map()));
    // A newer subscribe for this Bot that finished first wins.
    byBot.get(botId)?.();
    byBot.set(botId, subscription.unsubscribe);
    return subscription.snapshot;
  });

  handle("bots:live:unsubscribe", (event, rawBotId) => {
    const owner = dependencies.owner(event);
    release(owner.key, dependencies.parseBotId(rawBotId));
  });

  handle("bots:live:summary", async (event, rawBotId): Promise<BotLiveSummary> => {
    const owner = dependencies.owner(event);
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    return dependencies.projection().summary(dependencies.parseBotId(rawBotId));
  });
}
