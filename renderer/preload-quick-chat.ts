// Least-privilege preload bridge for the Floating Chat Starter (Quick Chat)
// BrowserWindow. Never exposes terminal, remote, bot, accessibility, screen
// capture, or arbitrary native dialog APIs.

import { contextBridge, webUtils } from "electron";
import { ipcRendererTransport } from "./preload-ipc-transport.js";
import { createQuickChatPreloadApi } from "./quick-chat-preload-core.js";

const api = createQuickChatPreloadApi({
  ...ipcRendererTransport,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});

contextBridge.exposeInMainWorld("aidenAPI", api);
