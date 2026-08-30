import type { ComputerUseStatus } from "../types.js";

export function computerUseSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export function unsupportedComputerUseStatus(): ComputerUseStatus {
  return {
    enabled: false,
    beta: true,
    state: "unsupported",
    detail: "Computer Use is not included on this platform.",
    ready: false,
    available: false,
    retryable: false,
    canRequestPermissions: false,
    permissions: { accessibility: null, screenRecording: null },
  };
}
