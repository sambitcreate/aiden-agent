import { contextBridge, ipcRenderer } from "electron";
import { NATIVE_INVOKE_CHANNELS } from "./preload-channels.js";
import {
  ASSISTANT_INVOKE_CHANNELS,
  ASSISTANT_NOTIFICATION_CHANNELS,
} from "./preload-assistant-channels.js";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!ASSISTANT_INVOKE_CHANNELS.has(channel)) {
    throw new Error(`IPC channel is not available to the Aiden window: ${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function onNotification(channel: string, callback: (payload: unknown) => void): () => void {
  if (!ASSISTANT_NOTIFICATION_CHANNELS.has(channel)) {
    throw new Error(`Notification is not available to the Aiden window: ${channel}`);
  }
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("aidenAPI", {
  ipc: { invoke, onNotification },
  theme: {
    get: () => ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.themeGet),
  },
});
