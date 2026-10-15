export type AidenRemoteConnectionMode = "lan" | "tailscale" | "both";

export interface AidenRemoteStatusView {
  enabled: boolean;
  running: boolean;
  connectionMode: AidenRemoteConnectionMode;
  lanPort: number;
  lanEndpoint?: string;
  tailscaleEndpoint?: string;
  tailscaleRoutePreview?: string;
  tailscaleConnected: boolean;
  tailscaleInstalled: boolean;
  tailscaleRouteState:
    | "available"
    | "owned"
    | "other_aiden_live"
    | "other_aiden_stale"
    | "unrelated_conflict"
    | "funnel_conflict"
    | "reconciliation_required"
    | "unavailable";
  tailscaleErrorCode?:
    | "not_installed"
    | "not_connected"
    | "https_unavailable"
    | "status_unavailable"
    | "permission_denied";
  pairedDeviceCount: number;
  approvedRootCount: number;
  /** Present only on hosts that can serve desktop connection requests. */
  acceptPairingRequests?: boolean;
  errorCode?: "remote_port_in_use";
  error?: string;
}

/** A desktop connection request waiting for the person's decision. */
export interface AidenRemotePairingRequestPrompt {
  requestId: string;
  deviceName: string;
  deviceType: "mac" | "linux";
  transport: "lan" | "tailscale";
  /** Six digits the person compares with the requesting computer. */
  matchCode: string;
  expiresAt: string;
  /** True while an Allow is being committed. */
  approving: boolean;
}

export interface AidenRemotePairingRequestDecisionView {
  requestId: string;
  state: "pending" | "approved" | "denied" | "expired" | "cancelled";
  /** Set when Allow was chosen but the credential could not be issued. */
  failed?: true;
}

export interface AidenRemoteTailscaleTakeoverReviewView {
  token: string;
  expiresAt: number;
}

export interface AidenRemoteDeviceView {
  id: string;
  name: string;
  type: "iphone" | "ipad" | "android" | "mac" | "linux";
  clientVersion: string;
  capabilities: string[];
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface AidenRemoteApprovedRootView {
  id: string;
  label: string;
  folderPath: string;
  createdAt: number;
}

export interface AidenRemoteSettingsSnapshot {
  instanceId: string;
  displayName: string;
  status: AidenRemoteStatusView;
  devices: AidenRemoteDeviceView[];
  approvedRoots: AidenRemoteApprovedRootView[];
  pairing?: AidenRemotePairingStatusView;
}

export interface AidenRemotePairingStatusView {
  sessionId: string;
  state: "awaiting_scan" | "finishing" | "failed" | "expired";
  deviceId?: string;
}

export interface AidenRemotePairingBootstrapView {
  pairingSessionId: string;
  protocolVersion: 1;
  instanceId: string;
  endpoint: string;
  serverSpkiSha256: string;
  secret: string;
  expiresAt: string;
  /** Versioned scanner envelope; includes the LAN trust anchor when required. */
  qrPayload: string;
  /** IPC-only 100-bit setup code. It is never exposed through remote status. */
  manualCode: string;
}

export type AidenRemoteTlsEndpointErrorCode =
  | "timed_out"
  | "unreachable"
  | "untrusted"
  | "invalid_endpoint";

export interface AidenRemoteTlsEndpointFailure {
  ok: false;
  code: AidenRemoteTlsEndpointErrorCode;
  message: string;
}

export type AidenRemoteBeginPairingResult =
  | AidenRemotePairingBootstrapView
  | AidenRemoteTlsEndpointFailure;

export function isAidenRemoteTlsEndpointFailure(
  value: AidenRemoteBeginPairingResult,
): value is AidenRemoteTlsEndpointFailure {
  return "ok" in value && value.ok === false;
}
