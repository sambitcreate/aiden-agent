import { randomUUID } from "node:crypto";
import { hostIdentifier } from "../../renderer/shared/peer-host.js";
import type {
  PeerBotSessionMessage,
  PeerBotSessionStreamState,
  PeerBotSessionSubscription,
} from "../../renderer/shared/peer-bot-session.js";
import { parseAidenRemoteBotSessionEvent, parseAidenRemoteJson } from "./aiden-remote-protocol.js";
import type { PeerRequestPartition } from "./peer-host-registry.js";
import type { PeerRunTimers } from "./peer-run-subscriptions.js";
import { parsePeerSseFrame } from "./peer-sse.js";
import { PeerTransportError, type PeerRequest, type PeerStreamEnd } from "./peer-transport.js";

export const PEER_BOT_SESSION_CHANNEL = "remote:peer-bot-session";

/** The connected generation of one host, as the supervisor sees it. */
export interface PeerBotSessionConnection {
  /** Aborted when this connection ends. */
  readonly signal: AbortSignal;
  /** False once the host reconnected or went away after this was read. */
  current(): boolean;
  /**
   * Reports a failure. Returns true when no retry can fix it (re-pairing,
   * protocol), which blocks the host; the stream then waits for a reconnect.
   */
  fail(error: unknown): boolean;
}

export interface PeerBotSessionStreamsOptions {
  /** The host's connection while it is connected and shares Bot sessions; otherwise undefined. */
  connection(hostId: string): PeerBotSessionConnection | undefined;
  request(
    hostId: string,
    input: Omit<PeerRequest, "credential">,
    onFrame: (frame: string) => void,
    options: { partition: PeerRequestPartition },
  ): Promise<unknown>;
  broadcast(channel: string, payload: PeerBotSessionMessage): void;
  backoff(failures: number): number;
  timers: PeerRunTimers;
}

interface Stream {
  readonly key: string;
  readonly hostId: string;
  readonly botId: string;
  readonly holders: Set<string>;
  state: PeerBotSessionStreamState;
  stopped: boolean;
  controller?: AbortController;
  waiter?: () => void;
}

/** Bounds what one window can hold open. */
const MAX_SUBSCRIPTIONS_PER_OWNER = 32;

function refused(error: unknown, status?: number): boolean {
  return (
    error instanceof PeerTransportError &&
    error.code === "request_failed" &&
    error.status !== undefined &&
    (status === undefined ? error.status >= 400 && error.status < 500 : error.status === status)
  );
}

/**
 * Live Bot conversations on paired hosts. One stream per host and Bot is
 * shared by every window that follows it, and closes with its last holder.
 * The host opens every connection with a full snapshot, so a reconnect needs
 * no cursor: the renderer replaces its view with that snapshot.
 */
export class PeerBotSessionStreams {
  private readonly streams = new Map<string, Stream>();
  private readonly subscriptions = new Map<string, { owner: string; key: string }>();
  private closed = false;

  constructor(private readonly options: PeerBotSessionStreamsOptions) {}

  subscribe(hostId: unknown, botId: unknown, owner: string): PeerBotSessionSubscription {
    if (this.closed) throw new Error("Device connections are closed.");
    const host = hostIdentifier(hostId);
    const bot = hostIdentifier(botId);
    let held = 0;
    for (const entry of this.subscriptions.values()) if (entry.owner === owner) held += 1;
    if (held >= MAX_SUBSCRIPTIONS_PER_OWNER) throw new Error("Too many Bot chats are open.");
    const key = `${host}\u0000${bot}`;
    let stream = this.streams.get(key);
    const created = !stream;
    if (!stream) {
      stream = { key, hostId: host, botId: bot, holders: new Set(), state: "waiting", stopped: false };
      this.streams.set(key, stream);
    }
    const subscriptionId = `bot_${randomUUID()}`;
    stream.holders.add(subscriptionId);
    this.subscriptions.set(subscriptionId, { owner, key });
    if (created) void this.run(stream);
    return { subscriptionId, state: stream.state };
  }

  unsubscribe(subscriptionId: unknown, owner: string): boolean {
    if (typeof subscriptionId !== "string" || subscriptionId.length > 64) return false;
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry || entry.owner !== owner) return false;
    this.subscriptions.delete(subscriptionId);
    const stream = this.streams.get(entry.key);
    if (!stream) return true;
    stream.holders.delete(subscriptionId);
    if (stream.holders.size === 0) this.stop(stream);
    return true;
  }

  releaseOwner(owner: string): void {
    for (const [subscriptionId, entry] of [...this.subscriptions])
      if (entry.owner === owner) this.unsubscribe(subscriptionId, owner);
  }

  /** The host connected, reconnected or failed: streams waiting on it look again. */
  wakeHost(hostId: string): void {
    for (const stream of this.streams.values()) if (stream.hostId === hostId) stream.waiter?.();
  }

  /** The host was disabled or removed: its streams end for good. */
  dropHost(hostId: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.hostId !== hostId) continue;
      this.setState(stream, "gone");
      this.forget(stream);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of [...this.streams.values()]) this.forget(stream);
  }

  private forget(stream: Stream): void {
    for (const subscriptionId of stream.holders) this.subscriptions.delete(subscriptionId);
    stream.holders.clear();
    this.stop(stream);
  }

  private stop(stream: Stream): void {
    stream.stopped = true;
    if (this.streams.get(stream.key) === stream) this.streams.delete(stream.key);
    stream.controller?.abort();
    stream.waiter?.();
  }

  private setState(stream: Stream, state: PeerBotSessionStreamState): void {
    if (stream.state === state) return;
    stream.state = state;
    this.options.broadcast(PEER_BOT_SESSION_CHANNEL, {
      kind: "state",
      hostId: stream.hostId,
      botId: stream.botId,
      state,
    });
  }

  private wait(stream: Stream, ms?: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: unknown;
      const done = () => {
        if (stream.waiter === done) stream.waiter = undefined;
        if (timer !== undefined) this.options.timers.clear(timer);
        resolve();
      };
      stream.waiter = done;
      if (ms !== undefined) timer = this.options.timers.set(done, ms);
    });
  }

  private async run(stream: Stream): Promise<void> {
    const alive = () => !this.closed && !stream.stopped;
    let failures = 0;
    while (alive()) {
      const connection = this.options.connection(stream.hostId);
      if (!connection) {
        this.setState(stream, "waiting");
        await this.wait(stream);
        continue;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (connection.signal.aborted) abort();
      else connection.signal.addEventListener("abort", abort, { once: true });
      stream.controller = controller;
      let failure: unknown;
      try {
        const end = (await this.options.request(
          stream.hostId,
          {
            path: `/bots/${encodeURIComponent(stream.botId)}/session/events`,
            signal: controller.signal,
            onOpen: () => {
              if (alive() && connection.current()) this.setState(stream, "streaming");
            },
          },
          (frame) => {
            if (failure !== undefined || !alive() || !connection.current()) return;
            try {
              const event = parseAidenRemoteBotSessionEvent(
                parseAidenRemoteJson(parsePeerSseFrame(frame).data, "Bot session event"),
              );
              if (event.botId !== stream.botId) throw new PeerTransportError("invalid_response");
              // Every connection opens with a snapshot; only later frames prove it stays up.
              if (event.type !== "snapshot") failures = 0;
              this.options.broadcast(PEER_BOT_SESSION_CHANNEL, {
                kind: "event",
                hostId: stream.hostId,
                botId: stream.botId,
                event,
              });
            } catch (error) {
              failure = error instanceof PeerTransportError ? error : new PeerTransportError("invalid_response");
              controller.abort();
            }
          },
          { partition: "stream" },
        )) as PeerStreamEnd;
        if (failure !== undefined) throw failure;
        if (end.reason === "capped") continue;
        // The host ended the stream: the session closed (a reset or a reopen)
        // or the connection dropped. A new connection starts from a snapshot.
        this.setState(stream, "waiting");
        failures += 1;
        await this.wait(stream, this.options.backoff(failures));
      } catch (error) {
        const cause = failure ?? error;
        if (!alive()) return;
        if (!connection.current()) continue;
        if (connection.fail(cause)) continue;
        if (refused(cause, 409)) {
          // The session was closing while this attached: try again shortly.
          this.setState(stream, "waiting");
          failures += 1;
          await this.wait(stream, this.options.backoff(failures));
          continue;
        }
        if (refused(cause)) {
          // Deleted, or this Mac may no longer read it.
          this.setState(stream, "gone");
          this.forget(stream);
          return;
        }
        this.setState(stream, "waiting");
        failures += 1;
        await this.wait(stream, this.options.backoff(failures));
      } finally {
        connection.signal.removeEventListener("abort", abort);
        if (stream.controller === controller) stream.controller = undefined;
      }
    }
  }
}
