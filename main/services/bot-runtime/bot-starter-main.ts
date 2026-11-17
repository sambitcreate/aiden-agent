// Production wiring of Start Chat and the self-intro. One starter per process,
// so concurrent Start Chat taps from the Mac and a phone join one creation.

import { app, logger } from "../../platform.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { newBotId } from "../bot-application-service.js";
import { createBotCreationKeyStore } from "../bot-creation-keys.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../bot-runtime-authority-main.js";
import { botStore } from "../bot-store.js";
import { botSessionRuntime } from "./bot-session-main.js";
import { botPresetRoutineSchedule } from "../../../renderer/shared/bot-presets.js";
import { createBotStarter, type BotStarter } from "./bot-starter.js";

const creationKeys = createBotCreationKeyStore({ root: () => app.getPath("userData") });
let starter: BotStarter | undefined;

export function botStarter(): BotStarter {
  starter ??= createBotStarter({
    async findBotByCreationKey(key) {
      const botId = await creationKeys.get(key);
      if (botId === null) return null;
      const bot = await botStore.get(botId);
      if (bot) return bot;
      await creationKeys.forget(key);
      return null;
    },
    mintBotId: newBotId,
    reserveCreation: (creationKey, botId) => creationKeys.set(creationKey, botId),
    createBot: (input, access, botId, presetId) =>
      botApplicationService.createBot({
        audienceId: BOT_DESKTOP_AUDIENCE_ID,
        botId,
        bot: input,
        ...(presetId === undefined ? { source: "onboarding" as const } : { presetId, source: "template" as const }),
        ...(access === undefined ? {} : { access }),
        // Templates and the first Bot say every Bot can search the web.
        grantFullWebSearch: true,
      }),
    addPausedRoutine: async (botId, routine) => {
      const { botRoutineService } = await import("../scheduled-bot-routines-main.js");
      await botRoutineService.create({
        botId,
        name: routine.name,
        prompt: routine.prompt,
        schedule: botPresetRoutineSchedule(routine.schedule),
        enabled: false,
      });
    },
    session: {
      send: async (botId, input) => (await botSessionRuntime()).send(botId, input),
      state: async (botId) => (await botSessionRuntime()).state(botId),
      conversation: async (botId) => (await botSessionRuntime()).conversation(botId),
    },
    onIntroError: (botId, error) => logger.warn("bots", `Bot ${botId} could not introduce itself.`, error),
    onRoutineError: (botId, error) => logger.warn("bots", `Bot ${botId}'s template routine could not be added.`, error),
  });
  return starter;
}
