// Electron wiring for the Floating Chat Starter (Quick Chat) IPC handlers.

import type { IpcMainInvokeEvent } from "electron";
import { ipcMain, logger } from "../platform.js";
import { captureAnalyticsReporter } from "../services/analytics/analytics-report.js";
import { chatStore } from "../services/chat-store.js";
import { desktopHandoffTickets } from "../services/desktop-stream-handoff-main.js";
import { llmClient } from "../services/llm-client.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  assertQuickChatConversationAccess,
  hideQuickChat,
  isCurrentQuickChatEvent,
  notifyQuickChatHandoffComplete,
  resetQuickChatBlurSuppression,
  setQuickChatMode,
  suppressQuickChatBlurHide,
  toggleQuickChat,
} from "../windows/quick-chat-window.js";
import { registerQuickChatHandlersCore } from "./quick-chat-core.js";

export interface QuickChatHandlerDependencies {
  isMainWindow: (event: IpcMainInvokeEvent) => boolean;
  navigateMainWindow?: (path: string) => Promise<void>;
}

export function registerQuickChatHandlers(deps: QuickChatHandlerDependencies): void {
  registerQuickChatHandlersCore({
    isMainWindow: deps.isMainWindow,
    navigateMainWindow: deps.navigateMainWindow,
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    windowPort: {
      isCurrentQuickChatEvent,
      toggleQuickChat,
      hideQuickChat,
      setQuickChatMode,
      suppressQuickChatBlurHide,
      resetQuickChatBlurSuppression,
      notifyQuickChatHandoffComplete,
    },
    tickets: desktopHandoffTickets,
    resolveDocumentId: (event) =>
      rendererDocumentOwner(event, () => new Error("Untrusted quick chat expand sender."))
        .documentId,
    assertChatAccess: assertQuickChatConversationAccess,
    inspectChatExpansionState: async (chatId) => ({
      duringStream: llmClient.isChatBusy(chatId),
      wasEphemeral: (await chatStore.get(chatId))?.ephemeral === true,
    }),
    beginExpansionReport: () => {
      const report = captureAnalyticsReporter();
      return ({ duringStream, wasEphemeral }) =>
        report("floating_chat_expanded", {
          during_stream: duringStream,
          was_ephemeral: wasEphemeral,
        });
    },
    onWarning: (message, error) => logger.warn("quick-chat", message, error),
  });
}
