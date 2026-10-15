import { ipcMain } from "../platform.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { createChatForkService } from "./chat-fork-service.js";
import { chatStore } from "./chat-store.js";
import { configStore } from "./config-store.js";
import { writeDiagnosticEvent } from "./diagnostic-journal.js";
import { forkSummaryService } from "./fork-summary-service-main.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import { artifactRecoveryMessage, unresolvedGuiArtifactMessage } from "./gui-artifact-recovery.js";
import { llmClient } from "./llm-client.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";

/** Desktop forks, shared by the app window and paired Remote devices. */
export const chatForkService = createChatForkService({
  chatStore,
  beginChatCopy: (chatId) => llmClient.beginChatCopy(chatId),
  workspaceExists: async (workspaceId) => Boolean(await configStore.getWorkspace(workspaceId)),
  blockedReason: async (chatId) => {
    const unresolved = await unresolvedGuiArtifactMessage(chatId);
    return unresolved
      ? artifactRecoveryMessage(
          unresolved,
          "A previous visual artifact could not be recovered. Delete this chat to discard it before copying.",
        )
      : undefined;
  },
  htmlArtifacts: generativeUiArtifactStore,
  journal: piCompactionSessionStore,
  startSummary: (chatId) => {
    void forkSummaryService.run(chatId);
  },
  reportDegraded: () => {
    writeDiagnosticEvent({
      level: "warn",
      area: "chat",
      event: "chat-degraded",
      outcome: "degraded",
      code: "internal-error",
    });
  },
  published: (chat) => {
    ipcMain.broadcast("chats:metadata-updated", {
      chatId: chat.id,
      title: chat.title,
      workspaceId: persistedChatWorkspaceId(chat.workspaceId),
      updatedAt: chat.updatedAt,
    });
  },
});
