import { ipcMain } from "../platform.js";
import { foundationModelsConnection } from "../services/foundation-models-connection.js";

export function registerTitleProviderHandlers(): void {
  ipcMain.handle("titleProviders:status", async () => foundationModelsConnection.status());
  ipcMain.handle("titleProviders:refresh", async () =>
    foundationModelsConnection.status({ force: true }),
  );
}
