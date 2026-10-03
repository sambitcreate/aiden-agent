import { peerHostsApi } from "../ipc";
import { hostAvailability } from "../sidebar-remote-groups";
import {
  mintPeerIdempotencyKey,
  type PeerHostStatus,
  type PeerHostView,
  type PeerRunFrameMessage,
} from "../../shared/peer-host";
import {
  FENCED_ERROR,
  type HostChatAdapter,
  type HostChatCapability,
  type HostChatError,
  type HostChatObserver,
  type HostChatResult,
  type HostChatStatus,
  type HostChatWindowRequest,
} from "./host-chat-adapter";
import { mapRemoteMessagesWindow, type RemoteMessagesWindow } from "./remote-chat-mapper";

/** The slice of `peerHostsApi` a remote adapter needs; tests wire main's handlers in-process. */
export type PeerHostTransport = Pick<
  typeof peerHostsApi,
  "call" | "runSubscribe" | "runUnsubscribe" | "onRunFrame" | "statuses" | "onHostState"
>;

export const DEFAULT_WINDOW_LIMIT = 50;

/** What a paired host grants this Mac, from the features and capabilities it reported. */
export function remoteHostCapabilities(host: Pick<PeerHostView, "features" | "capabilities">): Set<HostChatCapability> {
  const features = new Set(host.features);
  const grants = new Set(host.capabilities);
  const capabilities = new Set<HostChatCapability>();
  if (features.has("chat-messages-window-v1") && grants.has("chat:read")) capabilities.add("messagesWindow");
  if (features.has("run-streams-v1") && grants.has("runs:observe")) capabilities.add("observe");
  if (features.has("chat-read-state-v1") && grants.has("chat:read")) capabilities.add("markRead");
  return capabilities;
}

function failure(error: unknown): HostChatError {
  return { code: "failed", message: error instanceof Error ? error.message : "The host request failed." };
}

/**
 * `HostChatAdapter` for a paired host, over the peer IPC. It never holds or
 * sees host credentials; main signs and sends every request.
 */
export class RemoteHostAdapter implements HostChatAdapter {
  readonly hostId: string;
  private readonly transport: PeerHostTransport;
  private readonly granted: ReadonlySet<HostChatCapability>;
  private current: HostChatStatus = { availability: "connecting", generation: -1 };
  private readonly listeners = new Set<(status: HostChatStatus) => void>();
  private readonly offHostState: () => void;
  private disposed = false;
  private readonly initial: Promise<void>;

  constructor(host: PeerHostView, transport: PeerHostTransport = peerHostsApi) {
    this.hostId = host.id;
    this.transport = transport;
    this.granted = remoteHostCapabilities(host);
    this.offHostState = transport.onHostState((status) => this.acceptStatus(status));
    this.initial = transport.statuses().then(
      (statuses) => {
        const status = statuses.find((entry) => entry.hostId === this.hostId);
        if (status) this.acceptStatus(status);
      },
      () => {},
    );
  }

  ready(): Promise<void> {
    return this.initial;
  }

  capabilities(): ReadonlySet<HostChatCapability> {
    return this.granted;
  }

  status(): HostChatStatus {
    return this.current;
  }

  onStatus(listener: (status: HostChatStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private acceptStatus(status: PeerHostStatus): void {
    // Statuses are broadcast for every host and may arrive out of order.
    if (this.disposed || status.hostId !== this.hostId || status.generation <= this.current.generation) return;
    this.current = { ...hostAvailability(status), generation: status.generation };
    for (const listener of [...this.listeners]) listener(this.current);
  }

  /** Runs a read and drops its answer when the host connection moved on meanwhile. */
  private async fenced<T>(read: () => Promise<HostChatResult<T>>): Promise<HostChatResult<T>> {
    const generation = this.current.generation;
    let result: HostChatResult<T>;
    try {
      result = await read();
    } catch (error) {
      result = { ok: false, error: failure(error) };
    }
    if (this.disposed || this.current.generation !== generation) return { ok: false, error: FENCED_ERROR };
    return result;
  }

  getMessagesWindow(chatId: string, request: HostChatWindowRequest = {}): Promise<HostChatResult<RemoteMessagesWindow>> {
    return this.fenced(async () => {
      const outcome = await this.transport.call(this.hostId, {
        operation: "messagesWindow",
        resourceId: chatId,
        ...(request.before ? { before: request.before } : {}),
        limit: request.limit ?? DEFAULT_WINDOW_LIMIT,
      });
      if (!outcome.ok) return outcome;
      const window = mapRemoteMessagesWindow(outcome.value);
      if (window.chatId !== chatId) return { ok: false, error: { code: "failed", message: "The host answered for another chat." } };
      return { ok: true, value: window };
    });
  }

  markRead(chatId: string, throughMessageId?: string): Promise<HostChatResult<void>> {
    return this.fenced(async () => {
      const outcome = await this.transport.call(this.hostId, {
        operation: "markRead",
        resourceId: chatId,
        body: throughMessageId ? { throughMessageId } : {},
        // A fresh intent each time: a later mark must not replay an earlier one.
        idempotencyKey: mintPeerIdempotencyKey(),
      });
      return outcome.ok ? { ok: true, value: undefined } : outcome;
    });
  }

  observe(chatId: string, observer: HostChatObserver): () => void {
    let closed = false;
    let key: string | null = null;
    let subscriptionId: string | null = null;
    // Frames that land before the subscription resolves are held, then
    // replayed after its buffered events so nothing is lost or reordered.
    let pending: PeerRunFrameMessage[] | null = [];
    const deliver = (frame: PeerRunFrameMessage) => {
      if (frame.key !== key) return;
      if (frame.kind === "event") observer.onEvent(frame.event);
      else observer.onState(frame.state);
    };
    const offFrames = this.transport.onRunFrame((frame) => {
      if (closed || this.disposed || frame.hostId !== this.hostId) return;
      if (pending) pending.push(frame);
      else deliver(frame);
    });
    this.transport.runSubscribe(this.hostId, { chatId }).then(
      (subscription) => {
        if (closed || this.disposed) {
          void this.transport.runUnsubscribe(subscription.subscriptionId).catch(() => {});
          return;
        }
        subscriptionId = subscription.subscriptionId;
        key = subscription.key;
        observer.onSubscription(subscription);
        const held = pending ?? [];
        pending = null;
        for (const frame of held) if (!closed) deliver(frame);
      },
      (error: unknown) => {
        pending = null;
        if (!closed && !this.disposed) observer.onError?.(failure(error));
      },
    );
    return () => {
      if (closed) return;
      closed = true;
      offFrames();
      if (subscriptionId) void this.transport.runUnsubscribe(subscriptionId).catch(() => {});
    };
  }

  dispose(): void {
    this.disposed = true;
    this.offHostState();
    this.listeners.clear();
  }
}
