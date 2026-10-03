import { ipcMain } from "../platform.js";
import { getPeerHostManager } from "../services/peer-host-manager-main.js";
import { getPeerHostRegistry } from "../services/peer-host-service-main.js";
import { parsePeerPairing, peerText } from "../services/peer-pairing.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { registerPeerHostLiveHandlers } from "./peer-host-live.js";

export function registerPeerHostHandlers(): void {
  ipcMain.handle("remote:peersList", () => getPeerHostRegistry().list());
  ipcMain.handle("remote:peersPair", async (event, payload: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Pairing requires an active application document."),
    );
    const pairing = parsePeerPairing(peerText(payload, 8192));
    if (owner.isDestroyed())
      throw new Error("The application document changed.");
    const controller = new AbortController();
    const detach = owner.onInvalidated(() => controller.abort());
    try {
      return await getPeerHostRegistry().pair(pairing, controller.signal);
    } finally {
      detach();
    }
  });
  registerPeerHostLiveHandlers<Electron.IpcMainInvokeEvent>({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    owner: (event) => {
      const owner = rendererDocumentOwner(
        event,
        () =>
          new Error("Device actions require an active application document."),
      );
      return {
        key: `${owner.id}:${owner.documentId}`,
        isDestroyed: owner.isDestroyed,
        onInvalidated: owner.onInvalidated,
      };
    },
    manager: getPeerHostManager,
  });
}
