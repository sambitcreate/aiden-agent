// IPC handlers for on-device voice: sherpa-onnx (Parakeet) engine status, model
// download management, and local transcription. Thin — logic lives in
// services/parakeet.ts and services/local-models.ts.

import { ipcMain } from "../platform.js";
import { engineStatus, transcribePcm, releaseRecognizer } from "../services/parakeet.js";
import { listModels, downloadModel, cancelDownload, deleteModel } from "../services/local-models.js";
import { configStore } from "../services/config-store.js";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

/** Base64 of a raw little-endian Float32 PCM buffer → Float32Array. */
function pcmToFloat32(base64: string): Float32Array {
  const buf = Buffer.from(base64, "base64");
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

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
    releaseRecognizer(modelId);
    await deleteModel(modelId);
    const settings = await configStore.getSettings();
    if (settings.localVoiceModel === modelId) await configStore.setSettings({ localVoiceModel: "" });
  });

  // ── Local transcription ──────────────────────────────────────────────
  ipcMain.handle("voice:transcribeLocal", async (_event, pcmBase64: unknown, modelId: unknown) => {
    return transcribePcm(pcmToFloat32(asString(pcmBase64, "pcmBase64")), asString(modelId, "modelId"));
  });
}
