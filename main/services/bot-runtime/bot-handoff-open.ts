// What **Open** on a hand-off card does (plan §4.1, §5.2), from the Mac or a
// phone. Pure: the openers come in as dependencies.
//
// | Card                  | From the Mac                                    | From a phone                         |
// |-----------------------|-------------------------------------------------|--------------------------------------|
// | sign-in               | the Bot's computer or browser, by `target`      | the Bot's chat, then the same opener |
// | action with a link    | the Bot's browser, else the system browser      | the Bot's chat (the phone opens it)  |
// | action without a link | nothing                                         | the Bot's chat                       |
//
// The Bot's browser and computer openers arrive with those features; until
// then a sign-in opens nothing and a link opens in the system browser. A link
// is checked again here, so only an https page without credentials is opened.

import { isBotHandoffOpenUrl, type BotPendingHandoff } from "../../../renderer/shared/bot-handoffs.js";

export type BotHandoffOpenFrom = "desktop" | "phone";
export type BotHandoffOpened = "external" | "browser" | "computer" | "focused" | "none";

export interface BotHandoffOpeners {
  /** The system browser. */
  external(url: string): Promise<void>;
  /** Bring Aiden forward on the Bot's chat. */
  focusChat(botId: string): Promise<void>;
  /** Open `url` in the Bot's own browser, holding the tab for the person; false when the Bot has none. */
  botBrowser?(botId: string, waitId: string, url: string, hold: "handoff" | "sign_in"): Promise<boolean>;
  /** Open `url` on the Bot's own computer, with the person in control; false when the Bot has none. */
  botComputer?(botId: string, waitId: string, url: string): Promise<boolean>;
}

async function openSignIn(prompt: BotPendingHandoff, url: string, openers: BotHandoffOpeners): Promise<BotHandoffOpened> {
  if ((prompt.target ?? "browser") === "computer") {
    return (await openers.botComputer?.(prompt.botId, prompt.waitId, url)) === true ? "computer" : "none";
  }
  return (await openers.botBrowser?.(prompt.botId, prompt.waitId, url, "sign_in")) === true ? "browser" : "none";
}

export async function openBotHandoff(
  prompt: BotPendingHandoff,
  from: BotHandoffOpenFrom,
  openers: BotHandoffOpeners,
): Promise<BotHandoffOpened> {
  const url = prompt.open?.url;
  const link = url !== undefined && isBotHandoffOpenUrl(url) ? url : undefined;
  if (prompt.kind === "sign_in") {
    if (from === "phone") await openers.focusChat(prompt.botId);
    const opened = link === undefined ? "none" : await openSignIn(prompt, link, openers);
    return opened === "none" && from === "phone" ? "focused" : opened;
  }
  if (from === "phone") {
    await openers.focusChat(prompt.botId);
    return "focused";
  }
  if (link === undefined) return "none";
  if ((await openers.botBrowser?.(prompt.botId, prompt.waitId, link, "handoff")) === true) return "browser";
  await openers.external(link);
  return "external";
}
