import { contextBridge, ipcRenderer } from "electron";
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";

export interface NativeThemeInfo {
  themeSource: "system" | "light" | "dark";
  shouldUseDarkColors: boolean;
  shouldUseHighContrastColors?: boolean;
  shouldUseInvertedColorScheme?: boolean;
}

type NotificationHandler = (payload: unknown) => void;

const INVOKE_PREFIXES = [
  "app:",
  "attachments:",
  "chat:",
  "chats:",
  "exa:",
  "git:",
  "localModels:",
  "localVoice:",
  "mcp:",
  "models:",
  "providers:",
  "settings:",
  "shortcut:",
  "skills:",
  "terminal:",
  "voice:",
  "workspaces:",
] as const;

const NOTIFICATION_CHANNELS = new Set([
  "app:dictate-toggle",
  "app:focus-composer",
  "app:navigate",
  "chat:approval",
  "chat:delta",
  "chat:done",
  "chat:error",
  "chat:tool",
  "chats:metadata-updated",
  "localModels:progress",
  "terminal:data",
  "terminal:exit",
  "aiden:theme:changed",
]);

function assertInvokeChannel(channel: string): void {
  if (!INVOKE_PREFIXES.some((prefix) => channel.startsWith(prefix))) {
    throw new Error(`IPC channel is not available to the renderer: ${channel}`);
  }
}

function subscribe(channel: string, callback: NotificationHandler): () => void {
  if (!NOTIFICATION_CHANNELS.has(channel)) {
    throw new Error(`Notification channel is not available to the renderer: ${channel}`);
  }
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const aidenAPI = {
  ipc: {
    invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
      assertInvokeChannel(channel);
      return ipcRenderer.invoke(channel, ...args) as Promise<T>;
    },
    onNotification: subscribe,
  },
  dialog: {
    showOpenDialog: (options?: OpenDialogOptions): Promise<OpenDialogReturnValue> =>
      ipcRenderer.invoke("aiden:dialog:open", options) as Promise<OpenDialogReturnValue>,
  },
  nativeTheme: {
    getInfo: (): Promise<NativeThemeInfo> => ipcRenderer.invoke("aiden:theme:get") as Promise<NativeThemeInfo>,
    setThemeSource: (source: "system" | "light" | "dark"): Promise<boolean> =>
      ipcRenderer.invoke("aiden:theme:set", source) as Promise<boolean>,
    onChanged: (callback: (info: NativeThemeInfo) => void): (() => void) =>
      subscribe("aiden:theme:changed", (payload) => callback(payload as NativeThemeInfo)),
  },
  systemPreferences: {
    getMediaAccessStatus: (mediaType: "microphone" | "camera" | "screen"): Promise<string> =>
      ipcRenderer.invoke("aiden:media:status", mediaType) as Promise<string>,
    askForMediaAccess: (mediaType: "microphone" | "camera"): Promise<boolean> =>
      ipcRenderer.invoke("aiden:media:request", mediaType) as Promise<boolean>,
  },
};

contextBridge.exposeInMainWorld("aidenAPI", aidenAPI);

export type AidenAPI = typeof aidenAPI;
