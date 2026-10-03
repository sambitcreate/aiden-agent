import { hostIdentifier } from "../../renderer/shared/peer-host.js";
import type { PeerHostManager } from "../services/peer-host-manager.js";

export type PeerHostLiveManager = Pick<
  PeerHostManager,
  | "statuses"
  | "feedSnapshot"
  | "call"
  | "runSubscribe"
  | "runUnsubscribe"
  | "releaseOwner"
  | "setEnabled"
  | "remove"
  | "reconnect"
>;

/** The renderer document that made a request. */
export interface PeerHostLiveOwner {
  /** Stable for one document; a reload or navigation is a new owner. */
  readonly key: string;
  isDestroyed(): boolean;
  /** Runs once when the document goes away; returns a detach function. */
  onInvalidated(listener: () => void): () => void;
}

export interface PeerHostLiveHandlerDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  /** Throws for a sender that is not the current main frame. */
  owner(event: Event): PeerHostLiveOwner;
  /** Resolved per call so supervision starts on first use. */
  manager(): PeerHostLiveManager;
}

const INACTIVE = "The application document changed.";

/**
 * Supervisor-backed device IPC: statuses, cached host feeds, typed operation
 * outcomes and shared live run streams. No payload carries a credential,
 * endpoint or pin; live run subscriptions die with their document.
 */
export function registerPeerHostLiveHandlers<Event>(
  dependencies: PeerHostLiveHandlerDependencies<Event>,
): void {
  const { handle } = dependencies;
  const watched = new Map<string, () => void>();

  const active = (event: Event): PeerHostLiveOwner => {
    const owner = dependencies.owner(event);
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    return owner;
  };

  /** Run `work` with a signal aborted when the requesting document goes away. */
  const bound = async <T>(owner: PeerHostLiveOwner, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const detach = owner.onInvalidated(() => controller.abort());
    try {
      return await work(controller.signal);
    } finally {
      detach();
    }
  };

  const enabledFlag = (value: unknown): boolean => {
    if (typeof value !== "boolean") throw new Error("Invalid connection state.");
    return value;
  };

  handle("remote:peerHostStatuses", (event) => {
    active(event);
    return dependencies.manager().statuses();
  });

  handle("remote:peerHostFeed", (event, hostId) => {
    active(event);
    return dependencies.manager().feedSnapshot(hostId);
  });

  handle("remote:peerCall", (event, hostId, operation) => {
    const owner = active(event);
    return bound(owner, (signal) => dependencies.manager().call(hostId, operation, signal));
  });

  // The original throwing surface, now through the supervisor so blocked hosts
  // fail fast and ambiguous mutations are never replayed.
  handle("remote:peerOperation", async (event, hostId, operation) => {
    const owner = active(event);
    const outcome = await bound(owner, (signal) =>
      dependencies.manager().call(hostId, operation, signal),
    );
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.value;
  });

  handle("remote:peersSetEnabled", async (event, hostId, enabled) => {
    active(event);
    await dependencies.manager().setEnabled(hostIdentifier(hostId), enabledFlag(enabled));
  });

  handle("remote:peersRemove", async (event, hostId) => {
    active(event);
    await dependencies.manager().remove(hostIdentifier(hostId));
  });

  handle("remote:peerReconnect", (event, hostId) => {
    active(event);
    dependencies.manager().reconnect(hostIdentifier(hostId));
  });

  handle("remote:peerRunSubscribe", async (event, hostId, target, afterSequence) => {
    const owner = active(event);
    const manager = dependencies.manager();
    if (!watched.has(owner.key)) {
      watched.set(
        owner.key,
        owner.onInvalidated(() => {
          watched.delete(owner.key);
          manager.releaseOwner(owner.key);
        }),
      );
    }
    const subscription = await manager.runSubscribe(hostId, target, afterSequence, owner.key);
    if (owner.isDestroyed()) {
      manager.runUnsubscribe(subscription.subscriptionId, owner.key);
      throw new Error(INACTIVE);
    }
    return subscription;
  });

  handle("remote:peerRunUnsubscribe", (event, subscriptionId) => {
    const owner = active(event);
    return dependencies.manager().runUnsubscribe(subscriptionId, owner.key);
  });
}
