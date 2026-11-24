/**
 * Build switch for Linux Bot computers (`docs/plans/linux-desktop-bots-plan.md`,
 * PRs F1–F3). While off (the default), Bot computers keep their macOS guest
 * behavior unchanged. F4 removes this switch together with the macOS path.
 */

export const AIDEN_BOT_COMPUTERS_LINUX_ENV = "AIDEN_BOT_COMPUTERS_LINUX";

export type BotComputerGuestOs = "macos" | "linux";

/**
 * Dedicated Linux user inside a Bot's computer for `computer_shell` commands,
 * separate from the logged-in desktop/sign-in user (plan decision 4a).
 */
export const BOT_COMPUTER_LINUX_SHELL_USER = "aiden-bot";

/** Whether the Linux Bot computers build switch is enabled in `env`. */
export function isLinuxBotComputersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AIDEN_BOT_COMPUTERS_LINUX_ENV] === "1";
}

/** The guest OS targeted by Bot computers for the current build switch. */
export function botComputerGuestOs(env: NodeJS.ProcessEnv = process.env): BotComputerGuestOs {
  return isLinuxBotComputersEnabled(env) ? "linux" : "macos";
}
