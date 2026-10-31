// Production openers for hand-off cards (`bot-handoff-open.ts`): the system
// browser through the same validation as `browser:open-external`, the Bot's
// chat through app navigation, which brings the main window forward, and the
// Bot's own browser, where the tab is held for the person until the card
// settles.
//
// A sign-in opens in a new tab of the Bot's browser, shown in its panel's
// Browser tab: the window whose Open was pressed brings that tab forward, and
// from a phone the Mac's window comes forward on the Bot's chat first, whose
// panel then shows the held tab (`bot-browser-tab.tsx`). A sign-in on the
// Bot's computer takes the computer over for the person and opens the site in
// Safari there (`bot-computer-handoff.ts`); the window brings the Computer
// tab forward.

import { logger, shell } from "../../platform.js";
import { requestAppPath } from "../app-navigation.js";
import { externalUrl } from "../browser/core.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { openInBotBrowser } from "./bot-browser-main.js";
import { createBotComputerHandoffOpener, type BotComputerHandoffOpener } from "./bot-computer-handoff.js";
import { botHandoffs } from "./bot-handoffs-main.js";
import { openBotHandoff, type BotHandoffOpened, type BotHandoffOpeners, type BotHandoffOpenFrom } from "./bot-handoff-open.js";

let computerOpener: BotComputerHandoffOpener | undefined;

/** The Bot's own computer, loaded only for a card that names it. */
async function openOnBotComputer(botId: string, waitId: string, url: string | undefined): Promise<boolean> {
  const { botComputers, botComputersEnabled } = await import("../bot-computers/bot-computers-main.js");
  if (!botComputersEnabled()) return false;
  const computers = botComputers();
  computerOpener ??= createBotComputerHandoffOpener({
    host: computers.host,
    control: computers.control,
    handoffs: botHandoffs,
    enabled: botComputersEnabled,
    onError: (error) => logger.warn("bots", "A sign-in couldn't open on the Bot's computer.", error),
  });
  return computerOpener(botId, waitId, url);
}

function openers(owner: RendererDocumentOwner | undefined): BotHandoffOpeners {
  return {
    async external(url) {
      await shell.openExternal(externalUrl(url));
    },
    async focusChat(botId) {
      await requestAppPath(`/bots/${encodeURIComponent(botId)}/chat`);
    },
    botBrowser: (botId, waitId, url, hold) => openInBotBrowser(botId, waitId, url, hold, owner),
    botComputer: openOnBotComputer,
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
