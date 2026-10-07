import type { PeerIntentStore } from "../services/peer-intent-store.js";
import { hostIdentifier } from "../../renderer/shared/peer-host.js";
export function registerPeerIntentHandlers<Event>(dependencies: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  active(event: Event): void;
  store(): PeerIntentStore;
}): void {
  dependencies.handle("remote:peerIntentsList", (event, hostId, chatId) => {
    dependencies.active(event);
    return dependencies.store().list(hostIdentifier(hostId), hostIdentifier(chatId));
  });
  dependencies.handle("remote:peerIntentsPut", (event, value) => {
    dependencies.active(event);
    return dependencies.store().put(value);
  });
  dependencies.handle("remote:peerIntentsRemove", (event, hostId, chatId, key) => {
    dependencies.active(event);
    return dependencies.store().remove(hostIdentifier(hostId), hostIdentifier(chatId), hostIdentifier(key));
  });
}
