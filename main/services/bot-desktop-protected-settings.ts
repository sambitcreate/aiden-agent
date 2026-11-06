import * as path from "node:path";
import type { BotFileToolProtectedRoot } from "./bot-file-tool-router.js";
import { botServiceProtectedRoot } from "./bot-protected-settings.js";
import { TOOL_APPROVAL_RULES_FILE } from "./tool-approval-rules.js";
import { IMAGE_GENERATION_SETTINGS_FILE } from "./image-generation/settings-store.js";
import { LOCAL_CONFIG_FILENAME, PORTABLE_CONFIG_FILENAME, PROVIDER_MODEL_CACHE_FILENAME, SETTINGS_FILENAME } from "./portable-config-core.js";

/** The desktop's fixed-location write fence, shared by production registration and file-tool checks. */
export function desktopBotProtectedRoots(profileDir: string, configDir: string, serviceDir: string): BotFileToolProtectedRoot[] {
  return [
    path.join(profileDir, "bots"),
    path.join(profileDir, "bots.json"),
    path.join(profileDir, TOOL_APPROVAL_RULES_FILE),
    path.join(profileDir, "bot-folder-grants.json"),
    botServiceProtectedRoot(serviceDir),
    path.join(configDir, PORTABLE_CONFIG_FILENAME),
    path.join(profileDir, SETTINGS_FILENAME),
    path.join(profileDir, LOCAL_CONFIG_FILENAME),
    path.join(profileDir, PROVIDER_MODEL_CACHE_FILENAME),
    path.join(profileDir, IMAGE_GENERATION_SETTINGS_FILE),
    // The person's hooks and their approvals: a Bot must never add or approve one.
    path.join(profileDir, "hooks"),
  ];
}
