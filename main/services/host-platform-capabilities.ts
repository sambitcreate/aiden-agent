export interface HostPlatformCapabilities {
  platform: "darwin" | "linux" | "other";
  bots: boolean;
  computerUse: boolean;
  appleFoundationModels: boolean;
  accessibilityPaste: boolean;
  dictationHoldToTalk: boolean;
  dockIcon: boolean;
  nativeShare: boolean;
}
/**
 * Main-owned host capability policy. Persisted settings and renderer state may
 * narrow these values, but they can never widen them.
 */
export function hostPlatformCapabilities(
  platform: NodeJS.Platform = process.platform,
): HostPlatformCapabilities {
  const darwin = platform === "darwin";
  return {
    platform:
      platform === "darwin" || platform === "linux" ? platform : "other",
    bots: darwin,
    computerUse: darwin,
    appleFoundationModels: darwin,
    accessibilityPaste: darwin,
    dictationHoldToTalk: darwin,
    dockIcon: darwin,
    nativeShare: darwin,
  };
}
