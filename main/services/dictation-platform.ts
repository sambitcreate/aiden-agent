import { hostPlatformCapabilities } from "./host-platform-capabilities.js";

export interface DictationPlatformBehavior {
  accessibilityPaste: boolean;
  holdToTalk: boolean;
}
export function dictationPlatformBehavior(
  platform: NodeJS.Platform = process.platform,
): DictationPlatformBehavior {
  const host = hostPlatformCapabilities(platform);
  return {
    accessibilityPaste: host.accessibilityPaste,
    holdToTalk: host.dictationHoldToTalk,
  };
}
