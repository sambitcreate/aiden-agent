import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import {
  CREATE_IMAGES_MAX_DROPPED_FILES,
  type CreateImagesDroppedAssetImportResult,
} from "./shared/create-images/ipc.js";
import {
  INVOKE_PREFIXES,
  NATIVE_INVOKE_CHANNELS,
  NOTIFICATION_CHANNELS,
} from "./preload-channels.js";
import { createAttachmentPreloadBridge } from "./preload-attachments.js";

// Re-exported so the contract test can assert coverage without importing this
// Electron-bound module.
export { INVOKE_PREFIXES, NATIVE_INVOKE_CHANNELS, NOTIFICATION_CHANNELS };

export interface NativeThemeInfo {
  themeSource: "system" | "light" | "dark";
  shouldUseDarkColors: boolean;
  shouldUseHighContrastColors?: boolean;
  shouldUseInvertedColorScheme?: boolean;
}

type NotificationHandler = (payload: unknown) => void;

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
      ipcRenderer.invoke(
        NATIVE_INVOKE_CHANNELS.dialogOpen,
        options,
      ) as Promise<OpenDialogReturnValue>,
  },
  createImages: {
    importDroppedFiles: (
      workflowId: string,
      files: readonly File[],
    ): Promise<CreateImagesDroppedAssetImportResult> => {
      if (
        !Array.isArray(files) ||
        files.length < 1 ||
        files.length > CREATE_IMAGES_MAX_DROPPED_FILES
      ) {
        return Promise.resolve({
          status: "unavailable",
          message: `Drop between 1 and ${CREATE_IMAGES_MAX_DROPPED_FILES} images at a time.`,
        });
      }
      const filePaths: string[] = [];
      try {
        for (const file of files) {
          const filePath = webUtils.getPathForFile(file);
          if (!filePath) throw new Error("Dropped file has no native path.");
          filePaths.push(filePath);
        }
      } catch {
        return Promise.resolve({
          status: "unavailable",
          message: "Aiden could not access the dropped files.",
        });
      }
      return ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.createImagesImportDroppedFiles, {
        workflowId,
        filePaths,
      }) as Promise<CreateImagesDroppedAssetImportResult>;
    },
  },
  attachments: createAttachmentPreloadBridge({
    invoke: <T>(channel: string, ...args: unknown[]) =>
      ipcRenderer.invoke(channel, ...args) as Promise<T>,
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  }),
  nativeTheme: {
    getInfo: (): Promise<NativeThemeInfo> =>
      ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.themeGet) as Promise<NativeThemeInfo>,
    setThemeSource: (source: "system" | "light" | "dark"): Promise<boolean> =>
      ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.themeSet, source) as Promise<boolean>,
    onChanged: (callback: (info: NativeThemeInfo) => void): (() => void) =>
      subscribe("aiden:theme:changed", (payload) => callback(payload as NativeThemeInfo)),
  },
  systemPreferences: {
    getMediaAccessStatus: (mediaType: "microphone" | "camera" | "screen"): Promise<string> =>
      ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.mediaStatus, mediaType) as Promise<string>,
    askForMediaAccess: (mediaType: "microphone" | "camera"): Promise<boolean> =>
      ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.mediaRequest, mediaType) as Promise<boolean>,
  },
  accessibility: {
    isTrusted: (): Promise<boolean> =>
      ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.accessibilityStatus) as Promise<boolean>,
    request: (): Promise<boolean> =>
      ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.accessibilityRequest) as Promise<boolean>,
  },
};

contextBridge.exposeInMainWorld("aidenAPI", aidenAPI);

export type AidenAPI = typeof aidenAPI;
