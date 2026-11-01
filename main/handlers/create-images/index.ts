import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "../../platform.js";
import { IMAGE_EXTENSIONS } from "../../services/create-images/image-export.js";
import { createImagesRuntime } from "../../services/create-images/main.js";
import { rendererDocumentOwner } from "../../services/renderer-document-owner.js";
import { createImagesEnabled } from "../../services/studio/feature-flags.js";
import { studioAssetGrants } from "../../services/studio-assets/main.js";
import { readPickedImage, registerCreateImagesHandlers } from "./register.js";

const DRAG_ICON_EDGE = 64;
/** A 1×1 transparent PNG: startDrag needs a non-empty icon even when the image itself can't be decoded. */
const FALLBACK_DRAG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function parentWindow(event: Electron.IpcMainInvokeEvent): Electron.BrowserWindow | null {
  const parent = BrowserWindow.fromWebContents(event.sender);
  return parent && !parent.isDestroyed() ? parent : null;
}

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
    files: {
      chooseSavePath: async (event, { defaultPath, mediaType }) => {
        const parent = parentWindow(event);
        const extension = IMAGE_EXTENSIONS[mediaType];
        const options: Electron.SaveDialogOptions = {
          title: "Save image",
          defaultPath,
          filters: [{ name: extension.toUpperCase(), extensions: extension === "jpg" ? ["jpg", "jpeg"] : [extension] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        };
        const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath ? null : result.filePath;
      },
      chooseFolder: async (event, { defaultPath }) => {
        const parent = parentWindow(event);
        const options: Electron.OpenDialogOptions = {
          title: "Save images to folder",
          defaultPath,
          buttonLabel: "Save",
          properties: ["openDirectory", "createDirectory"],
        };
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      copyImage: (bytes) => {
        const image = nativeImage.createFromBuffer(Buffer.from(bytes));
        if (image.isEmpty()) return false;
        clipboard.writeImage(image);
        return true;
      },
      showItemInFolder: (file) => shell.showItemInFolder(file),
      openFolder: async (folder) => {
        const failure = await shell.openPath(folder);
        if (failure) throw new Error(failure);
      },
      startDrag: (event, file) => {
        const image = nativeImage.createFromPath(file);
        const icon = image.isEmpty()
          ? nativeImage.createFromDataURL(FALLBACK_DRAG_ICON)
          : image.resize(image.getSize().width >= image.getSize().height ? { width: DRAG_ICON_EDGE } : { height: DRAG_ICON_EDGE });
        event.sender.startDrag({ file, icon });
      },
    },
  });
}
