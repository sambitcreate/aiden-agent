import { ipcMain, logger } from "../platform.js";
import { runImageGenerationAction } from "../services/image-generation/action.js";
import { imageGeneration } from "../services/image-generation/runtime-main.js";
import {
  parseAddCustomModelRequest,
  parseModelRef,
  parseProviderRequest,
  parseSetDefaultModelRequest,
  parseSetKeyRequest,
  parseSetModelEnabledRequest,
  parseSetModelsEnabledRequest,
} from "./image-generation-parse.js";

function unexpected(action: string) {
  return (error: unknown) =>
    logger.warn("image-generation", `Image Generation ${action} failed.`, {
      errorType: error instanceof Error ? error.name : typeof error,
    });
}

export function registerImageGenerationHandlers(): void {
  ipcMain.handle("imageGeneration:state", async () => imageGeneration.getState());
  ipcMain.handle("imageGeneration:setKey", async (_event, input: unknown) =>
    runImageGenerationAction(() => {
      const request = parseSetKeyRequest(input);
      return imageGeneration.setKey(request.provider, request.key);
    }, unexpected("key save")),
  );
  ipcMain.handle("imageGeneration:removeKey", async (_event, input: unknown) =>
    runImageGenerationAction(
      () => imageGeneration.removeKey(parseProviderRequest(input).provider),
      unexpected("key removal"),
    ),
  );
  ipcMain.handle("imageGeneration:setModelEnabled", async (_event, input: unknown) =>
    runImageGenerationAction(() => {
      const request = parseSetModelEnabledRequest(input);
      return imageGeneration.setModelEnabled(request.provider, request.id, request.enabled);
    }, unexpected("model toggle")),
  );
  ipcMain.handle("imageGeneration:setModelsEnabled", async (_event, input: unknown) =>
    runImageGenerationAction(
      () => imageGeneration.setModelsEnabled(parseSetModelsEnabledRequest(input).changes),
      unexpected("bulk model toggle"),
    ),
  );
  ipcMain.handle("imageGeneration:setDefaultModel", async (_event, input: unknown) =>
    runImageGenerationAction(
      () => imageGeneration.setDefaultModel(parseSetDefaultModelRequest(input)),
      unexpected("default model"),
    ),
  );
  ipcMain.handle("imageGeneration:addCustomModel", async (_event, input: unknown) =>
    runImageGenerationAction(
      () => imageGeneration.addCustomModel(parseAddCustomModelRequest(input)),
      unexpected("custom model"),
    ),
  );
  ipcMain.handle("imageGeneration:removeCustomModel", async (_event, input: unknown) =>
    runImageGenerationAction(
      () => imageGeneration.removeCustomModel(parseModelRef(input)),
      unexpected("custom model removal"),
    ),
  );
  ipcMain.handle("imageGeneration:fetchModels", async (_event, input: unknown) =>
    runImageGenerationAction(
      () => imageGeneration.fetchModels(parseProviderRequest(input).provider),
      unexpected("model fetch"),
    ),
  );
}
