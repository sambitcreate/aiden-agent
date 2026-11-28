import type { IpcMainInvokeEvent } from "electron";
import { captureIpcHandlers, ipcMain } from "../platform.js";
import {
  createLazyIpcGroup,
  type AnyInvokeChannel,
  type LazyIpcGroup as CoreLazyIpcGroup,
} from "./lazy-ipc-core.js";

export type { AnyInvokeChannel };
export type LazyIpcGroup = CoreLazyIpcGroup<IpcMainInvokeEvent>;

/**
 * Registers all `channels` synchronously on `ipcMain` (before startup IPC
 * admission opens) while deferring module `import()` evaluation until the
 * first invoke of any channel in the group.
 */
export function registerLazyIpcGroup(
  name: string,
  channels: readonly AnyInvokeChannel[],
  loadRegistrar: () => Promise<() => void>,
): LazyIpcGroup {
  return createLazyIpcGroup<IpcMainInvokeEvent>(
    {
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      capture: captureIpcHandlers,
    },
    name,
    channels,
    loadRegistrar,
  );
}
