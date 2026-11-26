// Least-privilege preload for the Bot bubble overlay window. Exposes only the
// `aidenAPI.ipc` shape the renderer's ipc-bridge uses, gated by the overlay's
// own allowlists.

import { contextBridge, ipcRenderer } from "electron";
import { createBotBubblesPreloadApi } from "./bot-bubbles-preload-core.js";

const api = createBotBubblesPreloadApi({
  invoke: <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>,
  onNotification: (channel: string, callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

contextBridge.exposeInMainWorld("aidenAPI", api);
