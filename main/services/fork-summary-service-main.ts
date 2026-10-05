import { ipcMain, logger } from "../platform.js";
import { chatStore } from "./chat-store.js";
import { configStore } from "./config-store.js";
import { ForkSummaryService } from "./fork-summary-service.js";
import { resolveModelRuntime } from "./model-runtime.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import { assistantUsageRecord } from "./usage-accounting.js";
import { usageStore } from "./usage-store.js";
import type { ChatForkSummaryChanged } from "../../renderer/shared/chat-copy-contract.js";

export const forkSummaryService = new ForkSummaryService({
  getChat: (chatId) => chatStore.get(chatId),
  updateForkSummary: (chatId, next) => chatStore.updateForkSummary(chatId, next),
  journalEntriesAfter: (chatId, messageId) =>
    piCompactionSessionStore.journalEntriesAfter(chatId, messageId),
  skillsEnabled: async () => (await configStore.getSettings()).skillsEnabled !== false,
  resolveRuntime: resolveModelRuntime,
  recordUsage: (message, runtime) =>
    usageStore.record(
      assistantUsageRecord({
        message,
        provider: runtime.provider,
        model: runtime.model,
        source: "compaction",
      }),
    ),
  published: (chat) => {
    const update: ChatForkSummaryChanged = {
      chatId: chat.id,
      ...(chat.forkedFrom ? { forkedFrom: chat.forkedFrom } : {}),
    };
    ipcMain.broadcast("chats:fork-summary-changed", update);
  },
  reportFailure: (error) => {
    logger.warn("chat", "A fork summary could not be settled.", {
      error: error instanceof Error ? error.message : String(error),
    });
  },
});

/**
 * Summaries cannot outlive the process, so a fork made before this one started
 * whose summary is still pending was interrupted.
 */
export function initializeForkSummaries(): void {
  const processStartedAt = Date.now();
  void (async () => {
    for (const meta of await chatStore.list()) {
      const lineage = meta.forkedFrom;
      if (lineage?.summary?.state === "pending" && lineage.at < processStartedAt) {
        await forkSummaryService.settleInterrupted(meta.id);
      }
    }
  })().catch((error) => {
    logger.warn("chat", "Interrupted fork summary recovery failed during startup.", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
