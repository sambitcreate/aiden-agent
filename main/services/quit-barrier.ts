export interface RendererQuitWindow {
  isDestroyed(): boolean;
  close(): void;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  webContents: {
    once(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
  };
}

/** Resolve true only after the renderer can no longer veto or issue IPC. */
export function closeRendererBeforeShutdown(window: RendererQuitWindow): Promise<boolean> {
  if (window.isDestroyed()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      window.removeListener("closed", didClose);
      window.webContents.removeListener("will-prevent-unload", didPreventUnload);
      resolve(closed);
    };
    const didClose = () => finish(true);
    const didPreventUnload = () => finish(false);
    window.once("closed", didClose);
    window.webContents.once("will-prevent-unload", didPreventUnload);
    try {
      window.close();
    } catch {
      finish(false);
    }
  });
}
