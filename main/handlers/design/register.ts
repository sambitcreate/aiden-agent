// Registers the designProjects:* channels. The bootstrap calls this only while the
// designStudio capability is on, so a disabled build exposes no Design channel.
import { ipcMain } from "../../platform.js";
import { chatGenerationOwner } from "../../services/chat-generation-owner.js";
import { designPreview, designProjectStore, designRunService } from "../../services/design/main.js";
import { rendererDocumentOwner } from "../../services/renderer-document-owner.js";
import { registerDesignProjectHandlers } from "./projects.js";
import { registerDesignRunHandlers } from "./run.js";

export function registerDesignHandlers(): void {
  const assertOwner = (event: Electron.IpcMainInvokeEvent): void => {
    rendererDocumentOwner(event, () => new Error("Design Studio must be used from the active application document."));
  };
  registerDesignProjectHandlers(ipcMain, { store: designProjectStore, assertOwner });
  registerDesignRunHandlers(ipcMain, {
    runs: designRunService,
    generationOwner: chatGenerationOwner,
    assertOwner,
    preview: designPreview,
    readSource: (projectId, revisionId) => designProjectStore.readRevision(projectId, revisionId),
  });
}
