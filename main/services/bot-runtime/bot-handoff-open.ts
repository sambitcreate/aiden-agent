// What **Open** on a hand-off card does (plan §4.1, §5.2), from the Mac or a
// phone. Pure: the openers come in as dependencies.
//
// | Card                  | From the Mac                                    | From a phone                            |
// |-----------------------|-------------------------------------------------|-----------------------------------------|
// | sign-in               | the Bot's computer or browser, by `target`      | the Bot's chat, then the same opener    |
// | action with a link    | the Bot's browser, else the system browser      | the Bot's chat (the phone opens it)     |
// | a rule's, with a link | the Bot's browser only                          | the Bot's chat (the phone gets no link) |
// | action without a link | nothing                                         | the Bot's chat                          |
//
// A link is checked again here, so only an https page without credentials is
// opened. A sign-in never falls back to the system browser: the Bot could not
// use a sign-in made there. Nor does a rule's card, whose page is the Bot's
// own tab (a rule handed the Bot's browser step to the person). When the Bot's
// browser fails to open the link of a card the Bot wrote (a full tab strip, a
// browser that won't load), the system browser opens it instead; a sign-in's
// failure reaches the person on the Mac, and a phone's Open still brings the
// chat forward.

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
  /** The Bot's browser or computer failed, and the card fell back (the system browser, or the chat). */
  onOpenerError?(error: unknown): void;
}

async function openSignIn(prompt: BotPendingHandoff, url: string, openers: BotHandoffOpeners): Promise<BotHandoffOpened> {
  if ((prompt.target ?? "browser") === "computer") {
    return (await openers.botComputer?.(prompt.botId, prompt.waitId, url)) === true ? "computer" : "none";
  }
  return (await openers.botBrowser?.(prompt.botId, prompt.waitId, url, "sign_in")) === true ? "browser" : "none";
}

/** The Bot's browser for an action's link: false when it has none or couldn't open it. */
async function openInBotBrowser(prompt: BotPendingHandoff, url: string, openers: BotHandoffOpeners): Promise<boolean> {
  try {
    return (await openers.botBrowser?.(prompt.botId, prompt.waitId, url, "handoff")) === true;
  } catch (error) {
    openers.onOpenerError?.(error);
    return false;
  }
}

export async function openBotHandoff(
  prompt: BotPendingHandoff,
  from: BotHandoffOpenFrom,
  openers: BotHandoffOpeners,
): Promise<BotHandoffOpened> {
  const url = prompt.open?.url;
  const link = url !== undefined && isBotHandoffOpenUrl(url) ? url : undefined;
  if (prompt.kind === "sign_in") {
    if (from === "desktop") return link === undefined ? "none" : openSignIn(prompt, link, openers);
    await openers.focusChat(prompt.botId);
    let opened: BotHandoffOpened = "none";
    try {
      if (link !== undefined) opened = await openSignIn(prompt, link, openers);
    } catch (error) {
      openers.onOpenerError?.(error);
    }
    return opened === "none" ? "focused" : opened;
  }
  if (from === "phone") {
    await openers.focusChat(prompt.botId);
    return "focused";
  }
  if (link === undefined) return "none";
  if (await openInBotBrowser(prompt, link, openers)) return "browser";
  // A rule's page is the Bot's own tab: in the person's browser the step
  // (Buy, Send, a password) would act on their own session instead.
  if (prompt.source === "rule") return "none";
  await openers.external(link);
  return "external";
}
