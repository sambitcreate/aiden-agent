// A paired host's Bot conversation, followed from this Mac. Main keeps one
// `/bots/{botId}/session/events` stream per host and Bot, shared by every
// window, and forwards its frames on `remote:peer-bot-session`.

import type { AidenRemoteBotSessionEvent } from "../../main/services/aiden-remote-protocol.js";

/**
 * `waiting`: the host is not connected yet, or the stream is reconnecting.
 * `streaming`: frames are arriving. `gone`: the host refused the stream (the
 * Bot was deleted, or this Mac may no longer read it); nothing retries it.
 */
export type PeerBotSessionStreamState = "waiting" | "streaming" | "gone";

export interface PeerBotSessionSubscription {
  subscriptionId: string;
  state: PeerBotSessionStreamState;
}

export type PeerBotSessionMessage =
  | { kind: "event"; hostId: string; botId: string; event: AidenRemoteBotSessionEvent }
  | { kind: "state"; hostId: string; botId: string; state: PeerBotSessionStreamState }
  /** The host sent something newer than this Mac reads; read the session again. */
  | { kind: "resync"; hostId: string; botId: string };
