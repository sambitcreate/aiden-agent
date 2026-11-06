// The DevTools protocol on the Live owner's own window, through Electron's
// `webContents.debugger`. Nothing else in Aiden attaches a debugger to the
// main window (the in-app browser attaches to its own tab views), so a
// debugger that is already attached and not ours means DevTools or another
// inspector: Live reports that with a fixed error instead of taking it over.

import { webContents } from "electron";
import type { RendererDocumentOwner } from "../../renderer-document-owner.js";
import { AidenWindowInspectedError, type AidenWindowPort } from "./provider.js";

export function createElectronAidenWindowPort(owner: RendererDocumentOwner): AidenWindowPort | null {
  const contents = webContents.fromId(owner.id);
  if (!contents || contents.isDestroyed()) return null;
  const debuggerApi = contents.debugger;
  let ours = false;
  let closed = false;
  const onDetach = () => {
    ours = false;
  };
  debuggerApi.on("detach", onDetach);
  const ensureAttached = () => {
    if (closed || contents.isDestroyed()) throw new Error("Aiden's window is gone.");
    if (ours && debuggerApi.isAttached()) return;
    if (debuggerApi.isAttached()) throw new AidenWindowInspectedError();
    try {
      debuggerApi.attach("1.3");
      ours = true;
    } catch {
      throw new AidenWindowInspectedError();
    }
  };
  return {
    async call(method, params) {
      ensureAttached();
      return debuggerApi.sendCommand(method, params);
    },
    onNavigate(listener) {
      const navigated = () => listener();
      contents.on("did-navigate", navigated);
      contents.on("did-navigate-in-page", navigated);
      return () => {
        if (contents.isDestroyed()) return;
        contents.removeListener("did-navigate", navigated);
        contents.removeListener("did-navigate-in-page", navigated);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      if (contents.isDestroyed()) return;
      debuggerApi.removeListener("detach", onDetach);
      if (ours && debuggerApi.isAttached()) {
        try {
          debuggerApi.detach();
        } catch {
          // Already detached by the window closing.
        }
      }
      ours = false;
    },
  };
}
