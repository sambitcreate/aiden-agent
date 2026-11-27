import { ipcRenderer, type IpcRendererEvent } from "electron";

export const ipcRendererTransport = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>,
  onNotification: (channel: string, callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};
