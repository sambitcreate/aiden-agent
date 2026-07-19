// Electron runtime binding for the otherwise platform-independent chat store.

import { createChatStore } from "./chat-store-core.js";
import { ensureUserDataDir } from "./data-store.js";

export const chatStore = createChatStore(() => ensureUserDataDir("chats"));
