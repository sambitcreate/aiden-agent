import type { RendererDocumentOwner } from "../renderer-document-owner.js";

export interface DeviceIpcEvent {
  sender: unknown;
  senderFrame: unknown;
}

export interface DeviceIpcGuardDeps {
  enabled(): boolean;
  owner(event: DeviceIpcEvent): RendererDocumentOwner;
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid simulator request.");
  }
  return value as Record<string, unknown>;
}

export function createDeviceIpcGuard<Target>(
  deps: DeviceIpcGuardDeps,
  target: () => Target,
) {
  return <T>(
    run: (target: Target, owner: RendererDocumentOwner, args: unknown[], event: DeviceIpcEvent) => Promise<T>,
  ) =>
    async (event: DeviceIpcEvent, ...args: unknown[]): Promise<T> => {
      if (!deps.enabled()) throw new Error("Simulator devices are not enabled.");
      const owner = deps.owner(event);
      return run(target(), owner, args, event);
    };
}

export function ownerSubscribers<Channel extends "devices:state" | "devices:reveal" | "devices:recordings">() {
  const subscribers = new Set<RendererDocumentOwner>();
  return {
    add(owner: RendererDocumentOwner): void {
      if (subscribers.has(owner)) return;
      subscribers.add(owner);
      const cleanup = owner.onInvalidated(() => {
        subscribers.delete(owner);
        cleanup();
      });
    },
    broadcast(channel: Channel, payload: unknown): void {
      for (const subscriber of [...subscribers]) {
        if (subscriber.isDestroyed()) subscribers.delete(subscriber);
        else subscriber.send(channel, payload);
      }
    },
  };
}
