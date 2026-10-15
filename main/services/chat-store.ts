// Electron runtime binding for the otherwise platform-independent chat store.

import { createChatStore } from "./chat-store-core.js";
import { configStore } from "./config-store.js";
import { ensureUserDataDir } from "./data-store.js";
import { writeDiagnosticEvent } from "./diagnostic-journal.js";

export const chatStore = createChatStore(
  () => ensureUserDataDir("chats"),
  (providerId) => configStore.resolveProviderId(providerId),
  {
    onQuarantine: () => {
      writeDiagnosticEvent({
        level: "warn",
        area: "chat",
        event: "chat-degraded",
        outcome: "recovered",
        code: "corrupt-data",
        fields: { storeClass: "chat" },
      });
    },
  },
);
