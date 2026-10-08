// Registers the designProjects:* channels against the app singletons. The gate in
// registration.ts makes this a no-op unless the designStudio capability is on.
import { ipcMain } from "../../platform.js";
import { chatGenerationOwner } from "../../services/chat-generation-owner.js";
import { designPreview, designProjectStore, designRunService } from "../../services/design/main.js";
import { rendererDocumentOwner } from "../../services/renderer-document-owner.js";
import { designStudioEnabled } from "../../services/studio/feature-flags.js";
import { registerDesignStudioHandlers } from "./registration.js";

export function registerDesignHandlers(): void {
  registerDesignStudioHandlers(designStudioEnabled(), ipcMain, () => {
    const assertOwner = (event: Electron.IpcMainInvokeEvent): void => {
      rendererDocumentOwner(event, () => new Error("Design Studio must be used from the active application document."));
    };
    return {
      projects: { store: designProjectStore, assertOwner },
      runs: {
        runs: designRunService,
        generationOwner: chatGenerationOwner,
        assertOwner,
        preview: designPreview,
        readSource: (projectId, revisionId) => designProjectStore.readRevision(projectId, revisionId),
      },
    };
  });
}
