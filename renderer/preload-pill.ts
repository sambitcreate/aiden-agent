import { contextBridge, ipcRenderer } from "electron";
import {
  NATIVE_INVOKE_CHANNELS,
} from "./preload-channels.js";
import {
  PILL_INVOKE_CHANNELS,
  PILL_NOTIFICATION_CHANNELS,
} from "./pill-preload-channels.js";
import { ipcRendererTransport } from "./preload-ipc-transport.js";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!PILL_INVOKE_CHANNELS.has(channel)) {
    throw new Error(`IPC channel is not available to the dictation pill: ${channel}`);
  }
  return ipcRendererTransport.invoke<T>(channel, ...args);
}

function onNotification(
  channel: string,
  callback: (payload: unknown) => void,
): () => void {
  if (!PILL_NOTIFICATION_CHANNELS.has(channel)) {
    throw new Error(`Notification is not available to the dictation pill: ${channel}`);
  }
  return ipcRendererTransport.onNotification(channel, callback);
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
