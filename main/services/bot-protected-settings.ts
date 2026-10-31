// Settings files no Bot file tool may write. A Bot that could edit them could
// change the app or its own access without the person (owner decision
// 2026-10-27). The desktop registers its userData list in
// `bot-runtime/bot-session-main.ts`; the CLI keeps settings, credentials,
// connectors, models and workspace access in its agent dir.

import * as path from "node:path";
import { aidenConfigDir } from "./aiden-config-dir.js";
import type { BotFileToolProtectedRoot } from "./bot-file-tool-router.js";
import { BOT_MANAGED_HOMES_DIRECTORY } from "./bot-managed-workspace.js";

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
  "telegram.json",
];

/**
 * Aiden's Bot storage directory (Bot definitions, access state, keys, pauses),
 * all fenced except `homes/`, where each Bot keeps its own files.
 */
export function botServiceProtectedRoot(directory: string): BotFileToolProtectedRoot {
  return { root: directory, except: [path.join(directory, BOT_MANAGED_HOMES_DIRECTORY)] };
}

/**
 * `<agent dir>/bots/` (Bot sessions and memory), `bot-service/` (but not Bot
 * homes), `authority/` (access rollback anchors), `~/.aiden/config.json`, and
 * the CLI's settings files.
 */
export function cliBotProtectedRoots(agentDir: string, configDir = aidenConfigDir()): BotFileToolProtectedRoot[] {
  return [
    path.join(agentDir, "bots"),
    botServiceProtectedRoot(path.join(agentDir, "bot-service")),
    path.join(agentDir, "authority"),
    path.join(configDir, "config.json"),
    ...CLI_SETTINGS_FILES.map((name) => path.join(agentDir, name)),
  ];
}
