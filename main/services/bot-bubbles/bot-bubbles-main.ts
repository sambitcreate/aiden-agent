// Electron wiring for the Bot bubble service: the userData file, app settings,
// the Bot list, and the `bots:bubbles:changed` broadcast. A deleted Bot's head
// goes away when its `bots:changed` notice arrives.

import * as path from "node:path";
import { BOT_BUBBLE_CHANNELS, type BotBubbleState } from "../../../renderer/shared/bot-bubbles.js";
import { app, ipcMain, logger, onBroadcast } from "../../platform.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { configStore } from "../config-store.js";
import { createBotBubbleService, type BotBubbleService } from "./bot-bubbles-service.js";

let service: BotBubbleService | null = null;
let stopObserving: (() => void) | null = null;

export function botBubbleService(): BotBubbleService {
  service ??= createBotBubbleService({
    filePath: path.join(app.getPath("userData"), "bot-bubbles.json"),
    platform: process.platform,
    readSettings: () => configStore.getSettings(),
    botExists: async (botId) => (await botApplicationService.get(botId)) != null,
    listBotIds: async () => (await botApplicationService.list()).map((bot) => bot.id),
    broadcast: (state: BotBubbleState) => ipcMain.broadcast(BOT_BUBBLE_CHANNELS.changed, state),
    onWarning: (message, error) => logger.warn("bot-bubbles", message, error),
  });
  return service;
}

/** The head whose mini chat is open now; the live chat "in front" probe reads it. */
export function botBubbleOpenBotId(): string | null {
  return service?.openBotId() ?? null;
}

/** Load the saved heads and follow Bot changes. Called once after the app is ready. */
export function startBotBubbleService(): BotBubbleService {
  const bubbles = botBubbleService();
  stopObserving ??= onBroadcast((channel, botId) => {
    if (channel === "bots:changed") {
      void bubbles.botsChanged(botId).catch((error: unknown) => logger.warn("bot-bubbles", "Could not check a changed Bot.", error));
    } else if (channel === "app:config-externally-changed") {
      // A hand edit may have flipped a bubble switch.
      void configStore
        .getSettings()
        .then((settings) => bubbles.syncSettings(settings))
        .catch((error: unknown) => logger.warn("bot-bubbles", "Could not re-read the Bot bubble settings.", error));
    }
  });
  void bubbles.ready().catch((error: unknown) => logger.warn("bot-bubbles", "Could not load the Bot bubbles.", error));
  return bubbles;
}

export function stopBotBubbleService(): void {
  stopObserving?.();
  stopObserving = null;
}
