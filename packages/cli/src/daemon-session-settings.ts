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
//
// Codex requests go over a persistent WebSocket, as on the desktop, so a chat
// stays on one backend connection and its prompt cache. Pi's own "auto" default
// would also replace each request with a previous-response delta; the server
// sends the full request instead, and stays on HTTP when Pi's settings ask
// for SSE or a proxy is configured for the Codex host.

import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { inProcessCodexTransport } from "../../../main/services/codex-transport.js";
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

/** The settings a daemon AgentSession reads: Pi's own, with warming set by the profile and the run, and Codex's transport. */
export function daemonSettingsManager(cwd: string, agentDir: string, warming: DaemonSessionWarming): SettingsManager {
  const settings = SettingsManager.create(cwd, agentDir);
  // Read once per session, so a changed setting reaches the next turn.
  const mode = warming.attended && profileWarmsCaches(agentDir) ? "streaming" : "off";
  settings.getCacheWarmingMode = () => mode;
  const transport = inProcessCodexTransport(settings.getTransport());
  settings.getTransport = () => transport;
  return settings;
}

/**
 * The settings a helper agent's worker process reads: a daemon session's,
 * never warming, with Codex on SSE. The worker is a short-lived child, like
 * the desktop's isolated dispatch, so it keeps no socket between requests.
 */
export function subagentWorkerSettingsManager(cwd: string, agentDir: string): SettingsManager {
  const settings = daemonSettingsManager(cwd, agentDir, { attended: false });
  settings.getTransport = () => "sse";
  return settings;
}
