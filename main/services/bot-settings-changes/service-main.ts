// Production wiring of settings from chat (plan §4.6): the real Bot and
// access stores behind `createBotSettingsPorts`.

import type { JsonValue } from "@earendil-works/chord";
import { app, ipcMain } from "../../platform.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../bot-runtime-authority-main.js";
import { createBotSettingsPorts } from "./ports.js";
import { createBotSettingsChangeService } from "./service.js";

export const botSettingsChanges = createBotSettingsChangeService(createBotSettingsPorts({
  profileDir: () => app.getPath("userData"),
  getBot: (botId) => botApplicationService.get(botId),
  modelSelection: (botId) => botApplicationService.modelSelection(BOT_DESKTOP_AUDIENCE_ID, botId),
  getBotAccess: (botId) => botApplicationService.getBotAccess(botId),
  capabilityCatalog: (botId) => botApplicationService.capabilityCatalog(BOT_DESKTOP_AUDIENCE_ID, botId),
  botWebSearchEnabled: (botId) => botApplicationService.botWebSearchEnabled(botId),
  updateBotAccess: (input) => botApplicationService.updateBotAccess({ audienceId: BOT_DESKTOP_AUDIENCE_ID, ...input }),
  updateBot: (input) => botApplicationService.updateBot(input),
  async cancelWakeUps(botId) {
    const { botWakeUps } = await import("../bot-wake-ups/wake-ups-main.js");
    await botWakeUps.cancelAll(botId);
  },
  broadcastChanged: (botId) => ipcMain.broadcast("bots:changed", { botId }),
  async appendEntry(botId, kind, data) {
    const { botSessionRuntime } = await import("../bot-runtime/bot-session-main.js");
    await (await botSessionRuntime()).appendEntry(botId, kind, data as JsonValue);
  },
}));
