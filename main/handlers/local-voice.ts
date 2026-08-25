// IPC handlers for on-device voice: sherpa-onnx (Parakeet) engine status, model
// download management, and local transcription. Thin — logic lives in
// services/parakeet.ts and services/local-models.ts.

import { ipcMain } from "../platform.js";
import { engineStatus, transcribePcmBase64, releaseRecognizer } from "../services/parakeet.js";
import {
  listModels,
  downloadModel,
  cancelDownload,
  deleteModel,
} from "../services/local-models.js";
import { configStore } from "../services/config-store.js";
import { unreportedUsageRecord } from "../services/usage-accounting.js";
import { usageStore } from "../services/usage-store.js";
import { asString, pcmToFloat32 } from "./voice-codec.js";

// Re-exported so the IPC contract surface stays queryable from one module.
export { asString, pcmToFloat32 };

export function registerLocalVoiceHandlers(): void {
  // ── Engine ───────────────────────────────────────────────────────────
  ipcMain.handle("localVoice:status", async () => engineStatus());

  // ── Model management ─────────────────────────────────────────────────
  ipcMain.handle("localModels:list", async () => listModels());
  ipcMain.handle("localModels:download", async (_event, id: unknown) => {
    await downloadModel(asString(id, "id"));
  });
  ipcMain.handle("localModels:cancel", async (_event, id: unknown) => {
    return cancelDownload(asString(id, "id"));
  });
  ipcMain.handle("localModels:delete", async (_event, id: unknown) => {
    const modelId = asString(id, "id");
    await releaseRecognizer(modelId);
    await deleteModel(modelId);
    const settings = await configStore.getSettings();
    if (settings.localVoiceModel === modelId)
      await configStore.setSettings({ localVoiceModel: "" });
  });

  // ── Local transcription ──────────────────────────────────────────────
  ipcMain.handle("voice:transcribeLocal", async (_event, pcmBase64: unknown, modelId: unknown) => {
    const parsedModelId = asString(modelId, "modelId");
    const encoded = asString(pcmBase64, "pcmBase64");
    try {
      const transcript = await transcribePcmBase64(encoded, parsedModelId);
      await usageStore.record(
        unreportedUsageRecord({
          source: "voice-transcription",
          providerId: "local-voice",
          providerLabel: "On-device voice",
          modelId: parsedModelId,
          local: true,
          status: "completed",
        }),
      );
      return transcript;
    } catch (error) {
      await usageStore.record(
        unreportedUsageRecord({
          source: "voice-transcription",
          providerId: "local-voice",
          providerLabel: "On-device voice",
          modelId: parsedModelId,
          local: true,
          status: "failed",
        }),
      );
      throw error;
    }
  });
}
