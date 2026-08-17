// Telegram IPC handlers — enable/token/connect/disconnect/status flow.
// Modeled on the exa:* block in phase2.ts.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { telegramService } from "../services/telegram/telegram-service.js";
import {
  isTelegramFolderWorkspace,
  telegramWorkspaceSelectionId,
} from "../services/telegram/telegram-workspace-core.js";
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
  rendering: "rich" | "html";
  voiceMode: "hidden" | "mirror" | "always";
  activeProfile: string;
  profiles: Awaited<ReturnType<typeof telegramService.listProfiles>>;
  threadedMode: boolean;
  recentDiagnostics: ReturnType<typeof telegramService.getStatus>["recentDiagnostics"];
  lastError?: string;
}

export function registerTelegramHandlers(): void {
  ipcMain.handle("telegram:get", async () => {
    const settings = await telegramService.getActiveSettings();
    const status = telegramService.getStatus();
    return {
      enabled: settings.telegramEnabled ?? false,
      hasToken: await telegramService.hasActiveToken(),
      allowedUserId: settings.telegramAllowedUserId,
      providerId: settings.telegramProviderId,
      model: settings.telegramModel,
      workspaceId: settings.telegramWorkspaceId,
      polling: status.status !== "disabled",
      queuedCount: status.queuedCount,
      thinkingLevel: settings.telegramThinkingLevel,
      draftPreviews: settings.telegramDraftPreviews ?? false,
      activity: settings.telegramActivity ?? "quiet",
      rendering: settings.telegramRendering ?? "rich",
      voiceMode: settings.telegramVoiceMode ?? "hidden",
      activeProfile: telegramService.activeProfile,
      profiles: await telegramService.listProfiles(),
      threadedMode: settings.telegramThreadedMode ?? false,
      recentDiagnostics: status.recentDiagnostics,
      lastError: status.lastError,
    } satisfies TelegramStatusResponse;
  });

  ipcMain.handle("telegram:setKey", async (_event, key: unknown) => {
    const value = typeof key === "string" ? key.trim() : "";
    if (value) {
      await telegramService.setActiveToken(value);
    } else {
      await telegramService.setActiveToken("");
      await telegramService.resetPairing();
      await telegramService.setEnabled(false);
    }
    return { hasKey: Boolean(value) };
  });

  ipcMain.handle("telegram:setEnabled", async (_event, enabled: unknown) => {
    const value = enabled === true;
    await telegramService.setEnabled(value);
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
    await telegramService.resetPairing();
    return { reset: true };
  });

  ipcMain.handle("telegram:setProvider", async (_event, providerId: unknown, model: unknown) => {
    const pid = typeof providerId === "string" && providerId.trim() ? providerId.trim() : undefined;
    const m = typeof model === "string" && model.trim() ? model.trim() : undefined;
    await telegramService.setActiveSettings({
      telegramProviderId: pid,
      telegramModel: m,
    });
    await configStore.setSettings({ lastProviderId: pid, lastModel: m });
    if (pid && m) ipcMain.broadcast("telegram:model-selection-changed", { providerId: pid, model: m });
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
    await telegramService.setActiveSettings({ telegramWorkspaceId: selectedWorkspaceId });
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
    const rendering = value.rendering === "html" ? "html" : "rich";
    const voiceMode = value.voiceMode === "mirror" || value.voiceMode === "always"
      ? value.voiceMode
      : "hidden";
    const threadedMode = value.threadedMode === true;
    const previous = await telegramService.getActiveSettings();
    await telegramService.setActiveSettings({
      telegramThinkingLevel: thinkingLevel,
      telegramDraftPreviews: draftPreviews,
      telegramActivity: activity,
      telegramRendering: rendering,
      telegramVoiceMode: voiceMode,
      telegramThreadedMode: threadedMode,
    });
    try {
      if (threadedMode && !previous.telegramThreadedMode) await telegramService.ensureActiveThreads();
      if (!threadedMode && previous.telegramThreadedMode) await telegramService.clearActiveThreads();
    } catch (cause) {
      await telegramService.setActiveSettings({ telegramThreadedMode: previous.telegramThreadedMode });
      throw cause;
    }
    return { thinkingLevel, draftPreviews, activity, rendering, voiceMode, threadedMode };
  });

  ipcMain.handle("telegram:selectProfile", async (_event, profile: unknown) => ({
    profile: await telegramService.selectProfile(typeof profile === "string" ? profile : ""),
  }));

  ipcMain.handle("telegram:createProfile", async (_event, profile: unknown) => ({
    profile: await telegramService.createProfile(typeof profile === "string" ? profile : ""),
  }));

  ipcMain.handle("telegram:deleteProfile", async (_event, profile: unknown) => {
    await telegramService.deleteProfile(typeof profile === "string" ? profile : "");
    return { deleted: true };
  });
}
