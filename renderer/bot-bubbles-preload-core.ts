// Pure bridge builder for the Bot bubble overlay preload, so the runtime
// allowlists are checked by behavioural tests without Electron.

import { BOT_BUBBLES_INVOKE_CHANNELS, BOT_BUBBLES_NOTIFICATION_CHANNELS } from "./bot-bubbles-preload-channels.js";

export interface BotBubblesPreloadTransport {
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>;
  onNotification: (channel: string, callback: (payload: unknown) => void) => () => void;
}

export function createBotBubblesPreloadApi(transport: BotBubblesPreloadTransport) {
  function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    if (!BOT_BUBBLES_INVOKE_CHANNELS.has(channel)) {
      throw new Error(`IPC channel is not available to Bot bubbles: ${channel}`);
    }
    return transport.invoke<T>(channel, ...args);
  }

  function onNotification(channel: string, callback: (payload: unknown) => void): () => void {
    if (!BOT_BUBBLES_NOTIFICATION_CHANNELS.has(channel)) {
      throw new Error(`Notification is not available to Bot bubbles: ${channel}`);
    }
    return transport.onNotification(channel, callback);
  }

  return { ipc: { invoke, onNotification } };
}
