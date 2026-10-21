// Production openers for hand-off cards (`bot-handoff-open.ts`): the system
// browser through the same validation as `browser:open-external`, the Bot's
// chat through app navigation, which brings the main window forward, and the
// Bot's own browser, where the tab is held for the person until the card
// settles.
//
// A sign-in opens in a new tab of the Bot's browser, shown in its panel's
// Browser tab: the window whose Open was pressed brings that tab forward, and
// from a phone the Mac's window comes forward on the Bot's chat first, whose
// panel then shows the held tab (`bot-browser-tab.tsx`).

import { logger, shell } from "../../platform.js";
import { requestAppPath } from "../app-navigation.js";
import { externalUrl } from "../browser/core.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { openInBotBrowser } from "./bot-browser-main.js";
import { botHandoffs } from "./bot-handoffs-main.js";
import { openBotHandoff, type BotHandoffOpened, type BotHandoffOpeners, type BotHandoffOpenFrom } from "./bot-handoff-open.js";

function openers(owner: RendererDocumentOwner | undefined): BotHandoffOpeners {
  return {
    async external(url) {
      await shell.openExternal(externalUrl(url));
    },
    async focusChat(botId) {
      await requestAppPath(`/bots/${encodeURIComponent(botId)}/chat`);
    },
    botBrowser: (botId, waitId, url, hold) => openInBotBrowser(botId, waitId, url, hold, owner),
    onOpenerError: (error) => logger.warn("bots", "A hand-off's page couldn't open in the Bot's own browser.", error),
  };
}

/**
 * Open the card `waitId` of `botId`; "none" once it no longer waits. `owner`
 * is the desktop document whose Open was pressed: the Bot's browser shows
 * there.
 */
export async function openBotHandoffById(
  botId: string,
  waitId: string,
  from: BotHandoffOpenFrom,
  owner?: RendererDocumentOwner,
): Promise<BotHandoffOpened> {
  const prompt = botHandoffs.get(botId, waitId);
  if (!prompt) return "none";
  return openBotHandoff(prompt, from, openers(owner));
}
