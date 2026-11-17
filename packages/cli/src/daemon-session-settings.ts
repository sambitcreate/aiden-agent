// Pi settings for the AgentSessions `aiden serve` runs (chat turns and
// scheduled tasks).
//
// coding-agent 1.5.1 changed the `cacheWarming` default from "streaming" to
// "idle": after a turn ends, Pi keeps sending paid one-token refresh requests
// to hold the chat's prompt cache for up to 30 minutes. Aiden's own idle
// warming is opt-in and off by default on the desktop, and the server has no
// such setting, so it keeps 1.4.0's "streaming" default. An explicit
// `cacheWarming` in the profile's settings.json still applies.

import { SettingsManager, type CacheWarmingMode } from "@earendil-works/pi-coding-agent";

const CACHE_WARMING_MODES: readonly string[] = ["off", "streaming", "idle"] satisfies readonly CacheWarmingMode[];

/** The settings a daemon AgentSession reads: Pi's own, with the 1.4.0 cache-warming default. */
export function daemonSettingsManager(cwd: string, agentDir: string): SettingsManager {
  const settings = SettingsManager.create(cwd, agentDir);
  settings.getCacheWarmingMode = () => {
    const mode = settings.getGlobalSettings().cacheWarming;
    return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "streaming";
  };
  return settings;
}
