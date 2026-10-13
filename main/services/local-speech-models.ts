import path from "node:path";
import { rm } from "node:fs/promises";
import { app, ipcMain, logger } from "../platform.js";
import { createSpeechModelManager } from "./local-speech-downloads.js";
export type { LocalModel, LocalModelDownloadState } from "./local-speech-downloads.js";

const manager = createSpeechModelManager({
  root: () => path.join(app.getPath("userData"), "voice-models"),
  progress: (value) => ipcMain.broadcast("localModels:progress", value),
  info: (message) => logger.info("local-speech", message),
});

export const { modelDir, isModelInstalled, listModels, localModelDownloadStates, downloadModel, cancelDownload, deleteModel, specFor } = manager;

/** Startup housekeeping: pre-1.0 the unverified Parakeet folder is removed, not migrated. */
export async function prepareLocalSpeechStorage(): Promise<void> {
  await rm(path.join(app.getPath("userData"), "parakeet-models"), { recursive: true, force: true }).catch((error: unknown) => {
    logger.warn("local-speech", `Could not remove the legacy Parakeet folder: ${String(error)}`);
  });
  await manager.cleanupLeftovers();
}
