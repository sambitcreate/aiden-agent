// IPC handlers for on-device voice: sherpa-onnx (Parakeet) engine status, model
// download management, and local transcription. Thin — logic lives in
// services/parakeet.ts and services/local-models.ts.

import { ipcMain } from "../platform.js";
import { disposeParakeet, engineStatus, transcribePcmBase64, releaseRecognizer } from "../services/parakeet.js";
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
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";

const activeLocalTranscriptions = new Map<
  string,
  { controller: AbortController; removeOwnerInvalidation: () => void }
>();

function localOperationKey(ownerId: number, documentId: string, value: unknown): string {
  const operationId = asString(value, "operationId");
  if (operationId.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(operationId)) {
    throw new Error("Invalid on-device transcription operation.");
  }
  return `${ownerId}:${documentId}:${operationId}`;
}

function abortError(): Error {
  const error = new Error("On-device transcription was cancelled.");
  error.name = "AbortError";
  return error;
}

function raceLocalCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

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
  ipcMain.handle("voice:transcribeLocal", async (event, pcmBase64: unknown, modelId: unknown, operationId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("On-device transcription must come from the active application document."),
    );
    const key = localOperationKey(owner.id, owner.documentId, operationId);
    const previous = activeLocalTranscriptions.get(key);
    previous?.controller.abort();
    previous?.removeOwnerInvalidation();
    if (previous) disposeParakeet();
    const controller = new AbortController();
    const removeOwnerInvalidation = owner.onInvalidated(() => {
      controller.abort();
      disposeParakeet();
    });
    activeLocalTranscriptions.set(key, { controller, removeOwnerInvalidation });
    const parsedModelId = asString(modelId, "modelId");
    const encoded = asString(pcmBase64, "pcmBase64");
    try {
      const transcript = await raceLocalCancellation(
        transcribePcmBase64(encoded, parsedModelId),
        controller.signal,
      );
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
    } finally {
      removeOwnerInvalidation();
      if (activeLocalTranscriptions.get(key)?.controller === controller) {
        activeLocalTranscriptions.delete(key);
      }
    }
  });
  ipcMain.handle("voice:transcribeLocalCancel", (event, operationId: unknown) => {
    const owner = rendererDocumentOwner(
      event,
      () => new Error("On-device transcription must come from the active application document."),
    );
    const active = activeLocalTranscriptions.get(
      localOperationKey(owner.id, owner.documentId, operationId),
    );
    if (!active) return;
    active.controller.abort();
    // sherpa inference is synchronous in the isolated utility process, so
    // terminating that host is the prompt cancellation boundary. The next
    // request recreates it lazily.
    disposeParakeet();
  });
}
