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
  pairedDeviceCount: number;
  approvedRootCount: number;
  error?: string;
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
  status: AidenRemoteStatusView;
  devices: AidenRemoteDeviceView[];
  approvedRoots: AidenRemoteApprovedRootView[];
}

export interface AidenRemotePairingBootstrapView {
  protocolVersion: 1;
  instanceId: string;
  endpoint: string;
  serverSpkiSha256: string;
  secret: string;
  expiresAt: string;
  /** Versioned scanner envelope; includes the LAN trust anchor when required. */
  qrPayload: string;
}
