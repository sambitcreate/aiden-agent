// Production wiring for Create Images. Imported only by main/index.ts and the
// IPC registration; tests construct CreateImagesRuntime directly. No logic here:
// the assembly lives in port-wiring-core.ts and runtime.ts, which are tested.
import path from "node:path";
import { app, ipcMain, logger } from "../../platform.js";
import { configStore } from "../config-store.js";
import { providerRegistry } from "../provider-registry.js";
import { studioAssetStore } from "../studio-assets/main.js";
import { usageStore } from "../usage-store.js";
import { createWiredImagePort } from "./port-wiring-core.js";
import { CreateImagesRuntime } from "./runtime.js";

const IMAGE_RUN_CHANGED_CHANNEL = "imageWorkflows:run-changed";

export const createImagesRuntime = new CreateImagesRuntime({
  root: () => path.join(app.getPath("userData"), "create-images"),
  assets: studioAssetStore,
  port: () =>
    createWiredImagePort({
      models: providerRegistry.models,
      providerLabel: (providerId) => providerRegistry.builtinProvider(providerId)?.label ?? providerId,
      // Offline: ensureBuiltinCatalogs restores durable catalogs from disk and never contacts a provider.
      restoreOfflineCatalogs: () => providerRegistry.ensureBuiltinCatalogs(),
      listStoredProviders: () => configStore.listStoredProviders(),
      recordUsage: (record) => usageStore.record(record),
    }),
  notify: (snapshot) => ipcMain.broadcast(IMAGE_RUN_CHANGED_CHANNEL, snapshot),
  reportIssue: (message, error) => logger.warn("create-images", message, error),
});
