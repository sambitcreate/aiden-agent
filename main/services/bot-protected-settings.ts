// Settings files no CLI Bot file tool may write. The desktop fences its own
// userData settings files in `bot-runtime/bot-session-main.ts`; the CLI keeps
// settings, credentials, connectors, models and workspace access in its agent
// dir, so a Bot that could edit them could change the app or its own access
// without the person (owner decision 2026-10-27).

import * as path from "node:path";
import { aidenConfigDir } from "./aiden-config-dir.js";

const CLI_SETTINGS_FILES = [
  "settings.json",
  "aiden.json",
  "auth.json",
  "credentials",
  "models.json",
  "mcp.json",
  "aiden-mcp.json",
  "workspaces.json",
  "remote.json",
  "web-search.json",
  "speech.json",
];

/** `<agent dir>/bots/` (Bot sessions and memory), `~/.aiden/config.json`, and the CLI's settings files. */
export function cliBotProtectedRoots(agentDir: string, configDir = aidenConfigDir()): string[] {
  return [
    path.join(agentDir, "bots"),
    path.join(configDir, "config.json"),
    ...CLI_SETTINGS_FILES.map((name) => path.join(agentDir, name)),
  ];
}
