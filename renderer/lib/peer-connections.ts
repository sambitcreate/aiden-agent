import type {
  PeerDiscoveredDevice,
  PeerHostStatus,
  PeerHostView,
  PeerPairingFailure,
} from "../shared/peer-host";

/** Soft status fills from the shared `Badge`; `gray` is the neutral control fill. */
export type PeerConnectionTone = "gray" | "blue" | "green" | "warning" | "red";

export interface PeerHostPresentation {
  label: string;
  tone: PeerConnectionTone;
  /** One line explaining a state that needs attention, if any. */
  detail?: string;
  /** Reconnecting now could help. */
  canReconnect: boolean;
  /** Only pairing again restores access. */
  needsRepair: boolean;
}

function seconds(ms: number): string {
  const value = Math.max(1, Math.ceil(ms / 1_000));
  return value === 1 ? "1 second" : `${value} seconds`;
}

/**
 * How one paired host reads in Connections. The supervisor status wins when
 * main has one; before the first status arrives the registry's coarse state
 * is shown instead.
 */
export function peerHostPresentation(
  host: PeerHostView,
  status: PeerHostStatus | undefined,
  now: number,
): PeerHostPresentation {
  const idle = { canReconnect: false, needsRepair: false };
  if (!host.enabled) return { label: "Off", tone: "gray", ...idle };
  if (status) {
    const state = status.state;
    switch (state.kind) {
      case "disabled":
        return { label: "Off", tone: "gray", ...idle };
      case "connecting":
        return { label: "Connecting", tone: "blue", ...idle };
      case "connected":
        if (status.feed === "unsupported") return { label: "Access unavailable", tone: "warning", detail: "Connected, but chat synchronization isn't available. Check access and app versions on the other computer.", ...idle };
        if (status.feed !== "live" || status.stale) return { label: "Syncing chats", tone: "blue", ...idle };
        return { label: "Ready", tone: "green", ...idle };
      case "backoff":
        return {
          label: "Reconnecting",
          tone: "warning",
          detail: `${status.failure === "timeout" ? "The computer didn't answer in time." : status.failure === "invalid_response" ? "The computer returned an unreadable response. Check both app versions." : "Couldn't reach this computer. Check that it is awake and connected to your network or Tailscale."} Trying again in ${seconds(state.retryAt - now)}.`,
          canReconnect: true,
          needsRepair: false,
        };
      case "blocked":
        if (state.reason === "auth")
          return {
            label: "Re-pair needed",
            tone: "red",
            detail: "Its access for this device was removed. Pair again to keep controlling it.",
            canReconnect: false,
            needsRepair: true,
          };
        if (state.reason === "identity_changed")
          return {
            label: "Identity changed",
            tone: "red",
            detail: "It no longer proves the identity saved when you paired. Re-pair only if you expected this.",
            canReconnect: false,
            needsRepair: true,
          };
        return {
          label: "Update needed",
          tone: "warning",
          detail: "The two devices run incompatible versions of Aiden. Update both, then reconnect.",
          canReconnect: true,
          needsRepair: false,
        };
    }
  }
  switch (host.state) {
    case "connected":
      return { label: "Connected", tone: "green", ...idle };
    case "connecting":
      return { label: "Connecting", tone: "blue", ...idle };
    case "unavailable":
      return { label: "Unavailable", tone: "warning", canReconnect: true, needsRepair: false };
    case "disabled":
      return { label: "Off", tone: "gray", ...idle };
    default:
      return { label: "Not connected", tone: "gray", canReconnect: true, needsRepair: false };
  }
}

/**
 * Apply status broadcasts by host. A status older than the one already held
 * (a lower generation) never replaces it, whatever order they arrive in.
 */
export function mergePeerHostStatus(
  current: readonly PeerHostStatus[] | undefined,
  incoming: PeerHostStatus,
): PeerHostStatus[] {
  const list = current ?? [];
  const index = list.findIndex((status) => status.hostId === incoming.hostId);
  if (index === -1) return [...list, incoming];
  if (list[index]!.generation > incoming.generation) return [...list];
  const next = [...list];
  next[index] = incoming;
  return next;
}

export interface PeerPairingOutcomeCopy {
  title: string;
  message: string;
}

function wait(secondsLeft: number): string {
  if (secondsLeft < 60) return secondsLeft === 1 ? "1 second" : `${secondsLeft} seconds`;
  const minutes = Math.ceil(secondsLeft / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * What to tell the person when pairing ends without a host. A cancelled
 * attempt was their own choice and needs no message.
 */
export function peerPairingOutcomeCopy(outcome: PeerPairingFailure): PeerPairingOutcomeCopy | null {
  switch (outcome.status) {
    case "cancelled":
      return null;
    case "denied":
      return { title: "Request declined", message: "The other device declined this request." };
    case "expired":
      return {
        title: "Request expired",
        message: "Nobody answered in time. Send a new request when someone is at the other device.",
      };
    case "rate_limited":
      return {
        title: "Too many attempts",
        message: outcome.retryAfterSeconds
          ? `The other device is pausing new requests. Try again in ${wait(outcome.retryAfterSeconds)}.`
          : "The other device is pausing new requests. Wait a moment and try again.",
      };
    case "closed":
      return {
        title: "Requests are off",
        message:
          "Turn on Accept connection requests in Settings → Connections on the other device, or use a setup code.",
      };
    case "unsupported":
      return {
        title: "Update the other device",
        message: "It runs an older Aiden without connection requests. Update it, or use a setup code.",
      };
    case "invalid_code":
      return {
        title: "Code not accepted",
        message: "Check the setup code and address shown on the other device, then try again.",
      };
    case "failed":
      return { title: "Couldn't pair", message: outcome.message };
  }
}

export interface PeerDiscoveredRow {
  device: PeerDiscoveredDevice;
  /** Send a connection request the other device approves. */
  connect: boolean;
  /** Pair with a setup code shown on the other device. */
  setupCode: boolean;
  /** A short note shown under the name. */
  note: string;
}

/**
 * The discovered devices the Add device sheet lists, with the actions each
 * allows. When re-pairing, only the host being replaced is listed. Devices
 * already paired are shown but cannot be paired twice.
 */
export function peerDiscoveredRows(
  devices: readonly PeerDiscoveredDevice[],
  replaceHostId?: string,
): PeerDiscoveredRow[] {
  const listed =
    replaceHostId === undefined ? devices : devices.filter((device) => device.id === replaceHostId);
  return listed.map((device) => {
    const route = device.route === "tailscale" ? "Tailscale" : "Same network";
    if (device.paired && device.id !== replaceHostId)
      return { device, connect: false, setupCode: false, note: `${route} · Already paired` };
    return {
      device,
      connect: device.pairingRequests,
      setupCode: true,
      note: device.pairingRequests ? route : `${route} · Requests off, use a setup code`,
    };
  });
}

/** Why a local name cannot be saved, or null when it can. Counts Unicode characters, as main does. */
export function peerLocalNameError(value: string): string | null {
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (!trimmed) return "Enter a name.";
  if ([...trimmed].length > 80) return "Use up to 80 characters.";
  if (/\p{Cc}/u.test(trimmed)) return "Remove control characters.";
  return null;
}

/** A fresh handle for one pairing attempt; main accepts `[A-Za-z0-9_-]{8,64}`. */
export function mintPeerPairingAttemptId(): string {
  return crypto.randomUUID().replace(/-/gu, "");
}
