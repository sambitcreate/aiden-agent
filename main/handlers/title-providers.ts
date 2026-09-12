import { ipcMain } from "../platform.js";
import { foundationModelsConnection } from "../services/foundation-models-connection.js";
import { hostPlatformCapabilities } from "../services/host-platform-capabilities.js";

export function registerTitleProviderHandlers(): void {
  ipcMain.handle("titleProviders:status", async () => {
    if (!hostPlatformCapabilities().appleFoundationModels) return null;
    return foundationModelsConnection.status();
  });
  ipcMain.handle("titleProviders:refresh", async () => {
    if (!hostPlatformCapabilities().appleFoundationModels) return null;
    return foundationModelsConnection.status({ force: true });
  });
}
