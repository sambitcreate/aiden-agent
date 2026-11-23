// Least-privilege preload bridge for the Floating Chat Starter (Quick Chat)
// BrowserWindow. Never exposes terminal, remote, bot, accessibility, screen
// capture, or arbitrary native dialog APIs.

import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createQuickChatPreloadApi } from "./quick-chat-preload-core.js";

const api = createQuickChatPreloadApi({
  invoke: <T>(channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>,
  onNotification: (channel: string, callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});

contextBridge.exposeInMainWorld("aidenAPI", api);
