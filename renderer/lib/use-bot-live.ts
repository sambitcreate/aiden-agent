import * as React from "react";
import { botsApi } from "./ipc";
import {
  applyBotLiveEvent,
  type BotLiveEvent,
  type BotLiveSnapshot,
} from "../shared/bot-live";

const MAX_RESUBSCRIBE_RETRIES = 3;
const RESUBSCRIBE_DELAY_MS = 500;

export interface BotLiveView {
  /** The projection, or null until the first snapshot arrives. */
  snapshot: BotLiveSnapshot | null;
  /** True when the last subscribe failed and no snapshot arrived; `reload` retries. */
  failed: boolean;
  /** Re-subscribes for a fresh snapshot (for example after a connection changed). */
  reload(): void;
}

interface LiveState {
  snapshot: BotLiveSnapshot | null;
  failed: boolean;
}

const EMPTY_STATE: LiveState = { snapshot: null, failed: false };

/**
 * One Bot's live subscription, shared by every consumer in this window. Main
 * keeps a single subscription per window and Bot (a second `bots:live:subscribe`
 * replaces the first), so consumers must not each open their own: the chat and
 * the side panel would take turns freezing each other. The first consumer opens
 * it, the last one out closes it.
 *
 * It subscribes to the main projection, applies its `(epoch, seq)` events, and
 * re-subscribes on a gap or an epoch change so the view never drifts from the
 * durable transcript.
 */
class BotLiveStore {
  private state: LiveState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private stopRun: (() => void) | null = null;

  constructor(
    private readonly botId: string,
    private readonly onIdle: (store: BotLiveStore) => void,
  ) {}

  getState = (): LiveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.stopRun === null) this.start();
    // A subscribe that failed before this consumer arrived must not leave it
    // looking at an error nobody is retrying.
    else if (this.state.failed && this.state.snapshot === null) this.restart();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.stop();
      this.onIdle(this);
    };
  };

  reload = (): void => {
    if (this.stopRun !== null) this.restart();
  };

  private publish(next: LiveState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  private restart(): void {
    this.stop();
    this.publish(EMPTY_STATE);
    this.start();
  }

  private stop(): void {
    const stopRun = this.stopRun;
    this.stopRun = null;
    stopRun?.();
    this.state = EMPTY_STATE;
  }

  private start(): void {
    const { botId } = this;
    let active = true;
    let current: BotLiveSnapshot | null = null;
    let latestRequest = 0;
    let buffered: BotLiveEvent[] = [];
    let shown = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const accept = (next: BotLiveSnapshot) => {
      current = next;
      shown = true;
      retries = 0;
      this.publish({ snapshot: next, failed: false });
    };

    const subscribe = () => {
      const request = ++latestRequest;
      current = null;
      buffered = [];
      botsApi
        .liveSubscribe(botId)
        .then((initial) => {
          if (!active || request !== latestRequest) return;
          let view: BotLiveSnapshot | null = initial;
          for (const event of buffered) {
            if (view === null) break;
            view = applyBotLiveEvent(view, event);
          }
          buffered = [];
          if (view === null) subscribe();
          else accept(view);
        })
        .catch(() => {
          if (!active || request !== latestRequest) return;
          buffered = [];
          if (!shown) {
            // Nothing to show yet: say so, and let the person retry (`reload`).
            this.publish({ snapshot: null, failed: true });
            return;
          }
          // A re-subscribe after a gap failed: keep the last view and try again
          // shortly, a few times, so the chat does not silently freeze.
          if (retries < MAX_RESUBSCRIBE_RETRIES) {
            retries += 1;
            retryTimer = setTimeout(() => {
              if (active && request === latestRequest) subscribe();
            }, RESUBSCRIBE_DELAY_MS * retries);
          } else {
            this.publish({ snapshot: current, failed: true });
          }
        });
    };

    const unsubscribeEvents = botsApi.onLiveEvent((event) => {
      if (!active || event.botId !== botId) return;
      if (event.type === "snapshot") {
        latestRequest += 1;
        accept(event.snapshot);
        return;
      }
      if (current === null) {
        buffered.push(event);
        return;
      }
      const next = applyBotLiveEvent(current, event);
      if (next === null) subscribe();
      else if (next !== current) accept(next);
    });

    this.stopRun = () => {
      active = false;
      clearTimeout(retryTimer);
      unsubscribeEvents();
      void botsApi.liveUnsubscribe(botId).catch(() => undefined);
    };
    subscribe();
  }
}

const stores = new Map<string, BotLiveStore>();

function storeFor(botId: string): BotLiveStore {
  let store = stores.get(botId);
  if (!store) {
    store = new BotLiveStore(botId, (idle) => {
      if (stores.get(botId) === idle) stores.delete(botId);
    });
    stores.set(botId, store);
  }
  return store;
}

const NO_BOT_STORE = {
  getState: () => EMPTY_STATE,
  subscribe: () => () => undefined,
  reload: () => undefined,
};

/**
 * A Bot's live conversation. Every caller for the same Bot shares one
 * subscription; see `BotLiveStore`.
 */
export function useBotLive(botId: string | undefined): BotLiveView {
  const store = botId ? storeFor(botId) : NO_BOT_STORE;
  // Each Bot has its own store, so a switch swaps in the new Bot's state in the
  // same render: the old Bot's conversation is never shown under the new id.
  const state = React.useSyncExternalStore(store.subscribe, store.getState);
  const { snapshot, failed } = state;
  const reload = store.reload;
  return React.useMemo(() => ({ snapshot, failed, reload }), [snapshot, failed, reload]);
}

/**
 * Holds a Bot's live subscription open for everything inside (the chat and the
 * side panel), so a tab or panel closing never decides whether the chat keeps
 * updating.
 */
export function BotLiveProvider({ botId, children }: React.PropsWithChildren<{ botId: string }>) {
  useBotLive(botId);
  return React.createElement(React.Fragment, null, children);
}

/** Reads a Bot's live view; shares the one subscription with every other reader of that Bot. */
export function useSharedBotLive(botId: string | undefined): BotLiveView {
  return useBotLive(botId);
}
