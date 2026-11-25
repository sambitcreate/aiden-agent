// Renderer client for Bot bubbles. Uses only the small IPC bridge, so the
// bubble overlay window can load it without the full `ipc.ts` graph.

import * as React from "react";
import { invoke, onNotification } from "./ipc-bridge";
import {
  BOT_BUBBLE_CHANNELS,
  EMPTY_BOT_BUBBLE_STATE,
  parseBotBubbleState,
  type BotBubbleOverlayInfo,
  type BotBubblePlacement,
  type BotBubbleRect,
  type BotBubbleRequest,
  type BotBubbleState,
  type BotBubbleOpenRequest,
  type BotBubbleTransition,
} from "../shared/bot-bubbles";

const parsed = async (promise: Promise<unknown>): Promise<BotBubbleState> => parseBotBubbleState(await promise);

export const botBubblesApi = {
  state: () => parsed(invoke(BOT_BUBBLE_CHANNELS.state)),
  bubble: (request: BotBubbleRequest) => parsed(invoke(BOT_BUBBLE_CHANNELS.bubble, request)),
  close: (botId: string) => parsed(invoke(BOT_BUBBLE_CHANNELS.close, { botId })),
  /** `ifOpen`: change nothing unless that head's chat is the open one. */
  open: (botId: string | null, options: { ifOpen?: string } = {}) =>
    parsed(
      invoke(
        BOT_BUBBLE_CHANNELS.open,
        (options.ifOpen === undefined ? { botId } : { botId, ifOpen: options.ifOpen }) satisfies BotBubbleOpenRequest,
      ),
    ),
  move: (botId: string, placement: BotBubblePlacement) => parsed(invoke(BOT_BUBBLE_CHANNELS.move, { botId, placement })),
  bringBack: (botId: string, sourceRect?: BotBubbleRect) =>
    parsed(invoke(BOT_BUBBLE_CHANNELS.bringBack, sourceRect ? { botId, sourceRect } : { botId })),
  forgetRecent: (botId: string) => parsed(invoke(BOT_BUBBLE_CHANNELS.forgetRecent, { botId })),
  /** Overlay only: stop or start passing clicks through to the apps below. */
  setInteractive: (interactive: boolean) => invoke<void>(BOT_BUBBLE_CHANNELS.setInteractive, { interactive }),
  /** Overlay only: a head is being dragged. */
  setDragging: (dragging: boolean) => invoke<void>(BOT_BUBBLE_CHANNELS.setDragging, { dragging }),
  /** Overlay only: which display this overlay covers and its size. */
  overlayInfo: () => invoke<BotBubbleOverlayInfo>(BOT_BUBBLE_CHANNELS.overlayInfo),
  /** Overlay only: a shrink's still picture is on screen (see `BotBubbleTransition.cover`). */
  transitionShown: (cover: number) => invoke<void>(BOT_BUBBLE_CHANNELS.transitionShown, { cover }),
  onChanged: (handler: (state: BotBubbleState) => void) =>
    onNotification<unknown>(BOT_BUBBLE_CHANNELS.changed, (payload) => handler(parseBotBubbleState(payload))),
  /** Overlay only: the overlay's display changed size or zoom. */
  onOverlayInfoChanged: (handler: (info: BotBubbleOverlayInfo) => void) =>
    onNotification<BotBubbleOverlayInfo>(BOT_BUBBLE_CHANNELS.overlayInfoChanged, handler),
  onTransition: (handler: (transition: BotBubbleTransition) => void) =>
    onNotification<BotBubbleTransition>(BOT_BUBBLE_CHANNELS.transition, handler),
  onShowChat: (handler: (botId: string) => void) =>
    onNotification<{ botId?: unknown }>(BOT_BUBBLE_CHANNELS.showChat, (payload) => {
      if (typeof payload?.botId === "string") handler(payload.botId);
    }),
};

type Listener = () => void;

/** One shared copy of main's bubble state per window, fed by `bots:bubbles:changed`. */
function createBotBubbleStore() {
  let state: BotBubbleState = EMPTY_BOT_BUBBLE_STATE;
  let loaded = false;
  let stopNotifications: (() => void) | null = null;
  let version = 0;
  const listeners = new Set<Listener>();
  const set = (next: BotBubbleState) => {
    state = next;
    loaded = true;
    for (const listener of [...listeners]) listener();
  };
  const start = () => {
    if (stopNotifications) return;
    stopNotifications = botBubblesApi.onChanged((next) => {
      version += 1;
      set(next);
    });
    const asked = version;
    void botBubblesApi
      .state()
      .then((next) => {
        // A change notification that arrived first is newer than this read.
        if (version === asked) set(next);
      })
      .catch(() => {
        // Unknown counts as read (nothing bubbled), so a window waiting on it never waits forever.
        if (!loaded) set(state);
      });
  };
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stopNotifications) {
          stopNotifications();
          stopNotifications = null;
          // Without notifications the copy goes stale; the next subscriber waits for a fresh read.
          loaded = false;
          version += 1;
        }
      };
    },
    getState: () => state,
    isLoaded: () => loaded,
    /** Apply a state a mutation returned, without waiting for its notification. */
    accept(next: BotBubbleState) {
      version += 1;
      set(next);
    },
  };
}

export const botBubbleStore = createBotBubbleStore();

/** Main's bubble list, open head and settings, kept current in this window. */
export function useBotBubbles(): BotBubbleState {
  return React.useSyncExternalStore(botBubbleStore.subscribe, botBubbleStore.getState, () => EMPTY_BOT_BUBBLE_STATE);
}

/** Whether this window has heard main's bubble state at least once (or failed to). */
export function useBotBubblesLoaded(): boolean {
  return React.useSyncExternalStore(botBubbleStore.subscribe, botBubbleStore.isLoaded, () => false);
}

/** Run a bubble mutation and apply its returned state at once. */
export async function applyBotBubbleChange(change: Promise<BotBubbleState>): Promise<BotBubbleState> {
  const next = await change;
  botBubbleStore.accept(next);
  return next;
}
