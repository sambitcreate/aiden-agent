// Production wiring for Create Images. Imported only by main/index.ts and the
// IPC registration; tests construct CreateImagesRuntime directly. No logic here:
// the assembly lives in port-wiring-core.ts and runtime.ts, which are tested.
import path from "node:path";
import { app, ipcMain, logger } from "../../platform.js";
import {
  IMAGE_GENERATION_PROVIDER_NAMES,
  isImageGenerationProviderId,
} from "../../../renderer/shared/image-generation/types.js";
import { imageGeneration } from "../image-generation/runtime-main.js";
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
      models: imageGeneration.models,
      providerLabel: (providerId) =>
        isImageGenerationProviderId(providerId) ? IMAGE_GENERATION_PROVIDER_NAMES[providerId] : providerId,
      // Offline: loads image settings and registers providers; never contacts a provider.
      ready: () => imageGeneration.ready(),
      recordUsage: (record) => usageStore.record(record),
    }),
  notify: (snapshot) => ipcMain.broadcast(IMAGE_RUN_CHANGED_CHANNEL, snapshot),
  reportIssue: (message, error) => logger.warn("create-images", message, error),
});
