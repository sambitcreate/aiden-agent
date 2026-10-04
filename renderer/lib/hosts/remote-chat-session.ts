import type { HostChatAdapter, HostChatError, HostChatStatus } from "./host-chat-adapter";
import {
  emptyRemoteTranscript,
  mergeNewestWindow,
  mergeOlderWindow,
  type RemoteTranscript,
} from "./remote-chat-mapper";
import {
  applyRemoteRunEvent,
  applyRemoteRunStreamState,
  applyRemoteRunSubscription,
  handOffRemoteRun,
  initialRemoteRunView,
  type RemoteRunStep,
  type RemoteRunView,
} from "./remote-stream-translator";

/**
 * One open remote chat: its paged transcript, the live run translated from
 * the host's stream, and the host's availability. Framework-free; the view
 * reads it through `useSyncExternalStore`.
 *
 * Window reads and stream events go through one queue, so a refetch asked
 * for by an event completes before the next event applies.
 */

export interface RemoteChatSnapshot {
  hostId: string;
  chatId: string;
  status: HostChatStatus;
  transcript: RemoteTranscript;
  /** A window was applied (or seeded from the last-known cache). */
  loaded: boolean;
  /** The newest window is being read. */
  loading: boolean;
  loadingOlder: boolean;
  /** The host is not connected: the transcript is last-known and read-only. */
  stale: boolean;
  /** The last read failure, for display; cleared by the next successful read. */
  error: string | null;
  run: RemoteRunView;
}

/** Where the last-known transcript survives the view (the host query cache). */
export interface RemoteTranscriptCache {
  read(): RemoteTranscript | undefined;
  write(transcript: RemoteTranscript): void;
}

export interface RemoteChatSessionOptions {
  adapter: HostChatAdapter;
  chatId: string;
  cache?: RemoteTranscriptCache;
}

function isRevisionConflict(error: HostChatError): boolean {
  return error.remoteCode === "revision_conflict" || error.status === 409;
}

export class RemoteChatSession {
  private readonly adapter: HostChatAdapter;
  private readonly chatId: string;
  private readonly cache: RemoteTranscriptCache | undefined;
  private snapshot: RemoteChatSnapshot;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private started = false;
  private lastMarked: string | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor({ adapter, chatId, cache }: RemoteChatSessionOptions) {
    this.adapter = adapter;
    this.chatId = chatId;
    this.cache = cache;
    const cached = cache?.read();
    const status = adapter.status();
    this.snapshot = {
      hostId: adapter.hostId,
      chatId,
      status,
      transcript: cached && cached.chatId === chatId ? cached : emptyRemoteTranscript(chatId),
      loaded: Boolean(cached && cached.chatId === chatId),
      loading: false,
      loadingOlder: false,
      stale: status.availability !== "online",
      error: null,
      run: initialRemoteRunView(null, chatId),
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): RemoteChatSnapshot => this.snapshot;

  /** Loads the newest window, then follows the chat's run stream. Idempotent. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.cleanups.push(this.adapter.onStatus((status) => this.acceptStatus(status)));
    this.cleanups.push(
      this.adapter.onChatChanged((chatId) => {
        // Reread rather than adopt a revision: the window's revision must match the messages shown.
        if (chatId === this.chatId) this.enqueue(() => this.refreshNewest());
      }),
    );
    this.enqueue(async () => {
      await this.adapter.ready();
      if (this.disposed) return;
      const status = this.adapter.status();
      this.update({ status, stale: status.availability !== "online" });
      await this.refreshNewest();
    });
    if (this.adapter.capabilities().has("observe")) {
      this.cleanups.push(
        this.adapter.observe(this.chatId, {
          onSubscription: (subscription) =>
            this.enqueue(() => this.applyRun((run) => applyRemoteRunSubscription(run, subscription))),
          onEvent: (event) => this.enqueue(() => this.applyRun((run) => applyRemoteRunEvent(run, event))),
          onState: (state) => this.enqueue(() => this.applyRun((run) => applyRemoteRunStreamState(run, state))),
          onError: (error) => this.update({ error: error.message }),
        }),
      );
    }
  }

  /** Reads the page before the oldest loaded message. */
  loadOlder(): Promise<void> {
    return this.enqueue(async () => {
      const first = this.snapshot.transcript.messages[0];
      if (!first || !this.snapshot.transcript.hasOlder || this.snapshot.loadingOlder) return;
      this.update({ loadingOlder: true });
      const result = await this.adapter.getMessagesWindow(this.chatId, { before: first.id });
      if (this.disposed) return;
      this.update({ loadingOlder: false });
      if (result.ok) {
        this.setTranscript(mergeOlderWindow(this.snapshot.transcript, result.value));
        return;
      }
      if (result.error.code === "fenced") return;
      if (isRevisionConflict(result.error)) {
        // The anchor left the host's chat; start again from the newest window.
        this.setTranscript(emptyRemoteTranscript(this.chatId));
        await this.refreshNewest();
        return;
      }
      this.update({ error: result.error.message });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.listeners.clear();
  }

  /** Resolves once everything queued so far has run (tests and callers awaiting a load). */
  idle(): Promise<void> {
    return this.queue;
  }

  private enqueue(task: () => Promise<void> | void): Promise<void> {
    this.queue = this.queue
      .then(() => (this.disposed ? undefined : task()))
      .catch((error: unknown) => {
        if (!this.disposed) this.update({ error: error instanceof Error ? error.message : "The host request failed." });
      });
    return this.queue;
  }

  private async applyRun(step: (run: RemoteRunView) => RemoteRunStep): Promise<void> {
    const next = step(this.snapshot.run);
    if (next.view !== this.snapshot.run) this.update({ run: next.view });
    if (next.refetch) await this.refreshNewest();
  }

  private acceptStatus(status: HostChatStatus): void {
    if (this.disposed) return;
    const previous = this.snapshot.status;
    this.update({ status, stale: status.availability !== "online" });
    // A reconnect may have missed turns: reread the newest window. The first
    // known status is not a reconnect; `start` reads the window after it.
    if (previous.generation >= 0 && previous.availability !== "online" && status.availability === "online")
      this.enqueue(() => this.refreshNewest());
  }

  private async refreshNewest(): Promise<void> {
    if (!this.adapter.capabilities().has("messagesWindow")) {
      this.update({ error: "This host does not share chat transcripts with this Mac." });
      return;
    }
    this.update({ loading: true });
    const result = await this.adapter.getMessagesWindow(this.chatId);
    if (this.disposed) return;
    this.update({ loading: false });
    if (!result.ok) {
      // A fenced read is redone when the host settles into its new connection.
      if (result.error.code !== "fenced") this.update({ error: result.error.message });
      return;
    }
    this.setTranscript(mergeNewestWindow(this.snapshot.transcript, result.value));
    const run = handOffRemoteRun(this.snapshot.run);
    if (run !== this.snapshot.run) this.update({ run });
    this.markNewestRead();
  }

  private setTranscript(transcript: RemoteTranscript): void {
    this.update({ transcript, loaded: true, error: null });
    this.cache?.write(transcript);
  }

  private markNewestRead(): void {
    const { messages } = this.snapshot.transcript;
    const newest = messages[messages.length - 1];
    if (
      !newest ||
      newest.id === this.lastMarked ||
      this.snapshot.status.availability !== "online" ||
      !this.adapter.capabilities().has("markRead")
    )
      return;
    this.lastMarked = newest.id;
    // Best effort: the host's unread marker is a convenience and the next read retries.
    void this.adapter.markRead(this.chatId, newest.id).then((result) => {
      if (!result.ok && this.lastMarked === newest.id) this.lastMarked = null;
    });
  }

  private update(patch: Partial<RemoteChatSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
