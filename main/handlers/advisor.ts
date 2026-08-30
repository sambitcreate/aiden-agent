import { ipcMain } from "../platform.js";
import { advisorRuntime } from "../services/advisor-runtime-main.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";

function activeAdvisorOwner(event: Electron.IpcMainInvokeEvent) {
  return rendererDocumentOwner(
    event,
    () => new Error("Advisor settings require the active application document."),
  );
}

export function registerAdvisorHandlers(): void {
  // Reconcile prepared/dispatched no-replay evidence during main startup,
  // before any chat can expose the optional extension.
  void advisorRuntime.initialize().catch(() => undefined);

  ipcMain.handle("advisor:get", async (event) => {
    const owner = activeAdvisorOwner(event);
    try {
      const configuration = await advisorRuntime.configuration();
      if (owner.isDestroyed()) {
        throw new Error("The renderer document is no longer active.");
      }
      return configuration;
    } catch {
      throw new Error("Aiden could not read the local advisor selection.");
    }
  });

  ipcMain.handle("advisor:set", async (event, selection: unknown) => {
    const owner = activeAdvisorOwner(event);
    try {
      return await advisorRuntime.setSelection(selection, () => {
        if (owner.isDestroyed()) {
          throw new Error("The renderer document is no longer active.");
        }
      });
    } catch {
      // Provider/auth failures can carry implementation detail. Keep the IPC
      // contract closed while the main-process diagnostic path retains detail.
      throw new Error("Aiden could not validate or save that advisor selection.");
    }
  });
}
