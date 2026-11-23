// Pure, dependency-free runtime bridge builder for the Floating Chat Starter
// (Quick Chat) preload so runtime channel and media-type allowlists can be
// verified directly by behavioral tests without Electron.

import { NATIVE_INVOKE_CHANNELS } from "./preload-channels.js";
import { createAttachmentPreloadBridge } from "./preload-attachments.js";
import {
  QUICK_CHAT_INVOKE_CHANNELS,
  QUICK_CHAT_NOTIFICATION_CHANNELS,
} from "./quick-chat-preload-channels.js";

export interface QuickChatPreloadTransport {
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>;
  onNotification: (channel: string, callback: (payload: unknown) => void) => () => void;
  getPathForFile: (file: File) => string;
}

function assertMicrophoneMediaType(mediaType: unknown): "microphone" {
  if (mediaType !== "microphone") {
    throw new Error("Quick Chat may only access microphone permissions.");
  }
  return "microphone";
}

export function createQuickChatPreloadApi(transport: QuickChatPreloadTransport) {
  function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    if (!QUICK_CHAT_INVOKE_CHANNELS.has(channel)) {
      throw new Error(`IPC channel is not available to quick chat: ${channel}`);
    }
    return transport.invoke<T>(channel, ...args);
  }

  function onNotification(
    channel: string,
    callback: (payload: unknown) => void,
  ): () => void {
    if (!QUICK_CHAT_NOTIFICATION_CHANNELS.has(channel)) {
      throw new Error(`Notification is not available to quick chat: ${channel}`);
    }
    return transport.onNotification(channel, callback);
  }

  return {
    ipc: { invoke, onNotification },
    attachments: createAttachmentPreloadBridge({
      invoke: transport.invoke,
      getPathForFile: transport.getPathForFile,
    }),
    systemPreferences: {
      getMediaAccessStatus: (mediaType: "microphone"): Promise<string> =>
        transport.invoke<string>(
          NATIVE_INVOKE_CHANNELS.mediaStatus,
          assertMicrophoneMediaType(mediaType),
        ),
      askForMediaAccess: (mediaType: "microphone"): Promise<boolean> =>
        transport.invoke<boolean>(
          NATIVE_INVOKE_CHANNELS.mediaRequest,
          assertMicrophoneMediaType(mediaType),
        ),
    },
  };
}
