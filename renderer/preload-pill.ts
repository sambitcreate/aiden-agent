import { contextBridge, ipcRenderer } from "electron";
import {
  NATIVE_INVOKE_CHANNELS,
} from "./preload-channels.js";
import {
  PILL_INVOKE_CHANNELS,
  PILL_NOTIFICATION_CHANNELS,
} from "./pill-preload-channels.js";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!PILL_INVOKE_CHANNELS.has(channel)) {
    throw new Error(`IPC channel is not available to the dictation pill: ${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function onNotification(
  channel: string,
  callback: (payload: unknown) => void,
): () => void {
  if (!PILL_NOTIFICATION_CHANNELS.has(channel)) {
    throw new Error(`Notification is not available to the dictation pill: ${channel}`);
  }
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("aidenAPI", {
  ipc: { invoke, onNotification },
  systemPreferences: {
    getMediaAccessStatus: (mediaType: "microphone") =>
      ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.mediaStatus, mediaType),
    askForMediaAccess: (mediaType: "microphone") =>
      ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.mediaRequest, mediaType),
  },
});
