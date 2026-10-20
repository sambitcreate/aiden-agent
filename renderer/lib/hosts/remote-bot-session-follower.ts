// Follows one paired host's Bot conversation: a fresh read of the session,
// then the shared live stream's events in `(epoch, seq)` order. A gap, a new
// epoch or a reconnect's snapshot replaces the view, so it never drifts from
// the host's durable transcript.

import type { PeerBotSessionMessage, PeerBotSessionStreamState, PeerBotSessionSubscription } from "../../shared/peer-bot-session";
import type { PeerOperationOutcome } from "../../shared/peer-host";
import type { AidenRemoteBotSession, AidenRemoteBotSessionEvent } from "../../../main/services/aiden-remote-protocol";
import { applyRemoteBotSessionEvent, remoteBotSessionView, type RemoteBotSessionView } from "./remote-bot-session";

export interface RemoteBotSessionTransport {
  subscribe(hostId: string, botId: string): Promise<PeerBotSessionSubscription>;
  unsubscribe(subscriptionId: string): Promise<unknown>;
  onMessage(handler: (message: PeerBotSessionMessage) => void): () => void;
  /** `GET /bots/{botId}/session` through the host supervisor. */
  read(hostId: string, botId: string): Promise<PeerOperationOutcome>;
}

export interface RemoteBotSessionState {
  view: RemoteBotSessionView | null;
  /** The live stream's connection, for the "Reconnecting" line. */
  stream: PeerBotSessionStreamState;
  /** The last read failed and nothing newer arrived; `reload` retries. */
  failed: string | null;
  /** The host says this Bot is gone, or this Mac may no longer read it. */
  gone: boolean;
}

const INITIAL: RemoteBotSessionState = { view: null, stream: "waiting", failed: null, gone: false };

export class RemoteBotSessionFollower {
  private state: RemoteBotSessionState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private stopped = false;
  private started = false;
  private subscriptionId: string | null = null;
  private offMessages: (() => void) | null = null;
  private reading = 0;
  /** A read is in flight: events wait for it, then apply on top of its answer. */
  private inFlight = false;
  private subscribing = false;
  private buffered: AidenRemoteBotSessionEvent[] = [];

  constructor(
    private readonly transport: RemoteBotSessionTransport,
    readonly hostId: string,
    readonly botId: string,
  ) {}

  getState = (): RemoteBotSessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.offMessages = this.transport.onMessage((message) => this.receive(message));
    this.follow();
    void this.read();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.offMessages?.();
    this.offMessages = null;
    if (this.subscriptionId) void this.transport.unsubscribe(this.subscriptionId).catch(() => undefined);
    this.subscriptionId = null;
    this.listeners.clear();
  }

  /** Reads the session again, keeping the current view until the answer arrives, and rejoins the stream if joining failed. */
  reload = (): void => {
    if (this.stopped) return;
    this.publish({ failed: null });
    if (!this.subscriptionId && !this.subscribing) this.follow();
    void this.read();
  };

  private follow(): void {
    this.subscribing = true;
    this.transport.subscribe(this.hostId, this.botId).then(
      (subscription) => {
        this.subscribing = false;
        if (this.stopped) {
          void this.transport.unsubscribe(subscription.subscriptionId).catch(() => undefined);
          return;
        }
        this.subscriptionId = subscription.subscriptionId;
        this.publish({ stream: subscription.state });
      },
      (error: unknown) => {
        this.subscribing = false;
        if (!this.stopped && this.state.view === null)
          this.publish({ failed: error instanceof Error ? error.message : "This Bot's chat could not be opened." });
      },
    );
  }

  private publish(change: Partial<RemoteBotSessionState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  private async read(): Promise<void> {
    const request = ++this.reading;
    this.inFlight = true;
    this.buffered = [];
    let outcome: PeerOperationOutcome;
    try {
      outcome = await this.transport.read(this.hostId, this.botId);
    } catch (error) {
      outcome = { ok: false, error: { code: "failed", message: error instanceof Error ? error.message : "The request failed." } };
    }
    if (this.stopped || request !== this.reading) return;
    this.inFlight = false;
    const buffered = this.buffered;
    this.buffered = [];
    if (!outcome.ok) {
      const status = outcome.error.status;
      if (status === 404 || status === 403) this.publish({ gone: true });
      else this.publish({ failed: outcome.error.message });
      return;
    }
    let view: RemoteBotSessionView | null = remoteBotSessionView(outcome.value as AidenRemoteBotSession);
    for (const event of buffered) {
      if (view === null) break;
      view = applyRemoteBotSessionEvent(view, event);
    }
    if (view === null) {
      void this.read();
      return;
    }
    this.publish({ view, failed: null, gone: false });
  }

  private receive(message: PeerBotSessionMessage): void {
    if (this.stopped || message.hostId !== this.hostId || message.botId !== this.botId) return;
    if (message.kind === "state") {
      this.publish({ stream: message.state, ...(message.state === "gone" ? { gone: true } : {}) });
      return;
    }
    if (message.kind === "resync") {
      void this.read();
      return;
    }
    const { event } = message;
    if (event.type === "snapshot") {
      // A connection's opening snapshot supersedes any read still in flight.
      this.reading += 1;
      this.inFlight = false;
      this.buffered = [];
      this.publish({ view: remoteBotSessionView(event.payload.session), failed: null, gone: false });
      return;
    }
    if (this.inFlight) {
      this.buffered.push(event);
      return;
    }
    // With no read in flight and nothing shown, the next read replaces everything.
    const current = this.state.view;
    if (current === null) return;
    const next = applyRemoteBotSessionEvent(current, event);
    if (next === null) void this.read();
    else if (next !== current) this.publish({ view: next });
  }
}
