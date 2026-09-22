import { llmClient } from "../services/llm-client.js";
import { ipcMain } from "../platform.js";
import {
  formFillArtifacts,
  formFillRuntime,
} from "../services/form-fill/artifacts.js";
import {
  formFillSpecialistEnabled,
  setFormFillSpecialistEnabled,
} from "../services/form-fill/settings.js";
import {
  rendererDocumentOwner,
  type RendererDocumentOwner,
} from "../services/renderer-document-owner.js";

function requestOwner(
  event: Electron.IpcMainInvokeEvent,
): RendererDocumentOwner {
  return rendererDocumentOwner(
    event,
    () =>
      new Error("Form fill settings require the active application document."),
  );
}

export interface FormFillSettingsView {
  enabled: boolean;
  status: ReturnType<typeof formFillArtifacts.status>;
}

/**
 * Form Fill Specialist lifecycle IPC. Status reads stay local — `refresh()`
 * only verifies already-downloaded files and never contacts Hugging Face.
 */
export function registerFormFillHandlers(): void {
  ipcMain.handle("formFill:status", async (event) => {
    requestOwner(event);
    const status = await formFillArtifacts.refresh();
    return { enabled: await formFillSpecialistEnabled(), status };
  });

  ipcMain.handle("formFill:setEnabled", async (event, enabled: unknown) => {
    if (typeof enabled !== "boolean")
      throw new Error("Invalid form fill setting.");
    const owner = requestOwner(event);
    await setFormFillSpecialistEnabled(enabled);
    if (owner.isDestroyed())
      throw new Error("The renderer document is no longer active.");
    return { enabled, status: await formFillArtifacts.refresh() };
  });

  ipcMain.handle("formFill:download", async (event) => {
    const owner = requestOwner(event);
    const unsubscribe = owner.onInvalidated(() => formFillArtifacts.cancel());
    try {
      if (owner.isDestroyed())
        throw new Error("The renderer document is no longer active.");
      await formFillArtifacts.download();
    } finally {
      unsubscribe();
    }
    return formFillArtifacts.status();
  });

  ipcMain.handle("formFill:cancel", async (event) => {
    requestOwner(event);
    formFillArtifacts.cancel();
    return formFillArtifacts.status();
  });

  ipcMain.handle("formFill:remove", async (event) => {
    requestOwner(event);
    llmClient.cancelComputerUseGenerations();
    await formFillArtifacts.remove(() => formFillRuntime.shutdown());
    return formFillArtifacts.status();
  });
}
