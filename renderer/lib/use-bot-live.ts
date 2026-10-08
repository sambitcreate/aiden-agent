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

/**
 * A Bot's live conversation. Subscribes to the main projection, applies its
 * `(epoch, seq)` events, and re-subscribes on a gap or an epoch change so the
 * view never drifts from the durable transcript.
 */
export function useBotLive(botId: string | undefined): BotLiveView {
  const [snapshot, setSnapshot] = React.useState<BotLiveSnapshot | null>(null);
  const [generation, setGeneration] = React.useState(0);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setSnapshot(null);
    setFailed(false);
    if (!botId) return;
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
      setSnapshot(next);
      setFailed(false);
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
            setFailed(true);
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
            setFailed(true);
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

    subscribe();
    return () => {
      active = false;
      clearTimeout(retryTimer);
      unsubscribeEvents();
      void botsApi.liveUnsubscribe(botId).catch(() => undefined);
    };
  }, [botId, generation]);

  const reload = React.useCallback(() => setGeneration((value) => value + 1), []);
  return { snapshot, failed, reload };
}
