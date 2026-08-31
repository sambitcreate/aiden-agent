import { ipcMain } from "../platform.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { workspaceEnvironmentApplicationService } from "../services/workspace-environment-application-service-main.js";
import {
  admitOwnedWorkspaceOperation,
  workspaceOperationRegistry,
} from "../services/workspace-operation-registry.js";
import { workspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { sourceDesignPreviewService } from "../services/source-design-preview.js";
import { sourceDesignerActionService } from "../services/source-designer-actions.js";
import { parseSourceElementDescriptor } from "../../renderer/shared/source-designer.js";

function string(value: unknown, label: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function ownerFor(event: Electron.IpcMainInvokeEvent) {
  return rendererDocumentOwner(
    event,
    () => new Error("Designer access requires the active renderer document."),
  );
}

export function registerDesignerHandlers(): void {
  ipcMain.handle("designer:previewState", async (event, workspaceIdValue: unknown) => {
    const owner = ownerFor(event);
    const workspaceId = string(workspaceIdValue, "workspace id", 128);
    return workspaceEnvironmentApplicationService.run(owner, workspaceId, (resolved) =>
      sourceDesignPreviewService.state(owner, workspaceId, resolved.folderPath),
    );
  });

  ipcMain.handle(
    "designer:startPreview",
    async (event, workspaceIdValue: unknown, scriptIdValue: unknown) => {
      const owner = ownerFor(event);
      const workspaceId = string(workspaceIdValue, "workspace id", 128);
      const scriptId = string(scriptIdValue, "preview script", 120);
      if (workspaceMutationGate.isChanging(workspaceId)) {
        throw new Error("The workspace is changing. Try again in a moment.");
      }
      const resolved = await workspaceEnvironmentApplicationService.resolve(workspaceId, true);
      if (!resolved) throw new Error("The workspace folder is unavailable.");
      const admission = admitOwnedWorkspaceOperation(workspaceOperationRegistry, owner, workspaceId);
      if (
        owner.isDestroyed() ||
        admission.signal.aborted ||
        workspaceMutationGate.isChanging(workspaceId)
      ) {
        admission.release();
        throw new Error("The workspace changed before the preview could start.");
      }
      return sourceDesignPreviewService.start({
        owner,
        admission,
        workspaceId,
        root: resolved.folderPath,
        scriptId,
      });
    },
  );

  ipcMain.handle("designer:stopPreview", async (event, workspaceIdValue: unknown) => {
    const owner = ownerFor(event);
    await sourceDesignPreviewService.stop(
      owner,
      string(workspaceIdValue, "workspace id", 128),
    );
  });

  ipcMain.handle(
    "designer:bindSelection",
    async (
      event,
      workspaceIdValue: unknown,
      sessionIdValue: unknown,
      descriptorValue: unknown,
    ) => {
      const owner = ownerFor(event);
      const workspaceId = string(workspaceIdValue, "workspace id", 128);
      const descriptor = parseSourceElementDescriptor(descriptorValue);
      if (!descriptor) throw new Error("The selected element context is invalid.");
      return workspaceEnvironmentApplicationService.run(owner, workspaceId, () =>
        sourceDesignerActionService.bind(
          owner,
          workspaceId,
          string(sessionIdValue, "preview session"),
          descriptor,
        ),
      );
    },
  );

  ipcMain.handle(
    "designer:listActions",
    async (event, chatIdValue: unknown, workspaceIdValue: unknown) => {
      const owner = ownerFor(event);
      return sourceDesignerActionService.list(
        owner,
        string(chatIdValue, "chat id"),
        string(workspaceIdValue, "workspace id", 128),
      );
    },
  );

  ipcMain.handle(
    "designer:applyAction",
    async (event, workspaceIdValue: unknown, actionIdValue: unknown) => {
      const owner = ownerFor(event);
      const workspaceId = string(workspaceIdValue, "workspace id", 128);
      const actionId = string(actionIdValue, "Designer Action");
      return workspaceEnvironmentApplicationService.run(owner, workspaceId, (resolved, signal) =>
        sourceDesignerActionService.apply(owner, actionId, resolved.folderPath, signal),
      );
    },
  );

  ipcMain.handle("designer:rejectAction", async (event, actionIdValue: unknown) =>
    sourceDesignerActionService.reject(
      ownerFor(event),
      string(actionIdValue, "Designer Action"),
    ),
  );

  ipcMain.handle(
    "designer:undoAction",
    async (event, workspaceIdValue: unknown, actionIdValue: unknown) => {
      const owner = ownerFor(event);
      const workspaceId = string(workspaceIdValue, "workspace id", 128);
      const actionId = string(actionIdValue, "Designer Action");
      return workspaceEnvironmentApplicationService.run(owner, workspaceId, (resolved, signal) =>
        sourceDesignerActionService.undo(owner, actionId, resolved.folderPath, signal),
      );
    },
  );
}
