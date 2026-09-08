import { ipcMain } from "../platform.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { browserService } from "../services/browser/service.js";
import { configStore } from "../services/config-store.js";
import type { BrowserCommand } from "../../renderer/shared/browser.js";

export function registerBrowserHandlers(): void {
  ipcMain.handle("browser:get-state", async (event, workspaceId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("Browser access requires the active application document."),
    );
    if (typeof workspaceId !== "string" || !(await configStore.getWorkspace(workspaceId)))
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
}
