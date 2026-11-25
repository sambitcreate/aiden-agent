// Follows one paired host's Bot conversation: a fresh read of the session,
// then the shared live stream's events in `(epoch, seq)` order. A gap, a new
// epoch or a reconnect's snapshot replaces the view, so it never drifts from
// the host's durable transcript.

import type { PeerBotSessionMessage, PeerBotSessionStreamState, PeerBotSessionSubscription } from "../../shared/peer-bot-session";
import type { PeerOperationOutcome } from "../../shared/peer-host";
import type { AidenRemoteBotSession, AidenRemoteBotSessionEvent } from "../../../main/services/aiden-remote-protocol";
import {
  applyRemoteBotSessionEvent,
  carryOlderRemoteBotEntries,
  remoteBotSessionView,
  withOlderRemoteBotEntries,
  withRereadOlderRemoteBotEntries,
  type RemoteBotSessionEntriesPage,
  type RemoteBotSessionView,
} from "./remote-bot-session";

/** The host's largest page (`limit`, revision 67). */
const OLDER_PAGE_MAX = 200;
/** At most this many kept entries a re-read didn't reach are asked about. */
const KEPT_PROBE_MAX = 8;

export interface RemoteBotSessionTransport {
  subscribe(hostId: string, botId: string): Promise<PeerBotSessionSubscription>;
  unsubscribe(subscriptionId: string): Promise<unknown>;
  onMessage(handler: (message: PeerBotSessionMessage) => void): () => void;
  /** `GET /bots/{botId}/session` through the host supervisor. */
  read(hostId: string, botId: string): Promise<PeerOperationOutcome>;
  /** Contract revision 67: `GET /bots/{botId}/session/entries?before=&limit=` through the host supervisor. */
  older?(hostId: string, botId: string, before: string, limit?: number): Promise<PeerOperationOutcome>;
}

/**
 * What Load older came to: `loaded` (or nothing left to load), `unsupported`
 * when the host is older than revision 67, `failed` with the host's reason.
 * A page the session moved past reads the session again and reports `loaded`.
 */
export type RemoteBotOlderOutcome = { kind: "loaded" } | { kind: "unsupported" } | { kind: "failed"; message: string };

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
  private resyncPending = false;
  private buffered: AidenRemoteBotSessionEvent[] = [];
  private loadingOlder: Promise<RemoteBotOlderOutcome> | null = null;
  /**
   * Bumped whenever the shown history is replaced (a snapshot, or older
   * entries read again). A page asked for before that belongs to history this
   * Mac no longer shows, so it is never placed.
   */
  private history = 0;

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

  /** Contract revision 67: place the page of entries just older than the oldest one shown. One at a time. */
  loadOlder = (): Promise<RemoteBotOlderOutcome> => {
    if (this.loadingOlder) return this.loadingOlder;
    const view = this.state.view;
    if (this.stopped || !view || !view.hasOlder || !view.olderCursor || !this.transport.older)
      return Promise.resolve({ kind: this.transport.older ? "loaded" : "unsupported" });
    const { epoch } = view.snapshot;
    const history = this.history;
    const request = this.transport.older(this.hostId, this.botId, view.olderCursor).then(
      (outcome): RemoteBotOlderOutcome => {
        if (this.stopped) return { kind: "loaded" };
        if (!outcome.ok) {
          // Older hosts have no such route.
          if (outcome.error.status === 404) return { kind: "unsupported" };
          // The session moved on (a new epoch, a rewrite): read it again.
          if (outcome.error.status === 409) {
            this.reload();
            return { kind: "loaded" };
          }
          return { kind: "failed", message: outcome.error.message };
        }
        // The history changed while the page was out; the button reads the new history.
        if (history !== this.history) return { kind: "loaded" };
        const current = this.state.view;
        const page = outcome.value as RemoteBotSessionEntriesPage;
        if (!current || current.snapshot.epoch !== epoch || page.epoch !== epoch) {
          this.reload();
          return { kind: "loaded" };
        }
        this.publish({ view: withOlderRemoteBotEntries(current, page) });
        return { kind: "loaded" };
      },
      (error: unknown): RemoteBotOlderOutcome => ({
        kind: "failed",
        message: error instanceof Error ? error.message : "The request failed.",
      }),
    );
    this.loadingOlder = request.finally(() => {
      this.loadingOlder = null;
    });
    return this.loadingOlder;
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
    // Content this Mac could not read arrived while this read was out: it may
    // be newer than the answer, so read once more after taking this one.
    if (this.resyncPending) {
      this.resyncPending = false;
      queueMicrotask(() => {
        if (!this.stopped && !this.inFlight) void this.read();
      });
    }
    const buffered = this.buffered;
    this.buffered = [];
    if (!outcome.ok) {
      const status = outcome.error.status;
      if (status === 404 || status === 403) this.publish({ gone: true });
      else this.publish({ failed: outcome.error.message });
      return;
    }
    const fresh = remoteBotSessionView(outcome.value as AidenRemoteBotSession);
    let view: RemoteBotSessionView | null = carryOlderRemoteBotEntries(this.state.view, fresh);
    const carried = view.snapshot.entries.length - fresh.snapshot.entries.length;
    for (const event of buffered) {
      if (view === null) break;
      view = applyRemoteBotSessionEvent(view, event);
    }
    if (view === null) {
      void this.read();
      return;
    }
    this.history += 1;
    this.publish({ view, failed: null, gone: false });
    this.rereadCarried(carried, fresh);
  }

  /**
   * The host may have rewritten history inside the same epoch (a snapshot
   * also says so), so older entries kept across a snapshot are read again, a
   * bounded page at a time, and replaced. Reading goes back to the oldest kept
   * entry within the host entries the kept ones spanned, plus a slack (a newer
   * host's entries this Mac can't show may sit between them). Then any kept
   * entry still not read (one the host removed, or moved further back) is
   * asked about, at most `KEPT_PROBE_MAX` in all: reading goes on to each one
   * the host still has. The re-read is cut back to whichever kept entry comes
   * first, so nothing older than before is added and no kept entry the host
   * has is dropped. If the questions run out with kept entries still not
   * accounted for, the loaded part is dropped instead. A read that fails keeps the pages already read (Load older
   * continues from there), or drops the kept entries if none was.
   */
  private rereadCarried(carried: number, fresh: RemoteBotSessionView): void {
    const view = this.state.view;
    if (carried <= 0 || !view) return;
    const own = view.snapshot.entries[carried]?.id;
    const kept = view.snapshot.entries.slice(0, carried).map((entry) => entry.id);
    // The host entries the kept part spans, as far as this Mac can count them
    // (a snapshot's own entries are counted as shown), and a slack of the kept
    // count for entries it couldn't see.
    const span = Math.max(view.olderHostSpan ?? 0, carried);
    const bound = span + carried;
    const history = this.history;
    const current = () => !this.stopped && history === this.history && this.state.view !== null;
    const settle = (pages: RemoteBotSessionEntriesPage[]) => {
      const latest = this.state.view;
      if (!current() || !latest) return;
      this.history += 1;
      this.publish({ view: withRereadOlderRemoteBotEntries(latest, carried, fresh, pages) });
    };
    const { transport } = this;
    if (!own || !transport.older) {
      settle([]);
      return;
    }
    const pages: RemoteBotSessionEntriesPage[] = [];
    // Entries read back, the snapshot's own included (a kept entry may have moved into it).
    const seen = new Set(fresh.snapshot.entries.map((entry) => entry.id));
    const gone = new Set<string>();
    let probes = 0;
    // The kept entry being read back to; while bounded, the oldest.
    let target = kept[0]!;
    let bounded = true;
    const next = (before: string, total: number): void => {
      if (!transport.older) return settle(pages);
      const want = !bounded ? OLDER_PAGE_MAX : total < span ? span - total : bound - total;
      transport.older(this.hostId, this.botId, before, Math.min(Math.max(want, 1), OLDER_PAGE_MAX)).then(
        (outcome) => {
          if (!current()) return;
          if (!outcome.ok) return settle(pages);
          const page = outcome.value as RemoteBotSessionEntriesPage;
          pages.push(page);
          for (const entry of page.entries) seen.add(entry.id);
          // Counted in the host's entries, drawn or not, as the kept span was.
          const after = total + (page.hostCount ?? page.entries.length);
          const cursor = page.olderCursor ?? page.entries[0]?.id;
          if (!page.hasOlder || !cursor || cursor === before) return settle(pages);
          if (seen.has(target) || (bounded && after >= bound)) return ask(cursor, after);
          next(cursor, after);
        },
        () => settle(pages),
      );
    };
    // Asks for one entry before the next kept entry not yet read: the host
    // answers `operation_stale` when it no longer has it.
    const ask = (cursor: string, total: number): void => {
      const id = kept.find((candidate) => !seen.has(candidate) && !gone.has(candidate));
      if (id === undefined || !transport.older) return settle(pages);
      // Out of questions with kept entries still unaccounted for: the loaded
      // part is dropped rather than guessed at, and Load older starts again.
      if (probes >= KEPT_PROBE_MAX) return settle([]);
      probes += 1;
      transport.older(this.hostId, this.botId, id, 1).then(
        (outcome) => {
          if (!current()) return;
          if (outcome.ok) {
            target = id;
            bounded = false;
            return next(cursor, total);
          }
          if (outcome.error.remoteCode !== "operation_stale") return settle(pages);
          gone.add(id);
          ask(cursor, total);
        },
        () => settle(pages),
      );
    };
    next(own, 0);
  }

  private receive(message: PeerBotSessionMessage): void {
    if (this.stopped || message.hostId !== this.hostId || message.botId !== this.botId) return;
    if (message.kind === "state") {
      // A gone stream has ended on the main side; Try again must join a new one.
      if (message.state === "gone") this.subscriptionId = null;
      this.publish({ stream: message.state, ...(message.state === "gone" ? { gone: true } : {}) });
      return;
    }
    if (message.kind === "resync") {
      // One read at a time: a burst of unreadable frames becomes one follow-up read.
      if (this.inFlight) this.resyncPending = true;
      else void this.read();
      return;
    }
    const { event } = message;
    if (event.type === "snapshot") {
      // A connection's opening snapshot supersedes any read still in flight.
      this.reading += 1;
      this.inFlight = false;
      this.resyncPending = false;
      this.buffered = [];
      const fresh = remoteBotSessionView(event.payload.session);
      const view = carryOlderRemoteBotEntries(this.state.view, fresh);
      this.history += 1;
      this.publish({ view, failed: null, gone: false });
      this.rereadCarried(view.snapshot.entries.length - fresh.snapshot.entries.length, fresh);
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
