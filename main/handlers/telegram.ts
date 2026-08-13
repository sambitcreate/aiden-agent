// Telegram IPC handlers — enable/token/connect/disconnect/status flow.
// Modeled on the exa:* block in phase2.ts.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { secrets } from "../services/secrets.js";
import { telegramService } from "../services/telegram/telegram-service.js";
import {
  isTelegramFolderWorkspace,
  telegramWorkspaceSelectionId,
} from "../services/telegram/telegram-workspace-core.js";
import { TELEGRAM_PROVIDER_ID } from "../services/telegram/telegram-service.js";
import { isGenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";

export interface TelegramStatusResponse {
  enabled: boolean;
  hasToken: boolean;
  allowedUserId?: number;
  providerId?: string;
  model?: string;
  polling: boolean;
  workspaceId?: string;
  queuedCount: number;
  thinkingLevel?: import("../../renderer/shared/generation-thinking.js").GenerationThinkingLevel;
  draftPreviews: boolean;
  activity: "quiet" | "thinking" | "tools" | "verbose";
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
      providerId: settings.telegramProviderId,
      model: settings.telegramModel,
      workspaceId: settings.telegramWorkspaceId,
      polling: status.status !== "disabled",
      queuedCount: status.queuedCount,
      thinkingLevel: settings.telegramThinkingLevel,
      draftPreviews: settings.telegramDraftPreviews ?? false,
      activity: settings.telegramActivity ?? "quiet",
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

  ipcMain.handle("telegram:setProvider", async (_event, providerId: unknown, model: unknown) => {
    const pid = typeof providerId === "string" && providerId.trim() ? providerId.trim() : undefined;
    const m = typeof model === "string" && model.trim() ? model.trim() : undefined;
    await configStore.setSettings({ telegramProviderId: pid, telegramModel: m });
    return { providerId: pid, model: m };
  });

  ipcMain.handle("telegram:setWorkspace", async (_event, workspaceId: unknown) => {
    const selectedWorkspaceId = telegramWorkspaceSelectionId(workspaceId);
    if (selectedWorkspaceId) {
      const workspace = await configStore.getWorkspace(selectedWorkspaceId);
      if (!isTelegramFolderWorkspace(workspace)) {
        throw new Error("Choose a configured folder workspace for Telegram project automation.");
      }
    }
    await configStore.setSettings({ telegramWorkspaceId: selectedWorkspaceId });
    return { workspaceId: selectedWorkspaceId };
  });

  ipcMain.handle("telegram:setExperience", async (_event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid Telegram experience settings.");
    }
    const value = input as Record<string, unknown>;
    const thinkingLevel = isGenerationThinkingLevel(value.thinkingLevel)
      ? value.thinkingLevel
      : undefined;
    const draftPreviews = value.draftPreviews === true;
    const activity = ["quiet", "thinking", "tools", "verbose"].includes(String(value.activity))
      ? value.activity as "quiet" | "thinking" | "tools" | "verbose"
      : "quiet";
    await configStore.setSettings({ telegramThinkingLevel: thinkingLevel, telegramDraftPreviews: draftPreviews, telegramActivity: activity });
    return { thinkingLevel, draftPreviews, activity };
  });
}
