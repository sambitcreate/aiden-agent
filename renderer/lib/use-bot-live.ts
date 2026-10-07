import * as React from "react";
import { botsApi } from "./ipc";
import {
  applyBotLiveEvent,
  type BotLiveEvent,
  type BotLiveSnapshot,
} from "../shared/bot-live";

export interface BotLiveView {
  /** The projection, or null until the first snapshot arrives. */
  snapshot: BotLiveSnapshot | null;
  /** Re-subscribes for a fresh snapshot (for example after a connection changed). */
  reload(): void;
}

/**
 * A Bot's live conversation. Subscribes to the main projection, applies its
 * `(epoch, seq)` events, and re-subscribes on a gap or an epoch change so the
 * view never drifts from the durable transcript.
 */
export function useBotLive(botId: string | undefined): BotLiveView {
  const [snapshot, setSnapshot] = React.useState<BotLiveSnapshot | null>(null);
  const [generation, setGeneration] = React.useState(0);

  React.useEffect(() => {
    setSnapshot(null);
    if (!botId) return;
    let active = true;
    let current: BotLiveSnapshot | null = null;
    let latestRequest = 0;
    let buffered: BotLiveEvent[] = [];

    const accept = (next: BotLiveSnapshot) => {
      current = next;
      setSnapshot(next);
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
          if (active && request === latestRequest) buffered = [];
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

    subscribe();
    return () => {
      active = false;
      unsubscribeEvents();
      void botsApi.liveUnsubscribe(botId).catch(() => undefined);
    };
  }, [botId, generation]);

  const reload = React.useCallback(() => setGeneration((value) => value + 1), []);
  return { snapshot, reload };
}
