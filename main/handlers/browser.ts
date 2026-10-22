import { shell } from "electron";
import { ipcMain } from "../platform.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { browserService } from "../services/browser/service.js";
import { botIdForBrowserWorkspace } from "../services/browser/bot-workspaces.js";
import { configStore } from "../services/config-store.js";
import { externalUrl } from "../services/browser/core.js";
import { resolveExternalWorkspaceDocument } from "../services/browser/external-document.js";
import type { BrowserCommand } from "../../renderer/shared/browser.js";

export function registerBrowserHandlers(): void {
  ipcMain.handle("browser:get-state", async (event, workspaceId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Browser access requires the active application document."),
    );
    if (typeof workspaceId !== "string" || !workspaceId)
      throw new Error("A valid workspace is required for the browser.");
    // A Bot's managed workspace is admitted once main registered it, and its
    // browser moves to whichever window now shows that Bot.
    if (botIdForBrowserWorkspace(workspaceId) !== undefined) {
      browserService.transferOwner(workspaceId, owner);
      return browserService.getState(workspaceId);
    }
    if (!(await configStore.getWorkspace(workspaceId)))
      throw new Error("A valid workspace is required for the browser.");
    browserService.attachOwner(workspaceId, owner);
    return browserService.getState(workspaceId);
  });
  ipcMain.handle("browser:command", async (event, workspaceId: unknown, command: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Browser access requires the active application document."),
    );
    if (typeof workspaceId !== "string" || !workspaceId)
      throw new Error("A valid workspace is required for the browser.");
    const lifecycle = new AbortController();
    const cleanup = owner.onInvalidated(() =>
      lifecycle.abort(new Error("The browser's application document changed.")),
    );
    try {
      return await browserService.command(workspaceId, command as BrowserCommand, {
        owner,
        signal: lifecycle.signal,
        source: "user",
      });
    } finally {
      cleanup();
    }
  });
  ipcMain.handle("browser:link-preference", (event) => {
    rendererDocumentOwner(event, () => new Error("Link settings require the active application document."));
    return browserService.linkOpening();
  });
  ipcMain.handle("browser:set-link-preference", (event, value: unknown) => {
    rendererDocumentOwner(event, () => new Error("Link settings require the active application document."));
    return browserService.setLinkOpening(value);
  });
  ipcMain.handle("browser:open-external", async (event, value: unknown) => {
    rendererDocumentOwner(event, () => new Error("Opening links requires the active application document."));
    await shell.openExternal(externalUrl(value));
  });
  // A chat file link's "Open in system browser": a workspace HTML or PDF file
  // handed to the default app for its type.
  ipcMain.handle("browser:open-file-external", async (event, workspaceId: unknown, filePath: unknown) => {
    rendererDocumentOwner(event, () => new Error("Opening files requires the active application document."));
    const workspace = typeof workspaceId === "string" ? await configStore.getWorkspace(workspaceId) : undefined;
    if (!workspace?.folderPath || workspace.permission === "none")
      throw new Error("Workspace file access is not available.");
    if (typeof filePath !== "string") throw new Error("A document path is required.");
    const failure = await shell.openPath(await resolveExternalWorkspaceDocument(workspace.folderPath, filePath));
    if (failure) throw new Error(failure);
  });
}
