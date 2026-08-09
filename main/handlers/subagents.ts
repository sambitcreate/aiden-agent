import { ipcMain, logger } from "../platform.js";
import { chatStore } from "../services/chat-store.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  parseSubagentHistoryRequestIds,
  readSubagentHistoryDetailForOwner,
} from "../services/subagents/subagent-history-read-core.js";
import {
  assertSubagentHistoryEnabled,
  subagentV2Enabled,
} from "../services/subagents/feature-flag.js";
import { subagentRunStore } from "../services/subagents/subagent-run-store.js";
import { manageSubagentForDocumentV2 } from "../services/subagents/subagent-control-ipc-core.js";
import { subagentControlMainV2 } from "../services/subagents/subagent-control-main.js";

export function registerSubagentHandlers(): void {
  ipcMain.handle("subagents:get", async (event, chatIdValue: unknown, runIdValue: unknown) => {
    // This must precede owner/identifier resolution and every store read so a
    // disabled build cannot disclose whether any archived run exists.
    assertSubagentHistoryEnabled();
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Subagent history requires the active application document."),
    );
    const { chatId, runId } = parseSubagentHistoryRequestIds(chatIdValue, runIdValue);
    try {
      return await readSubagentHistoryDetailForOwner(owner, chatId, runId, {
        getChat: (id) => chatStore.get(id),
        getSnapshot: (id) => subagentRunStore.get(id),
        getEffectActivity: (id, owningChatId) =>
          subagentRunStore.listEffectActivityForRun(id, owningChatId),
      });
    } catch (error) {
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      logger.error("subagents", "Could not read private subagent history.", error);
      throw new Error("Aiden could not load subagent history.");
    }
  });

  ipcMain.handle("subagents:manage", async (event, chatIdValue: unknown, requestValue: unknown) => {
    if (!subagentV2Enabled()) throw new Error("Subagent controls are unavailable.");
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Subagent controls require the active application document."),
    );
    try {
      return await manageSubagentForDocumentV2(owner, chatIdValue, requestValue, {
        getChat: (id) => chatStore.get(id),
        execute: (scope, request) => subagentControlMainV2.executeForDocument(scope, request),
      });
    } catch (error) {
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      logger.error("subagents", "Could not manage private subagent control.", error);
      throw new Error("Aiden could not manage this subagent.");
    }
  });
}
