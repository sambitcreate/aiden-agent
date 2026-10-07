// Production wiring of Start Chat and the self-intro. One starter per process,
// so concurrent Start Chat taps from the Mac and a phone join one creation.

import { app, logger } from "../../platform.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { createBotCreationKeyStore } from "../bot-creation-keys.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../bot-runtime-authority-main.js";
import { botStore } from "../bot-store.js";
import { botSessionRuntime } from "./bot-session-main.js";
import { createBotStarter, type BotStarter } from "./bot-starter.js";

const creationKeys = createBotCreationKeyStore({ root: () => app.getPath("userData") });
let starter: BotStarter | undefined;

export function botStarter(): BotStarter {
  starter ??= createBotStarter({
    async findBotByCreationKey(key) {
      const botId = await creationKeys.get(key);
      if (botId === null) return null;
      const bot = await botStore.get(botId);
      if (bot && bot.archivedAt === undefined) return bot;
      await creationKeys.forget(key);
      return null;
    },
    async createBot(input, access, creationKey) {
      const bot = await botApplicationService.createBot({
        audienceId: BOT_DESKTOP_AUDIENCE_ID,
        bot: input,
        ...(access === undefined ? {} : { access }),
      });
      await creationKeys.set(creationKey, bot.id);
      return bot;
    },
    session: {
      send: async (botId, input) => (await botSessionRuntime()).send(botId, input),
      state: async (botId) => (await botSessionRuntime()).state(botId),
    },
    onIntroError: (botId, error) => logger.warn("bots", `Bot ${botId} could not introduce itself.`, error),
  });
  return starter;
}
