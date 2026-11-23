export interface HostPlatformCapabilities {
  platform: "darwin" | "linux" | "other";
  bots: boolean;
  computerUse: boolean;
  /** A macOS VM per Bot: Apple silicon only, as Virtualization.framework requires. */
  botComputers: boolean;
  appleFoundationModels: boolean;
  accessibilityPaste: boolean;
  dictationHoldToTalk: boolean;
  dockIcon: boolean;
  /**
   * A count on the app icon: the Dock tile on macOS, the launcher entry on
   * Linux (shown only by launchers that support Unity counts).
   */
  badgeCount: boolean;
  nativeShare: boolean;
  /** Connectors served by a separate Mac app, such as iMCP (`renderer/shared/connector-catalog.ts`). */
  macAppConnectors: boolean;
  /** The agent's background jobs follow process groups, which macOS and Linux both offer. */
  backgroundJobs: boolean;
  /** Aiden hooks run commands in their own process group, so they need macOS or Linux, as background jobs do. */
  hooks: boolean;
  /**
   * The loopback MCP server that lets other apps on this computer use Aiden
   * (`main/services/aiden-mcp-server.ts`). Off until the person turns it on,
   * and offered where Remote Access runs: macOS and Linux.
   */
  mcpServer: boolean;
  /**
   * Aiden Live's optional screen share: the macOS system picker, Aiden's own
   * picker on Linux under X11, or the desktop's portal under Wayland.
   */
  liveScreenShare: boolean;
  /**
   * A workspace chat's agent may promise to check back later (`check_back`):
   * offered where follow-through notices wake a chat, macOS and Linux.
   */
  chatCheckBacks: boolean;
  /**
   * Keep the computer awake while Aiden works (Electron's power-save blocker):
   * IOKit on macOS, the desktop's inhibit service over D-Bus on Linux, which
   * is best-effort because not every desktop runs one.
   */
  keepAwake: boolean;
  /**
   * A workspace chat can start and run other chats (`child_chats`): offered
   * where follow-through notices wake a chat, macOS and Linux.
   */
  childChats: boolean;
}
/**
 * Main-owned host capability policy. Persisted settings and renderer state may
 * narrow these values, but they can never widen them.
 */
export function hostPlatformCapabilities(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): HostPlatformCapabilities {
  const darwin = platform === "darwin";
  return {
    platform:
      platform === "darwin" || platform === "linux" ? platform : "other",
    bots: darwin || platform === "linux",
    computerUse: darwin,
    botComputers: darwin && arch === "arm64",
    appleFoundationModels: darwin,
    accessibilityPaste: darwin,
    dictationHoldToTalk: darwin,
    dockIcon: darwin,
    badgeCount: darwin || platform === "linux",
    nativeShare: darwin,
    macAppConnectors: darwin,
    backgroundJobs: darwin || platform === "linux",
    hooks: darwin || platform === "linux",
    mcpServer: darwin || platform === "linux",
    liveScreenShare: darwin || platform === "linux",
    chatCheckBacks: darwin || platform === "linux",
    keepAwake: darwin || platform === "linux",
    childChats: darwin || platform === "linux",
  };
}
