import type { PeerHostManager } from "./peer-host-manager.js";

let activeManager: PeerHostManager | undefined;

export function setActivePeerHostManager(manager: PeerHostManager | undefined): void {
  activeManager = manager;
}

/**
 * The supervisor if something already started it, else undefined. Readers
 * that must not cause peer traffic (the Dock badge) use this without loading
 * the peer-host supervisor chunk.
 */
export function peekPeerHostManager(): PeerHostManager | undefined {
  return activeManager;
}
