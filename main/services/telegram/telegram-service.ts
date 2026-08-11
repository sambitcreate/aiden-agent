// Telegram service production singleton.
// Mirrors schedule-service.ts: factory + DI, export const at import time.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

import { app, ipcMain, logger } from "../../platform.js";
import { configStore } from "../config-store.js";
import { chatStore } from "../chat-store.js";
import { llmClient } from "../llm-client.js";
import { providerRegistry } from "../provider-registry.js";
import { secrets } from "../secrets.js";
import {
  createFetchTransport,
  TelegramBotApi,
} from "./telegram-bot-api.js";
import { createTelegramConfig } from "./telegram-config.js";
import { createTelegramServiceCore } from "./telegram-service-core.js";

export const TELEGRAM_PROVIDER_ID = "telegram";

async function resolveProvider(): Promise<{ providerId: string; model: string } | null> {
  const settings = await configStore.getSettings();
  const providerId = settings.lastProviderId;
  if (!providerId) return null;
  const provider =
    (await providerRegistry.selectionProvider(providerId)) ??
    (await configStore.getProvider(providerId));
  if (!provider) return null;
  const model = settings.lastModel ?? provider.defaultModel ?? provider.models[0];
  if (!model) return null;
  return { providerId, model };
}

function broadcastMetadata(chat: {
  id: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
}): void {
  ipcMain.broadcast("chats:metadata-updated", {
    chatId: chat.id,
    workspaceId: chat.workspaceId,
    title: chat.title,
    updatedAt: chat.updatedAt,
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }
  });
}

export function createTelegramService() {
  const api = new TelegramBotApi(
    createFetchTransport(() => secrets.getKey(TELEGRAM_PROVIDER_ID)),
  );
  return createTelegramServiceCore({
    api,
    config: createTelegramConfig({
      getSettings: () => configStore.getSettings(),
      setSettings: (patch) => configStore.setSettings(patch),
      hasToken: () => secrets.hasKey(TELEGRAM_PROVIDER_ID),
      resolveRootDir: () => app.getPath("userData"),
    }),
    turn: {
      llmClient,
      chatStore,
      resolveProvider,
      broadcastMetadata,
    },
    getToken: () => secrets.getKey(TELEGRAM_PROVIDER_ID),
    now: () => Date.now(),
    sleep,
    warn: (message) => logger.warn("telegram", message),
    error: (message, cause) => logger.error("telegram", message, cause),
    info: (message) => logger.info("telegram", message),
  });
}

export const telegramService = createTelegramService();
