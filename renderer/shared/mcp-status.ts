/** Desktop Settings status only; advertised metadata never grants runtime access. */
export interface McpStatus {
  connected: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
  /** Initialize metadata, independent of tool discovery; null if initialization failed. */
  serverCapabilities: Record<string, unknown> | null;
  /** For OAuth servers: whether valid tokens are stored. */
  authorized?: boolean;
  /** For OAuth servers: the stored sign-in was rejected and must be renewed. */
  needsSignIn?: boolean;
  /** For OAuth servers: a browser sign-in is stored (usable or not), so it can be signed out. */
  hasSession?: boolean;
}

export type McpLiveState = "connecting" | "connected" | "failed" | "closed";

/** Pushed by main on `mcp:statusChanged`; one small record per server. */
export interface McpLiveStatus {
  serverId: string;
  state: McpLiveState;
  error?: string;
  /** Tools listed by the last successful discovery. */
  toolCount?: number;
  /**
   * Opaque identity of that discovery's tool list (names and titles). Changes
   * whenever the list does, even when the count stays the same.
   */
  toolsRevision?: string;
  /** The server advertises resources. */
  resources?: boolean;
  /** The last token refresh or background connect needed a new sign-in. */
  needsSignIn?: boolean;
  /** Set on the last event for a server that was removed. */
  removed?: boolean;
}

/** One remote tool as Settings lists it (raw name plus optional display title). */
export interface McpToolSummary {
  name: string;
  title?: string;
}

/** A local (stdio) server not approved to run on this device, with exactly what it would run. */
export interface McpPendingLaunchApproval {
  serverId: string;
  fingerprint: string;
  command: string;
  args: string[];
  /**
   * Each variable's value as written in config.json; omitted for one already
   * in the keychain. `unavailable`: its keychain value was saved for another
   * variable (or is gone), so it will not be used and must be entered again.
   */
  env: { name: string; value?: string; unavailable?: true }[];
}

/** Whether the Mac app behind a Mac app connector (iMCP) is installed and open. */
export interface McpMacAppStatus {
  /** False where Aiden doesn't run on a Mac; nothing was looked up. */
  supported: boolean;
  installed: boolean;
  /** The installed app's server: the only command its connection may run. */
  command?: string;
  /** The installed app's version, when its Info.plist states one. */
  version?: string;
  /** The app is running, so its server can answer. */
  open: boolean;
}

export interface McpDependent {
  id: string;
  name: string;
}

/** Schedules and Bots that stop working when a server is renamed away, disabled or removed. */
export interface McpServerDependents {
  schedules: McpDependent[];
  bots: McpDependent[];
}
