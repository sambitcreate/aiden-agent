/** Resource identity is independent of display names and transport addresses. */
export interface HostResource {
  hostId: string;
  resourceId: string;
}

export const LOCAL_HOST_ID = "local";
export const MAX_PEER_HOSTS = 32;

export function hostIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) {
    throw new Error("Invalid host resource identifier.");
  }
  return value;
}

export function hostResourceKey(ref: HostResource): string {
  return JSON.stringify([
    hostIdentifier(ref.hostId),
    hostIdentifier(ref.resourceId),
  ]);
}

export type PeerConnectionState =
  "disabled" | "disconnected" | "connecting" | "connected" | "unavailable";

export interface PeerHostView {
  id: string;
  name: string;
  enabled: boolean;
  state: PeerConnectionState;
  features: string[];
  capabilities: string[];
}
