// Electron/runtime bindings for the TTS application service.
//
// Wires the pure service to the real chat store, LLM busy state, encrypted
// secrets, the Google provider adapter, and the tts:event broadcast. No
// business logic lives here.

import { ipcMain } from "../../platform.js";
import { configStore } from "../config-store.js";
import { secrets } from "../secrets.js";
import { llmClient } from "../llm-client.js";
import { chatStore } from "../chat-store.js";
import { createTtsService, ttsUsageRecord } from "./service.js";
import { createGeminiTtsProvider } from "./gemini-provider.js";
import { readSavedGoogleTtsKey, TTS_DEDICATED_SECRET_ID } from "./credentials.js";
import { piCredentialStore } from "../pi-credential-store.js";

import { usageStore } from "../usage-store.js";

export const ttsService = createTtsService({
  config: configStore,
  credentials: {
    // Strict reads: unreadable secure storage fails closed instead of
    // silently degrading into "needs setup".
    getGoogleKey: () => readSavedGoogleTtsKey(piCredentialStore),
    getDedicatedKey: () => secrets.getKeyStrict(TTS_DEDICATED_SECRET_ID),
  },
  source: {
    getChat: async (chatId) => (await chatStore.get(chatId)) ?? null,
    isChatBusy: (chatId) => llmClient.isChatBusy(chatId),
  },
  provider: createGeminiTtsProvider(),
  recordUsage: (report) => { void usageStore.record(ttsUsageRecord(report)); },
  emit: (event, owner) => {
    if (owner?.kind === "remote") return;
    ipcMain.broadcast("tts:event", event);
  },
  clock: {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
});

/** Dedicated-key management stays behind explicit intent-only handlers. */
export async function setDedicatedTtsKey(key: string, isCurrent: () => boolean): Promise<void> {
  const { MAX_TTS_KEY_LENGTH } = await import("./credentials.js");
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("A Google API key is required.");
  }
  if (key.length > MAX_TTS_KEY_LENGTH) {
    throw new Error("That API key is unexpectedly long.");
  }
  await secrets.setInternalKey(TTS_DEDICATED_SECRET_ID, key, MAX_TTS_KEY_LENGTH, isCurrent);
  ipcMain.broadcast("tts:event", { kind: "status" });
}

export async function clearDedicatedTtsKey(isCurrent: () => boolean): Promise<void> {
  await secrets.deleteKey(TTS_DEDICATED_SECRET_ID, isCurrent);
  ipcMain.broadcast("tts:event", { kind: "status" });
}
