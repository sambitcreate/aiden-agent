/**
 * Simulator tab IPC, free of Electron so it can be tested. Every channel is
 * refused unless the experimental devices flag is on, and every call must come
 * from the active application document. The renderer never receives the hub
 * origin; it gets a short-lived grant for main's token proxy instead.
 */
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import type { DeviceService } from "./device-service.js";
import {
  LOCAL_DEVICE_HOST_ID,
  parseDeviceActionInput,
  type DeviceConsentKind,
} from "../../../renderer/shared/devices.js";

const ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;
const CHAT_ID_MAX_LENGTH = 256;

export interface DeviceIpcEvent {
  sender: unknown;
  senderFrame: unknown;
}

export interface DeviceHandlerDeps {
  handle(channel: string, listener: (event: DeviceIpcEvent, ...args: unknown[]) => unknown): void;
  enabled(): boolean;
  owner(event: DeviceIpcEvent): RendererDocumentOwner;
  service(): DeviceService;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`A valid ${label} is required.`);
  return value;
}

function requireChatId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > CHAT_ID_MAX_LENGTH) {
    throw new Error("A valid chat is required for a simulator session.");
  }
  return value;
}

function requireConsentKind(value: unknown): DeviceConsentKind {
  if (value !== "streaming" && value !== "agentAccess") throw new Error("Unknown simulator consent.");
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid simulator request.");
  }
  return value as Record<string, unknown>;
}

export function registerDeviceHandlersWith(deps: DeviceHandlerDeps): void {
  const subscribers = new Set<RendererDocumentOwner>();
  let unsubscribeState: (() => void) | null = null;
  let unsubscribeReveal: (() => void) | null = null;
  const broadcast = (channel: "devices:state" | "devices:reveal", payload: unknown) => {
    for (const subscriber of [...subscribers]) {
      if (subscriber.isDestroyed()) subscribers.delete(subscriber);
      else subscriber.send(channel, payload);
    }
  };

  const subscribe = (owner: RendererDocumentOwner, service: DeviceService): void => {
    unsubscribeState ??= service.onState((state) => broadcast("devices:state", state));
    // An agent's device_open shows the Simulator tab for its chat.
    unsubscribeReveal ??= service.onReveal((chatId) => broadcast("devices:reveal", { chatId }));
    if (subscribers.has(owner)) return;
    subscribers.add(owner);
    const cleanup = owner.onInvalidated(() => {
      subscribers.delete(owner);
      cleanup();
    });
  };

  const guarded = <T>(run: (service: DeviceService, owner: RendererDocumentOwner, args: unknown[]) => Promise<T>) =>
    async (event: DeviceIpcEvent, ...args: unknown[]): Promise<T> => {
      if (!deps.enabled()) throw new Error("Simulator devices are not enabled.");
      const owner = deps.owner(event);
      return run(deps.service(), owner, args);
    };

  deps.handle(
    "devices:get-state",
    guarded(async (service, owner) => {
      subscribe(owner, service);
      return service.load();
    }),
  );
  deps.handle(
    "devices:consent",
    guarded(async (service, owner, [kind, granted]) => {
      const consentKind = requireConsentKind(kind);
      if (typeof granted !== "boolean") throw new Error("Invalid simulator consent.");
      subscribe(owner, service);
      return granted ? service.grantConsent(consentKind) : service.revokeConsent(consentKind);
    }),
  );
  deps.handle(
    "devices:refresh",
    guarded(async (service, owner) => {
      subscribe(owner, service);
      return service.refresh();
    }),
  );
  deps.handle(
    "devices:open",
    guarded(async (service, _owner, [input]) => {
      const request = requireRecord(input);
      return service.open({
        chatId: requireChatId(request.chatId),
        hostId: request.hostId === undefined ? LOCAL_DEVICE_HOST_ID : requireId(request.hostId, "device host"),
        deviceId: requireId(request.deviceId, "simulator"),
        openedBy: "user",
      });
    }),
  );
  deps.handle(
    "devices:close",
    guarded(async (service, _owner, [input]) => {
      const request = requireRecord(input);
      if (request.shutdown !== undefined && typeof request.shutdown !== "boolean") {
        throw new Error("Invalid simulator request.");
      }
      await service.close({
        chatId: requireChatId(request.chatId),
        hostId: requireId(request.hostId, "device host"),
        deviceId: requireId(request.deviceId, "simulator"),
        shutdown: request.shutdown === true,
      });
    }),
  );
  deps.handle(
    "devices:action",
    guarded(async (service, _owner, [input]) => {
      const action = parseDeviceActionInput(input);
      if (!action) throw new Error("Unsupported simulator action.");
      return service.action(action);
    }),
  );
  deps.handle(
    "devices:settings",
    guarded(async (service, _owner, [input]) => {
      const request = requireRecord(input);
      return service.settings({
        hostId: requireId(request.hostId, "device host"),
        deviceId: requireId(request.deviceId, "simulator"),
      });
    }),
  );
  deps.handle(
    "devices:screenshot",
    guarded(async (service, _owner, [input]) => {
      const request = requireRecord(input);
      const png = await service.screenshot({
        hostId: requireId(request.hostId, "device host"),
        deviceId: requireId(request.deviceId, "simulator"),
      });
      // A plain Uint8Array survives structured clone without Buffer's pooled backing store.
      return new Uint8Array(png);
    }),
  );
  deps.handle(
    "devices:stream-grant",
    guarded(async (service) => service.streamGrant()),
  );
}
