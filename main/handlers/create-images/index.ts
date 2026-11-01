import { BrowserWindow, dialog, ipcMain } from "../../platform.js";
import { createImagesRuntime } from "../../services/create-images/main.js";
import { rendererDocumentOwner } from "../../services/renderer-document-owner.js";
import { createImagesEnabled } from "../../services/studio/feature-flags.js";
import { studioAssetGrants } from "../../services/studio-assets/main.js";
import { readPickedImage, registerCreateImagesHandlers } from "./register.js";

export function registerCreateImagesIpc(): void {
  registerCreateImagesHandlers<Electron.IpcMainInvokeEvent>({
    enabled: createImagesEnabled(),
    handle: (channel, listener) => ipcMain.handle(channel, (event, input: unknown) => listener(event, input)),
    owner: (event) => {
      const owner = rendererDocumentOwner(event, () => new Error("Images can only be used from the active Aiden window."));
      return { key: `${owner.id}:${owner.documentId}`, grants: owner };
    },
    services: () => createImagesRuntime.ready(),
    grants: studioAssetGrants,
    pickImage: async (event) => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
      };
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const file = result.canceled ? undefined : result.filePaths[0];
      if (!file) return null;
      return readPickedImage(file);
    },
  });
}
