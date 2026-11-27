// Read-only Files for a Bot on the desktop: the files in the Bot's own folder.
//
// - `bots:files:list(botId)` → the folder's file index.
// - `bots:files:read(botId, path)` → one text file, by its path in the folder.
//
// Paths are resolved below the Bot's folder by the shared workspace file
// readers (no traversal, no symlink escape). Nothing here writes.

import type { WorkspaceFileDocument, WorkspaceFileIndex } from "../services/workspace-files.js";
import { parseBotId } from "./bot-params.js";

export const BOT_FILES_LIST_CHANNEL = "bots:files:list";
export const BOT_FILES_READ_CHANNEL = "bots:files:read";

const MAX_PATH_CHARS = 4_096;

export interface BotFileHandlerDependencies {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  /** The Bot's folder. Throws for a Bot that does not exist. */
  homePath(botId: string): Promise<string>;
  list(root: string, signal: AbortSignal): Promise<WorkspaceFileIndex>;
  read(root: string, path: string, signal: AbortSignal): Promise<WorkspaceFileDocument>;
}

function pathOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_PATH_CHARS || value.includes("\0")) {
    throw new Error("Invalid file path.");
  }
  return value;
}

export function registerBotFileHandlers(dependencies: BotFileHandlerDependencies): void {
  dependencies.handle(BOT_FILES_LIST_CHANNEL, async (_event, botId) => {
    const root = await dependencies.homePath(parseBotId(botId));
    return dependencies.list(root, new AbortController().signal);
  });
  dependencies.handle(BOT_FILES_READ_CHANNEL, async (_event, botId, filePath) => {
    const id = parseBotId(botId);
    const relative = pathOf(filePath);
    const root = await dependencies.homePath(id);
    return dependencies.read(root, relative, new AbortController().signal);
  });
}
