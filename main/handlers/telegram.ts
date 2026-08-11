// Telegram IPC handlers — enable/token/connect/disconnect/status flow.
// Modeled on the exa:* block in phase2.ts.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { secrets } from "../services/secrets.js";
import { telegramService } from "../services/telegram/telegram-service.js";
import { TELEGRAM_PROVIDER_ID } from "../services/telegram/telegram-service.js";

export interface TelegramStatusResponse {
  enabled: boolean;
  hasToken: boolean;
  allowedUserId?: number;
  polling: boolean;
  queuedCount: number;
  lastError?: string;
}

export function registerTelegramHandlers(): void {
  ipcMain.handle("telegram:get", async () => {
    const settings = await configStore.getSettings();
    const status = telegramService.getStatus();
    return {
      enabled: settings.telegramEnabled ?? false,
      hasToken: await secrets.hasKey(TELEGRAM_PROVIDER_ID),
      allowedUserId: settings.telegramAllowedUserId,
      polling: status.status !== "disabled",
      queuedCount: status.queuedCount,
      lastError: status.lastError,
    } satisfies TelegramStatusResponse;
  });

  ipcMain.handle("telegram:setKey", async (_event, key: unknown) => {
    const value = typeof key === "string" ? key.trim() : "";
    if (value) {
      await secrets.setKey(TELEGRAM_PROVIDER_ID, value);
    } else {
      await secrets.deleteKey(TELEGRAM_PROVIDER_ID);
      await configStore.setSettings({ telegramEnabled: false, telegramAllowedUserId: undefined });
      telegramService.stop();
    }
    return { hasKey: Boolean(value) };
  });

  ipcMain.handle("telegram:setEnabled", async (_event, enabled: unknown) => {
    const value = enabled === true;
    await configStore.setSettings({ telegramEnabled: value });
    if (value) {
      await telegramService.start();
    } else {
      telegramService.stop();
    }
    return value;
  });

  ipcMain.handle("telegram:connect", async () => {
    await telegramService.connect();
    return { connected: true };
  });

  ipcMain.handle("telegram:disconnect", async () => {
    await telegramService.disconnect();
    return { connected: false };
  });

  ipcMain.handle("telegram:resetPairing", async () => {
    await configStore.setSettings({ telegramAllowedUserId: undefined });
    return { reset: true };
  });
}
