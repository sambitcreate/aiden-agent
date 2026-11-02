import { ipcMain, logger } from "../platform.js";
import { chatActivityRegistry } from "../services/chat-activity.js";
import { readInterruptedRunWaits } from "../services/chat-pending-attention.js";
import { detachedPromptLog } from "../services/chat-pending-attention-main.js";
import { chatStore } from "../services/chat-store.js";
import { hostRunRegistry } from "../services/host-runs-main.js";
import { interruptedWaits } from "../services/interrupted-waits-main.js";
import { piRuntimeEffectStore } from "../services/pi-runtime-effect-store.js";
import { registerChatPendingAttentionHandlers } from "./chat-pending-attention.js";

export function registerChatPendingAttentionIpc(): void {
  registerChatPendingAttentionHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    runs: hostRunRegistry,
    detached: detachedPromptLog,
    knownChatIds: async (ids) => {
      const wanted = new Set(ids);
      const known = new Set<string>();
      for (const chat of await chatStore.listSummaryMetadata()) {
        if (wanted.has(chat.id)) known.add(chat.id);
      }
      return known;
    },
    interruptedWaits: (chatIds) =>
      readInterruptedRunWaits(chatIds, {
        waits: interruptedWaits,
        operations: piRuntimeEffectStore,
        onError: (error) => logger.warn("chats", "Could not read interrupted waits for the Inbox.", error),
      }),
    // A new activity revision reaches the Dock badge and the Inbox's waits query.
    onChange: () => chatActivityRegistry.touch(),
  });
}
