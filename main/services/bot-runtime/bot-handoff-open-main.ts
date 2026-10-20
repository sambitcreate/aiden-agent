// Production openers for hand-off cards (`bot-handoff-open.ts`): the system
// browser through the same validation as `browser:open-external`, and the
// Bot's chat through app navigation, which brings the main window forward.

import { shell } from "../../platform.js";
import { requestAppPath } from "../app-navigation.js";
import { externalUrl } from "../browser/core.js";
import { botHandoffs } from "./bot-handoffs-main.js";
import { openBotHandoff, type BotHandoffOpened, type BotHandoffOpeners, type BotHandoffOpenFrom } from "./bot-handoff-open.js";

const openers: BotHandoffOpeners = {
  async external(url) {
    await shell.openExternal(externalUrl(url));
  },
  async focusChat(botId) {
    await requestAppPath(`/bots/${encodeURIComponent(botId)}/chat`);
  },
};

/** Open the card `waitId` of `botId`; "none" once it no longer waits. */
export async function openBotHandoffById(botId: string, waitId: string, from: BotHandoffOpenFrom): Promise<BotHandoffOpened> {
  const prompt = botHandoffs.get(botId, waitId);
  if (!prompt) return "none";
  return openBotHandoff(prompt, from, openers);
}
