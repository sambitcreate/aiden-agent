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
  tailscaleErrorCode?: "not_installed" | "not_connected" | "https_unavailable" | "status_unavailable";
  pairedDeviceCount: number;
  approvedRootCount: number;
  errorCode?: "remote_port_in_use";
  error?: string;
}

export interface AidenRemoteTailscaleTakeoverReviewView {
  token: string;
  expiresAt: number;
}

export interface AidenRemoteDeviceView {
  id: string;
  name: string;
  type: "iphone" | "ipad";
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

export type AidenRemoteDesktopErrorCode =
  | "tls_endpoint_timeout"
  | "tls_endpoint_unreachable"
  | "tls_invalid_certificate"
  | "pairing_failed"
  | `tailscale_${string}`;

export type AidenRemoteDesktopResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AidenRemoteDesktopErrorCode; message: string };

export class AidenRemoteDesktopError extends Error {
  readonly code: AidenRemoteDesktopErrorCode;

  constructor(code: AidenRemoteDesktopErrorCode, message: string) {
    super(message);
    this.name = "AidenRemoteDesktopError";
    this.code = code;
  }
}

export function unwrapAidenRemoteDesktopResult<T>(result: AidenRemoteDesktopResult<T>): T {
  if (result.ok) return result.value;
  throw new AidenRemoteDesktopError(result.code, result.message);
}
