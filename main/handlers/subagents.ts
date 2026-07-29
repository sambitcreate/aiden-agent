import { ipcMain, logger } from "../platform.js";
import { chatStore } from "../services/chat-store.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  parseSubagentHistoryRequestIds,
  readSubagentHistoryForOwner,
} from "../services/subagents/subagent-history-read-core.js";
import { assertSubagentHistoryEnabled } from "../services/subagents/feature-flag.js";
import { subagentRunStore } from "../services/subagents/subagent-run-store.js";

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
      return await readSubagentHistoryForOwner(owner, chatId, runId, {
        getChat: (id) => chatStore.get(id),
        getSnapshot: (id) => subagentRunStore.get(id),
      });
    } catch (error) {
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      logger.error("subagents", "Could not read private subagent history.", error);
      throw new Error("Aiden could not load subagent history.");
    }
  });
}
