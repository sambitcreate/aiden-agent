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
  nativeShare: boolean;
  /** Connectors served by a separate Mac app, such as iMCP (`renderer/shared/connector-catalog.ts`). */
  macAppConnectors: boolean;
  /** The agent's background jobs follow process groups, which macOS and Linux both offer. */
  backgroundJobs: boolean;
  /** Aiden hooks run commands in their own process group, so they need macOS or Linux, as background jobs do. */
  hooks: boolean;
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
    nativeShare: darwin,
    macAppConnectors: darwin,
    backgroundJobs: darwin || platform === "linux",
    hooks: darwin || platform === "linux",
  };
}
