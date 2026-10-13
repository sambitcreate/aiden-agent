import { isModelType, type ImageApi, type ImageModel } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { logger } from "../../platform.js";
import { piCredentialStore } from "../pi-credential-store.js";
import { ImageGenerationRuntime } from "./runtime.js";
import { createImageGenerationSettingsStore } from "./settings-store.js";

let bundledOpenRouter: readonly ImageModel<ImageApi>[] | undefined;

function bundledOpenRouterImageModels(): readonly ImageModel<ImageApi>[] {
  bundledOpenRouter ??= openrouterProvider()
    .getAllModels?.()
    .filter((model): model is ImageModel<ImageApi> => isModelType(model, "image")) ?? [];
  return bundledOpenRouter;
}

/**
 * The app's image-generation registry. Its keys live only under
 * `aiden-internal:image-gen:*` in the encrypted credential store; nothing here
 * runs on startup, and the network is touched only by an explicit generation
 * or a user-pressed Fetch latest models.
 */
export const imageGeneration = new ImageGenerationRuntime({
  credentials: piCredentialStore,
  settings: createImageGenerationSettingsStore(),
  openRouterModels: bundledOpenRouterImageModels,
  onWarning: (message) => logger.warn("image-generation", message),
});
