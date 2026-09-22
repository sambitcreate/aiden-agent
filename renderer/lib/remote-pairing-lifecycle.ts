import type {
  AidenRemoteDeviceView,
  AidenRemotePairingStatusView,
} from "../shared/aiden-remote";

export type RemotePairingLifecycle =
  | { state: "unrelated" }
  | { state: "awaiting_scan" }
  | { state: "finishing"; device?: AidenRemoteDeviceView }
  | { state: "connected"; device: AidenRemoteDeviceView }
  | { state: "cancelled"; device: AidenRemoteDeviceView }
  | { state: "failed" }
  | { state: "expired" };

export function evaluateRemotePairingLifecycle(input: {
  pairingSessionId: string;
  status?: AidenRemotePairingStatusView;
  devices: readonly AidenRemoteDeviceView[];
}): RemotePairingLifecycle {
  if (!input.status || input.status.sessionId !== input.pairingSessionId) {
    return { state: "unrelated" };
  }
  if (input.status.state === "failed" || input.status.state === "expired") {
    return { state: input.status.state };
  }
  if (input.status.state === "awaiting_scan") {
    return { state: "awaiting_scan" };
  }
  const device = input.devices.find((candidate) => candidate.id === input.status?.deviceId);
  if (device?.revokedAt !== undefined) {
    return { state: "cancelled", device };
  }
  if (!device || device.lastSeenAt === 0) {
    return { state: "finishing", ...(device ? { device } : {}) };
  }
  return { state: "connected", device };
}

export function effectiveRemotePairingLifecycle(
  lifecycle: RemotePairingLifecycle,
  secondsRemaining: number,
): RemotePairingLifecycle {
  if (lifecycle.state === "awaiting_scan" && secondsRemaining <= 0) {
    return { state: "expired" };
  }
  return lifecycle;
}

export function remotePairingPresentation(
  lifecycle: RemotePairingLifecycle,
  secondsRemaining: number,
): { badge: string; tone: "blue" | "red"; qrDisabled: boolean } {
  switch (lifecycle.state) {
    case "finishing":
      return { badge: "Finishing connection", tone: "blue", qrDisabled: true };
    case "failed":
      return { badge: "Pairing failed", tone: "red", qrDisabled: true };
    case "expired":
      return { badge: "Expired", tone: "red", qrDisabled: true };
    case "cancelled":
      return { badge: "Pairing cancelled", tone: "red", qrDisabled: true };
    default:
      return secondsRemaining > 0
        ? {
            badge: `Expires in ${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, "0")}`,
            tone: "blue",
            qrDisabled: false,
          }
        : { badge: "Expired", tone: "red", qrDisabled: true };
  }
}
