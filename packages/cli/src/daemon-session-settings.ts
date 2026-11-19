// Pi settings for the AgentSessions `aiden serve` runs (chat turns and
// scheduled tasks).
//
// Pi's warmer sends paid one-token refresh requests to hold a prompt cache,
// and coding-agent 1.5 defaults it to "idle", which keeps refreshing after a
// turn ends. The server follows the profile's Aiden setting instead, the same
// `cacheWarmingEnabled` switch the desktop saves in aiden.json: on, an attended
// chat turn keeps its cache warm while the reply streams ("streaming"); off,
// or for a turn no one is watching (a Bot, a Telegram message, a scheduled
// task), Pi never warms. A `cacheWarming` in Pi's settings.json is ignored, so
// the profile has one switch.

import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readJson } from "./state.ts";

export interface DaemonSessionWarming {
  /** A person is waiting on this turn. Bot, Telegram and scheduled runs are not attended. */
  attended: boolean;
}

/** Whether the profile's aiden.json opts in to cache warming; anything but `true` is off. */
function profileWarmsCaches(agentDir: string): boolean {
  try {
    const settings = readJson<unknown>(join(agentDir, "aiden.json"), {});
    return !!settings && typeof settings === "object" && (settings as { cacheWarmingEnabled?: unknown }).cacheWarmingEnabled === true;
  } catch { return false; }
}

/** The settings a daemon AgentSession reads: Pi's own, with warming set by the profile and the run. */
export function daemonSettingsManager(cwd: string, agentDir: string, warming: DaemonSessionWarming): SettingsManager {
  const settings = SettingsManager.create(cwd, agentDir);
  // Read once per session, so a changed setting reaches the next turn.
  const mode = warming.attended && profileWarmsCaches(agentDir) ? "streaming" : "off";
  settings.getCacheWarmingMode = () => mode;
  return settings;
}
