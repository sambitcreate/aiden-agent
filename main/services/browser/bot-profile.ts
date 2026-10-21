// A Bot's browser profile lives outside the person's profile list. Its id is
// `bot:<botId>`, and its cookies, storage and cache sit in a persistent
// partition named after the Bot's directory, so they never mix with the
// person's workspace browsing and Bot delete can clear exactly that partition.

import { botDirectoryName } from "../bot-runtime/harness-host.js";

export const BOT_BROWSER_PROFILE_PREFIX = "bot:";

/** The browser profile id of a Bot's own browser: `bot:<botId>`. */
export function botBrowserProfileId(botId: string): string {
  // Validates the id the same way the Bot's home directory does.
  botDirectoryName(botId);
  return `${BOT_BROWSER_PROFILE_PREFIX}${botId}`;
}

/** Whether a browser profile id names a Bot's own profile, not a person's. */
export function isBotBrowserProfileId(id: string): boolean {
  return id.startsWith(BOT_BROWSER_PROFILE_PREFIX) && id.length > BOT_BROWSER_PROFILE_PREFIX.length;
}

/** The Bot id behind a Bot profile id, or `undefined` for any other profile. */
export function botIdOfBrowserProfile(id: string): string | undefined {
  return isBotBrowserProfileId(id) ? id.slice(BOT_BROWSER_PROFILE_PREFIX.length) : undefined;
}

/** The persistent Electron partition that holds one Bot's browser data. */
export function botBrowserPartition(botId: string): string {
  return `persist:aiden-bot-${botDirectoryName(botId)}`;
}
