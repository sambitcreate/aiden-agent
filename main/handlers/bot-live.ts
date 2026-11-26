// Bot live view IPC (plan Task 1.4).
//
// `bots:live:subscribe(botId)` returns a full snapshot and then pushes
// `bots:live:event` to that renderer document only. A document holds at most
// one subscription per Bot: subscribing again (a reload, a remount) replaces
// it. Every subscription ends with its document.
//
// A subscription is also how main knows a Bot's chat is open: `shownInFront`
// says whether a document that holds one is in front of the person now.

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
  /**
   * The document shows this Bot's chat in front of the person: its window is
   * focused and they are at the Mac. A bubble overlay holds several Bots but
   * shows only its open mini chat, so the answer can differ per Bot.
   */
  inFront?(botId: string): boolean;
  /**
   * Whether the document may still follow this Bot. Checked before every
   * event: a bubble overlay loses a Bot when its head leaves that overlay's
   * display or closes, and its feed ends then even if the page never
   * unsubscribes. Left out, a document may follow any Bot it subscribed to.
   */
  mayFollow?(botId: string): boolean;
}

/** What decides whether a document shows a Bot's chat in front of the person. */
export interface BotChatFrontInput {
  /** The focused window's page, or null when no Aiden window is focused. */
  focusedWebContentsId: number | null;
  /** The page asking. */
  ownerWebContentsId: number;
  visible: boolean;
  minimized: boolean;
  /** `powerMonitor.getSystemIdleState` for the away threshold. */
  idleState: string;
  /** The page is a bubble overlay, which shows only its open mini chat. */
  isBubbleOverlay: boolean;
  /** The bubble whose mini chat is open. */
  openBubbleBotId: string | null;
}

/** Focused, on screen, someone used the Mac recently, and for an overlay, this Bot's mini chat is the open one. */
export function isBotChatInFront(botId: string, input: BotChatFrontInput): boolean {
  if (input.focusedWebContentsId === null || input.focusedWebContentsId !== input.ownerWebContentsId) return false;
  if (!input.visible || input.minimized) return false;
  if (input.isBubbleOverlay && input.openBubbleBotId !== botId) return false;
  return input.idleState === "active";
}

export interface BotLiveHandlers {
  /** Whether a document showing this Bot's chat is in front of the person now. */
  shownInFront(botId: string): boolean;
}

export interface BotLiveHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  /** Throws for a sender that is not the current main frame. */
  owner(event: Event): BotLiveOwner;
  projection(): BotLiveProjection;
  parseBotId(value: unknown): string;
}

const INACTIVE = "The application document changed.";
const REVOKED = "This window no longer shows that Bot.";

export function registerBotLiveHandlers<Event>(dependencies: BotLiveHandlerDependencies<Event>): BotLiveHandlers {
  const { handle } = dependencies;
  /** owner key → botId → unsubscribe. */
  const subscriptions = new Map<string, Map<string, () => void>>();
  /** owner key → the newest owner seen for it, while it holds a subscription. */
  const owners = new Map<string, BotLiveOwner>();
  /**
   * owner key → botId → the newest subscribe request still wanted. An
   * unsubscribe (or a newer subscribe) withdraws it, so a subscribe that
   * finishes afterwards releases itself instead of leaking a live feed.
   */
  const wanted = new Map<string, Map<string, number>>();
  let nextRequest = 0;
  const watched = new Map<string, () => void>();

  const release = (ownerKey: string, botId?: string) => {
    const requests = wanted.get(ownerKey);
    if (requests) {
      if (botId === undefined) requests.clear();
      else requests.delete(botId);
      if (requests.size === 0) wanted.delete(ownerKey);
    }
    const byBot = subscriptions.get(ownerKey);
    if (!byBot) return;
    for (const [id, unsubscribe] of [...byBot]) {
      if (botId !== undefined && id !== botId) continue;
      byBot.delete(id);
      unsubscribe();
    }
    if (byBot.size === 0) {
      subscriptions.delete(ownerKey);
      owners.delete(ownerKey);
    }
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
    const request = (nextRequest += 1);
    let requests = wanted.get(owner.key);
    if (!requests) wanted.set(owner.key, (requests = new Map()));
    requests.set(botId, request);
    if (owner.mayFollow && !owner.mayFollow(botId)) throw new Error(REVOKED);
    let revoked = false;
    let unsubscribeThis: (() => void) | undefined;
    const subscription = await dependencies.projection().subscribe(botId, {
      send: (live) => {
        if (owner.isDestroyed()) throw new Error(INACTIVE);
        if (revoked) return;
        if (owner.mayFollow && !owner.mayFollow(botId)) {
          // Lost this Bot: send nothing more, and end the feed once the projection is done sending.
          revoked = true;
          queueMicrotask(() => {
            if (unsubscribeThis && subscriptions.get(owner.key)?.get(botId) === unsubscribeThis) release(owner.key, botId);
          });
          return;
        }
        owner.send(BOT_LIVE_EVENT_CHANNEL, live);
      },
    });
    unsubscribeThis = subscription.unsubscribe;
    if (owner.isDestroyed()) {
      subscription.unsubscribe();
      throw new Error(INACTIVE);
    }
    if (revoked || (owner.mayFollow && !owner.mayFollow(botId))) {
      subscription.unsubscribe();
      throw new Error(REVOKED);
    }
    if (wanted.get(owner.key)?.get(botId) !== request) {
      // Unsubscribed, or superseded by a newer subscribe, while this one opened.
      subscription.unsubscribe();
      return subscription.snapshot;
    }
    let byBot = subscriptions.get(owner.key);
    if (!byBot) subscriptions.set(owner.key, (byBot = new Map()));
    byBot.get(botId)?.();
    byBot.set(botId, subscription.unsubscribe);
    owners.set(owner.key, owner);
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

  return {
    shownInFront(botId) {
      for (const [key, byBot] of subscriptions) {
        if (!byBot.has(botId)) continue;
        const owner = owners.get(key);
        if (!owner || owner.isDestroyed()) continue;
        try {
          if (owner.inFront?.(botId) === true) return true;
        } catch {
          // A window that can't say is not in front.
        }
      }
      return false;
    },
  };
}
