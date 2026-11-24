import * as React from "react";
import { peerHostsApi } from "../ipc";
import {
  RemoteBotSessionFollower,
  type RemoteBotOlderOutcome,
  type RemoteBotSessionState,
  type RemoteBotSessionTransport,
} from "./remote-bot-session-follower";

const transport: RemoteBotSessionTransport = {
  subscribe: (hostId, botId) => peerHostsApi.botSessionSubscribe(hostId, botId),
  unsubscribe: (subscriptionId) => peerHostsApi.botSessionUnsubscribe(subscriptionId),
  onMessage: (handler) => peerHostsApi.onBotSession(handler),
  read: (hostId, botId) => peerHostsApi.call(hostId, { operation: "botSession", resourceId: botId }),
  older: (hostId, botId, before, limit) =>
    peerHostsApi.call(hostId, { operation: "botSessionEntries", resourceId: botId, before, ...(limit === undefined ? {} : { limit }) }),
};

const IDLE: RemoteBotSessionState = { view: null, stream: "waiting", failed: null, gone: false };

/** A paired host's Bot conversation, live, for as long as the caller is mounted and `enabled`. */
export function useRemoteBotSession(
  hostId: string,
  botId: string,
  enabled = true,
): RemoteBotSessionState & { reload(): void; loadOlder(): Promise<RemoteBotOlderOutcome> } {
  const [follower, setFollower] = React.useState<RemoteBotSessionFollower | null>(null);
  React.useEffect(() => {
    if (!enabled) {
      setFollower(null);
      return;
    }
    const next = new RemoteBotSessionFollower(transport, hostId, botId);
    setFollower(next);
    next.start();
    return () => next.stop();
  }, [hostId, botId, enabled]);
  const current = follower && follower.hostId === hostId && follower.botId === botId ? follower : null;
  const state = React.useSyncExternalStore(
    current?.subscribe ?? noSubscribe,
    current?.getState ?? idleState,
  );
  const reload = React.useCallback(() => current?.reload(), [current]);
  const loadOlder = React.useCallback(
    (): Promise<RemoteBotOlderOutcome> => current?.loadOlder() ?? Promise.resolve({ kind: "loaded" }),
    [current],
  );
  return React.useMemo(() => ({ ...state, reload, loadOlder }), [state, reload, loadOlder]);
}

const noSubscribe = () => () => undefined;
const idleState = () => IDLE;
