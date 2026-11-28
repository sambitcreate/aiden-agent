// Background first-turn chat title generation. This is intentionally separate
// from the interactive Agent: it makes one small, tool-free model request and
// never delays or fails the user's actual chat turn.

import { ipcMain, logger } from "../platform.js";
import { chatStore } from "./chat-store.js";
import {
  createChatTitleService,
  type ChatTitleModelSelection,
  type ChatTitleRenameResult,
} from "./chat-title-core.js";
import { configStore } from "./config-store.js";
import { foundationModelsConnection } from "./foundation-models-connection.js";
import { hostPlatformCapabilities } from "./host-platform-capabilities.js";
import { resolveModelRuntime } from "./model-runtime.js";
import { usageStore } from "./usage-store.js";

export type { ChatTitleModelSelection, ChatTitleRenameResult };

export const chatTitleService = createChatTitleService({
  chatStore,
  configStore,
  foundationModelsConnection,
  hostPlatformCapabilities,
  resolveModelRuntime,
  usageStore,
  broadcastMetadataUpdated: (update) => ipcMain.broadcast("chats:metadata-updated", update),
  logWarn: (message, details) => logger.warn("chat-title", message, details),
});
