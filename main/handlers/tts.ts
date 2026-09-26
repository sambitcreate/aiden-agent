// TTS IPC handlers: strict payload parsing, document-owner validation, and
// delegation to the main-owned application service.

import { ipcMain } from "../platform.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  ttsService,
  setDedicatedTtsKey,
  clearDedicatedTtsKey,
} from "../services/tts/service-main.js";
import { parseTtsStartRequest, TTS_LIMITS } from "../../renderer/shared/tts.js";
import { TtsStartError } from "../services/tts/service.js";

function owner(event: Electron.IpcMainInvokeEvent) {
  return rendererDocumentOwner(
    event,
    () => new Error("Text to Speech must be controlled by the active application document."),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Text to Speech request.");
  }
  return value as Record<string, unknown>;
}

function optionalChatId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error("Invalid chat reference.");
  }
  return value;
}

function asNonEmptyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function boundedIndex(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function registerTtsHandlers(): void {
  ipcMain.handle("tts:status", async (event, input: unknown) => {
    const request = input === undefined ? {} : asRecord(input);
    return ttsService.status(owner(event), optionalChatId(request.chatId));
  });

  ipcMain.handle("tts:settings:get", async (event) => {
    const status = await ttsService.status(owner(event));
    return {
      settings: status.settings,
      settingsRevision: status.settingsRevision,
    };
  });

  ipcMain.handle("tts:settings:update", async (event, input: unknown) => {
    const request = asRecord(input);
    const expectedRevision = asNonEmptyString(request.expectedRevision, "settings revision", 128);
    // parseTtsSettingsPatch rejects unknown or secret-bearing fields.
    return ttsService.updateSettings(owner(event), expectedRevision, request.patch);
  });

  ipcMain.handle("tts:credential:set", async (event, input: unknown) => {
    const currentOwner = owner(event);
    const request = asRecord(input);
    ttsService.stop(currentOwner);
    await setDedicatedTtsKey(
      asNonEmptyString(request.apiKey, "Google API key", 512),
      () => !currentOwner.isDestroyed(),
    );
    return { ok: true };
  });

  ipcMain.handle("tts:credential:clear", async (event) => {
    const currentOwner = owner(event);
    ttsService.stop(currentOwner);
    await clearDedicatedTtsKey(() => !currentOwner.isDestroyed());
    return { ok: true };
  });

  ipcMain.handle("tts:voices:starter", async (event) => {
    owner(event);
    return ttsService.listStarterVoices();
  });

  ipcMain.handle("tts:voices:list", async (event, input: unknown) => {
    const request = input === undefined ? {} : asRecord(input);
    return ttsService.listProviderVoices(
      owner(event),
      request.pageToken === undefined
        ? undefined
        : asNonEmptyString(request.pageToken, "voice page token", 2048),
    );
  });

  ipcMain.handle("tts:preview", async (event) => {
    try {
      return { ok: true as const, snapshot: await ttsService.startPreview(owner(event)) };
    } catch (error) {
      if (error instanceof TtsStartError) return { ok: false as const, error: error.safe };
      throw error;
    }
  });

  ipcMain.handle("tts:start", async (event, input: unknown) => {
    const request = parseTtsStartRequest(input);
    try {
      return { ok: true as const, snapshot: await ttsService.start(owner(event), request) };
    } catch (error) {
      if (error instanceof TtsStartError) return { ok: false as const, error: error.safe };
      throw error;
    }
  });

  ipcMain.handle("tts:audio:read", (event, input: unknown) => {
    const request = asRecord(input);
    const jobId = asNonEmptyString(request.jobId, "job reference", 128);
    const segment = boundedIndex(request.segment, "segment index", 10_000);
    const offset = boundedIndex(request.offset, "audio offset", 1 << 30);
    const maxBytes = boundedIndex(
      request.maxBytes,
      "audio read size",
      TTS_LIMITS.audioReadMaxBytes,
    );
    const result = ttsService.readAudio(owner(event), jobId, segment, offset, maxBytes);
    if (!result) return null;
    // Serialize as plain data: bytes become a transferable buffer.
    return {
      bytes: result.bytes,
      mimeType: result.mimeType,
      sampleRate: result.sampleRate,
      channels: result.channels,
      segmentBytes: result.segmentBytes,
      nextOffset: result.nextOffset,
      complete: result.complete,
    };
  });

  ipcMain.handle("tts:pause", (event) => ttsService.pause(owner(event)));
  ipcMain.handle("tts:resume", (event) => ttsService.resume(owner(event)));
  ipcMain.handle("tts:stop", (event) => {
    ttsService.stop(owner(event));
    return { ok: true };
  });

  ipcMain.handle("tts:cache:clear", (event) => {
    ttsService.clearCache(owner(event));
    return { ok: true };
  });
}
