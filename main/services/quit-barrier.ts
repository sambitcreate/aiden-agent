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
  // BrowserWindow.webContents becomes an invalid native getter as soon as the
  // `closed` event fires. Retain the EventEmitter object before closing and
  // never dereference the destroyed BrowserWindow during listener cleanup.
  const webContents = window.webContents;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      try {
        window.removeListener("closed", didClose);
      } catch {
        // A real BrowserWindow can reject method access after destruction.
      }
      try {
        webContents.removeListener("will-prevent-unload", didPreventUnload);
      } catch {
        // The close event is already authoritative; cleanup stays best effort.
      }
      resolve(closed);
    };
    const didClose = () => finish(true);
    const didPreventUnload = () => finish(false);
    window.once("closed", didClose);
    webContents.once("will-prevent-unload", didPreventUnload);
    try {
      window.close();
    } catch {
      finish(false);
    }
  });
}
