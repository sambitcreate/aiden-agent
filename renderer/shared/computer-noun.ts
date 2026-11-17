/**
 * The one place that names the computer Aiden runs on in copy.
 *
 * - The computer the person is using, in the desktop app or in server text
 *   about itself: "Mac" on macOS, "computer" everywhere else.
 * - Any other computer running Aiden (a paired desktop, a Linux machine or an
 *   `aiden serve` host), and every computer a phone talks to: "computer".
 * - "Mac" stays only for features that exist on macOS alone (Computer Use,
 *   Simulators, Bot computers, Mac app connectors, Apple models, the Dock).
 */
export type LocalComputerNoun = "Mac" | "computer";

/** "Mac" on macOS, "computer" on Linux and anything else. */
export function localComputerNoun(platform: string | null | undefined): LocalComputerNoun {
  return platform === "darwin" ? "Mac" : "computer";
}

/** "This Mac" or "This computer", for labels at the start of a sentence or row. */
export function thisComputerLabel(platform: string | null | undefined): string {
  return `This ${localComputerNoun(platform)}`;
}

/**
 * The platform this code runs on, for shared copy that is not handed one:
 * Node's in main and the CLI, the browser's in the renderer.
 */
export function runtimeComputerPlatform(): string | undefined {
  const node = (globalThis as { process?: { platform?: unknown } }).process;
  if (typeof node?.platform === "string") return node.platform;
  const browser = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  if (!browser) return undefined;
  const identity = `${browser.platform ?? ""} ${browser.userAgent ?? ""}`;
  if (/linux/iu.test(identity)) return "linux";
  if (/mac/iu.test(identity)) return "darwin";
  return undefined;
}
