import { ipcMain } from "../platform.js";
import { computerUseStatus } from "../services/computer-use/status.js";
import { computerUseSettings } from "../services/computer-use/settings.js";
import {
  computerUseSupported,
  unsupportedComputerUseStatus,
} from "../services/computer-use/platform.js";
import {
  rendererDocumentOwner,
  type RendererDocumentOwner,
} from "../services/renderer-document-owner.js";

function requestOwner(event: Electron.IpcMainInvokeEvent): RendererDocumentOwner {
  return rendererDocumentOwner(
    event,
    () => new Error("Computer Use settings require the active application document."),
  );
}

async function ownedStatusRequest<T>(
  event: Electron.IpcMainInvokeEvent,
  request: (owner: RendererDocumentOwner, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const owner = requestOwner(event);
  const controller = new AbortController();
  const removeInvalidation = owner.onInvalidated(() =>
    controller.abort(new Error("The renderer document is no longer active.")),
  );
  try {
    const result = await request(owner, controller.signal);
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    return result;
  } finally {
    removeInvalidation();
  }
}

export function registerComputerUseHandlers(): void {
  ipcMain.handle("computerUse:status", async (event, force: unknown) => {
    if (!computerUseSupported()) {
      requestOwner(event);
      return unsupportedComputerUseStatus();
    }
    return ownedStatusRequest(event, (_owner, signal) =>
      computerUseStatus.status({ force: force === true, signal }),
    );
  });

  ipcMain.handle("computerUse:setEnabled", async (event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid Computer Use setting.");
    if (!computerUseSupported()) {
      requestOwner(event);
      if (enabled) throw new Error("Computer Use is not available on this platform.");
      return unsupportedComputerUseStatus();
    }
    return ownedStatusRequest(event, async (owner, signal) => {
      await computerUseSettings.setEnabled(enabled, () => !owner.isDestroyed());
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      return computerUseStatus.status({ force: enabled, signal });
    });
  });

  ipcMain.handle("computerUse:requestPermissions", async (event) => {
    if (!computerUseSupported()) {
      requestOwner(event);
      return unsupportedComputerUseStatus();
    }
    return ownedStatusRequest(event, (_owner, signal) =>
      computerUseStatus.requestPermissions({ signal }),
    );
  });
}
