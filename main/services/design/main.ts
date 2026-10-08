// App-lifetime Design Studio singletons. Constructing them touches no disk: the store
// reads its root only when startDesignStudio() initializes it, and that happens only
// with the designStudio capability on.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { app, ipcMain, logger } from "../../platform.js";
import { chatApplicationService } from "../chat-application-service-main.js";
import { chatStore } from "../chat-store.js";
import { registerGenerativeUiPreviewDocument } from "../generative-ui-protocol.js";
import { llmClient } from "../llm-client.js";
import { piRuntimeEffectStore } from "../pi-runtime-effect-store.js";
import { createThrottledTrigger } from "../portable-config-watch-core.js";
import { createProjectChangeNotifier } from "./change-notifier.js";
import { createDesignChatPort } from "./chat-port.js";
import { wrapDesignRevision } from "./design-preview.js";
import { DesignRunService } from "./run-service.js";
import { DesignProjectStore } from "./store.js";

const CHANGE_THROTTLE_MS = 150;

/** Throttled per project: a burst of edits costs at most one broadcast per interval, plus a trailing one. */
const notifyProjectChanged = createProjectChangeNotifier({
  broadcast: (event) => ipcMain.broadcast("designProjects:changed", event),
  revisionOf: (projectId) => designProjectStore.get(projectId)?.revision,
  createTrigger: (run) => createThrottledTrigger(run, CHANGE_THROTTLE_MS),
});

const designChats = createDesignChatPort({
  chatStore,
  // chatApplicationService.remove is the crash-safe cascade for a chat.
  remove: (chatId) => chatApplicationService.remove(chatId),
});

export const designProjectStore = new DesignProjectStore({
  root: async () => path.join(app.getPath("userData"), "design-projects"),
  chats: designChats,
  onChanged: notifyProjectChanged,
  onError: (message, error) => logger.warn("design", message, error),
});

export const designRunService = new DesignRunService({
  store: designProjectStore,
  chats: designChats,
  effects: piRuntimeEffectStore,
  generation: {
    beginChatTurn: (chatId, turnId, ownerId) => llmClient.beginChatTurn(chatId, turnId, ownerId),
    start: (streamId, params, owner, options) => llmClient.start(streamId, params, owner, options),
  },
  notifyRunChanged: (event) => ipcMain.broadcast("designProjects:run-changed", event),
  newId: randomUUID,
  onError: (message, error) => logger.warn("design", message, error),
});

export function designPreview(input: {
  projectId: string;
  revisionId: string;
  theme?: unknown;
}): Promise<{ src: string; title: string }> {
  return wrapDesignRevision({ store: designProjectStore, register: registerGenerativeUiPreviewDocument }, input);
}
