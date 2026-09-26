import path from "node:path";
import { app, ipcMain, logger } from "../platform.js";
import { createLocalModelManager } from "./local-models-core.js";
export type { LocalModel, LocalModelDownloadState } from "./local-models-core.js";

export const { modelDir, isModelInstalled, listModels, localModelDownloadStates, downloadModel, cancelDownload, deleteModel } = createLocalModelManager({
  root: () => path.join(app.getPath("userData"), "parakeet-models"),
  progress: (value) => ipcMain.broadcast("localModels:progress", value),
  info: (message) => logger.info("local-models", message),
});
