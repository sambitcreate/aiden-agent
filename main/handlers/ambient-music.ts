import {
  parseAmbientMusicConfig,
  type AmbientMusicModelId,
} from "../../renderer/shared/ambient-music.js";
import { ipcMain } from "../platform.js";
import { getAmbientMusicManager } from "../services/ambient-music.js";
import { applyAmbientMusicConfiguration } from "../services/ambient-music-configuration.js";
import { configStore } from "../services/config-store.js";
import { AmbientMusicDownloadError } from "../services/ambient-music-download-core.js";
import { AmbientMusicServiceError } from "../services/ambient-music-service.js";
import { AmbientMusicValidationError } from "../services/ambient-music-core.js";

function parseModel(value: unknown): AmbientMusicModelId {
  if (value !== "mrt2_small" && value !== "mrt2_base") {
    throw new Error("Choose a supported Ambient Music model.");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Ambient Music request.");
  }
  return value as Record<string, unknown>;
}

async function publicOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof AmbientMusicDownloadError ||
      error instanceof AmbientMusicServiceError ||
      error instanceof AmbientMusicValidationError
    ) {
      throw new Error(error.message);
    }
    if (error instanceof Error && error.message.startsWith("Ambient Music")) {
      throw new Error(error.message.slice(0, 500));
    }
    throw new Error("Ambient Music could not complete that operation.");
  }
}

export function registerAmbientMusicHandlers(): void {
  const ambientMusicManager = getAmbientMusicManager();
  ipcMain.handle("ambientMusic:get", () => ambientMusicManager.snapshot());
  ipcMain.handle("ambientMusic:download", async (_event, raw: unknown) => {
    const input = asRecord(raw);
    if (input.termsAccepted !== true || (input.repair !== undefined && typeof input.repair !== "boolean")) {
      throw new Error("Review and accept the model terms before downloading.");
    }
    return publicOperation(() => ambientMusicManager.download(
      parseModel(input.model),
      true,
      input.repair === true,
    ));
  });
  ipcMain.handle("ambientMusic:cancelDownload", () =>
    publicOperation(() => ambientMusicManager.cancelDownload()));
  ipcMain.handle("ambientMusic:unload", () =>
    publicOperation(() => ambientMusicManager.unload()));
  ipcMain.handle("ambientMusic:load", async (_event, raw: unknown) => {
    const input = asRecord(raw);
    return publicOperation(() => ambientMusicManager.load(parseModel(input.model)));
  });
  ipcMain.handle("ambientMusic:applyConfiguration", async (_event, raw: unknown) => {
    const input = asRecord(raw);
    const config = parseAmbientMusicConfig(input.config);
    if (!config || (input.playAfter !== undefined && typeof input.playAfter !== "boolean")) {
      throw new Error("Provide a valid Ambient Music configuration.");
    }
    return publicOperation(() => applyAmbientMusicConfiguration(
      ambientMusicManager,
      configStore,
      config,
      input.playAfter === true,
    ));
  });
  ipcMain.handle("ambientMusic:setWeights", async (_event, raw: unknown) => {
    const input = asRecord(raw);
    if (!Array.isArray(input.weights)) throw new Error("Provide Ambient Music weights.");
    await publicOperation(() => ambientMusicManager.setWeights(input.weights as number[]));
    return ambientMusicManager.snapshot();
  });
  ipcMain.handle("ambientMusic:setVolume", async (_event, raw: unknown) => {
    const input = asRecord(raw);
    await publicOperation(() => ambientMusicManager.setVolume(input.decibels as number));
    return ambientMusicManager.snapshot();
  });
  ipcMain.handle("ambientMusic:setDrumless", async (_event, raw: unknown) => {
    const input = asRecord(raw);
    await publicOperation(() => ambientMusicManager.setDrumless(input.enabled as boolean));
    return ambientMusicManager.snapshot();
  });
  ipcMain.handle("ambientMusic:setVariation", async (_event, raw: unknown) => {
    const input = asRecord(raw);
    await publicOperation(() => ambientMusicManager.setVariation(input.variation as number));
    return ambientMusicManager.snapshot();
  });
  ipcMain.handle("ambientMusic:play", async () => {
    await publicOperation(() => ambientMusicManager.play());
    return ambientMusicManager.snapshot();
  });
  ipcMain.handle("ambientMusic:pause", async () => {
    await publicOperation(() => ambientMusicManager.pause());
    return ambientMusicManager.snapshot();
  });
  ipcMain.handle("ambientMusic:stop", async () => {
    await publicOperation(() => ambientMusicManager.stop());
    return ambientMusicManager.snapshot();
  });
  ipcMain.handle("ambientMusic:restart", async () => {
    await publicOperation(() => ambientMusicManager.restart());
    return ambientMusicManager.snapshot();
  });
  ipcMain.handle("ambientMusic:removeModel", async (_event, raw: unknown) => {
    const input = asRecord(raw);
    if (input.confirmed !== true || !Number.isSafeInteger(input.expectedRevision)) {
      throw new Error("Confirm model removal from the current Ambient Music state.");
    }
    if (input.expectedRevision !== ambientMusicManager.snapshot().revision) {
      throw new Error("Ambient Music changed. Review the current model state before removing it.");
    }
    return publicOperation(() => ambientMusicManager.removeModel(
      parseModel(input.model),
      input.expectedRevision as number,
    ));
  });
  ipcMain.handle("ambientMusic:benchmarkBase", (_event, raw: unknown) => {
    const input = asRecord(raw);
    if (!Number.isSafeInteger(input.expectedRevision)) {
      throw new Error("Start the Base benchmark from the current Ambient Music state.");
    }
    return publicOperation(() => ambientMusicManager.benchmarkBase(input.expectedRevision as number));
  });

  ambientMusicManager.subscribe((snapshot) => {
    ipcMain.broadcast("ambientMusic:changed", snapshot);
  });
}
