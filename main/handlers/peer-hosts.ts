import { ipcMain } from "../platform.js";
import { hostIdentifier } from "../../renderer/shared/peer-host.js";
import { getPeerHostRegistry } from "../services/peer-host-service-main.js";
import { parsePeerPairing, peerText } from "../services/peer-pairing.js";
import {
  peerOperationRequest,
  peerOperationResult,
} from "../services/peer-operation.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";

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
  ipcMain.handle(
    "remote:peersSetEnabled",
    async (_event, id: unknown, enabled: unknown) => {
      if (typeof enabled !== "boolean")
        throw new Error("Invalid connection state.");
      await getPeerHostRegistry().setEnabled(hostIdentifier(id), enabled);
    },
  );
  ipcMain.handle("remote:peersRemove", async (_event, id: unknown) => {
    await getPeerHostRegistry().remove(hostIdentifier(id));
  });
  ipcMain.handle(
    "remote:peerOperation",
    async (event, id: unknown, operation: unknown) => {
      const owner = rendererDocumentOwner(
        event,
        () =>
          new Error("Device actions require an active application document."),
      );
      const controller = new AbortController();
      const detach = owner.onInvalidated(() => controller.abort());
      try {
        if (owner.isDestroyed())
          throw new Error("The application document changed.");
        const result = await getPeerHostRegistry().request(hostIdentifier(id), {
          ...peerOperationRequest(operation),
          signal: controller.signal,
        });
        if (owner.isDestroyed())
          throw new Error("The application document changed.");
        return peerOperationResult(operation, result);
      } finally {
        detach();
      }
    },
  );
}
