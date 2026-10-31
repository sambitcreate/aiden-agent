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
  /**
   * True while `snapshot` is the view this window last had of the Bot, shown
   * at once while the fresh subscription answers. Events are not applied to it.
   */
  stale: boolean;
  /** Re-subscribes for a fresh snapshot (for example after a connection changed). */
  reload(): void;
}

interface LiveState {
  snapshot: BotLiveSnapshot | null;
  failed: boolean;
  stale: boolean;
}

const EMPTY_STATE: LiveState = { snapshot: null, failed: false, stale: false };

/** How many Bots' last views this window remembers for an instant reopen. */
const REMEMBERED_VIEWS = 8;

/**
 * The last fresh snapshot per Bot, kept after its store closes so coming back
 * to a Bot shows its conversation on the first frame instead of a skeleton.
 * Bounded, newest last; a Bot that is forgotten is dropped.
 */
const rememberedViews = new Map<string, BotLiveSnapshot>();

function rememberView(snapshot: BotLiveSnapshot): void {
  rememberedViews.delete(snapshot.botId);
  rememberedViews.set(snapshot.botId, snapshot);
  while (rememberedViews.size > REMEMBERED_VIEWS) {
    const oldest = rememberedViews.keys().next().value;
    if (oldest === undefined) break;
    rememberedViews.delete(oldest);
  }
}

/** Forgets a Bot's remembered view (for example once it is deleted). */
export function forgetBotLiveView(botId: string): void {
  rememberedViews.delete(botId);
}

/** Test seam: clears every remembered view. */
export function resetBotLiveViewsForTests(): void {
  rememberedViews.clear();
}

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
    private readonly adopt: (store: BotLiveStore) => void,
    private readonly release: (store: BotLiveStore) => void,
  ) {
    // Reopening a Bot starts from its remembered view, so the first render shows
    // the conversation, not a skeleton, while the fresh snapshot is read.
    this.state = this.remembered();
  }

  getState = (): LiveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    // A same-commit remount tears a store down before any new consumer
    // subscribes; make sure the next `storeFor` finds this one, not a second.
    this.adopt(this);
    if (this.stopRun === null) this.start();
    // A subscribe that failed before this consumer arrived must not leave it
    // looking at an error nobody is retrying. This runs only when a consumer
    // joins or `reload` is called, never in a loop.
    else if (this.state.failed) this.restart(true);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      // React runs every cleanup of a commit before any subscribe, so a
      // remount in the same commit must find this store, and main's
      // subscription, still open. Settle after the commit.
      queueMicrotask(() => {
        if (this.listeners.size > 0 || this.stopRun === null) return;
        this.stop();
        this.release(this);
      });
    };
  };

  /**
   * Restarts the subscription for every consumer of this Bot, not only the
   * caller. The view on screen stays, marked stale, until the fresh snapshot
   * lands: a reload after a connection changed must not blank the chat.
   */
  reload = (): void => {
    if (this.stopRun !== null) this.restart(true, false);
  };

  private publish(next: LiveState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * `reload` starts over from nothing. A consumer joining a failed store keeps
   * the last view on screen, still flagged as failed, until the new snapshot
   * arrives; a retry that fails too leaves that view in place.
   */
  private restart(keepView = false, flagFailed = true): void {
    const kept = keepView ? this.state.snapshot : null;
    this.stop();
    this.publish(kept ? { snapshot: kept, failed: flagFailed, stale: true } : this.remembered());
    this.start(kept);
  }

  /** The starting state: the Bot's remembered view, stale, or nothing. */
  private remembered(): LiveState {
    const view = rememberedViews.get(this.botId);
    return view ? { snapshot: view, failed: false, stale: true } : EMPTY_STATE;
  }

  private stop(): void {
    const stopRun = this.stopRun;
    this.stopRun = null;
    stopRun?.();
    this.state = EMPTY_STATE;
  }

  private start(kept: BotLiveSnapshot | null = null): void {
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
      rememberView(next);
      this.publish({ snapshot: next, failed: false, stale: false });
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
            // Nothing new to show: say so, keeping any view a join retry kept
            // (or the remembered one), and let the person retry (`reload`).
            this.publish({ snapshot: kept ?? this.state.snapshot, failed: true, stale: true });
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
            this.publish({ snapshot: this.state.snapshot, failed: true, stale: true });
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
    store = new BotLiveStore(
      botId,
      (live) => {
        if (!stores.has(botId)) stores.set(botId, live);
      },
      (idle) => {
        if (stores.get(botId) === idle) stores.delete(botId);
      },
    );
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
  const { snapshot, failed, stale } = state;
  const reload = store.reload;
  return React.useMemo(() => ({ snapshot, failed, stale, reload }), [snapshot, failed, stale, reload]);
}
