// Production wiring of a Bot's own browser: the browser service, loaded
// lazily, the window that owns a Bot's browser when none shows it, the Bot
// panel's request for its browser, hand-off links opened in it, and the hold
// each such tab keeps until its card settles (blueprint G13, G14).

import { registerBotBrowserWorkspace } from "../browser/bot-workspaces.js";
import { currentMainWindow } from "../bot-connection-setup.js";
import { logger } from "../../platform.js";
import { windowDocumentOwner, type RendererDocumentOwner } from "../renderer-document-owner.js";
import { createBotBrowserHandoffOpener } from "./bot-browser-handoff.js";
import { createBotBrowser } from "./bot-browser-tools.js";
import { botHandoffs } from "./bot-handoffs-main.js";

const browserService = async () => (await import("../browser/service.js")).browserService;
const applicationService = async () => (await import("../bot-application-service-main.js")).botApplicationService;

/** The focused or most recent main window's document, or `undefined` with no window. */
export function mintBotBrowserOwner(): RendererDocumentOwner | undefined {
  const window = currentMainWindow();
  if (!window) return undefined;
  try {
    return windowDocumentOwner(window.webContents);
  } catch {
    return undefined;
  }
}

export const botBrowser = createBotBrowser({ service: browserService, mintOwner: mintBotBrowserOwner });

/**
 * The Bot's managed workspace, admitted to the browser service. `null` when
 * the Bot is gone or has no home.
 */
export async function botBrowserWorkspace(botId: string): Promise<string | null> {
  let workspaceId: string;
  try {
    workspaceId = (await (await applicationService()).resolveManagedWorkspace(botId)).workspaceId;
  } catch {
    return null;
  }
  registerBotBrowserWorkspace(workspaceId, botId);
  return workspaceId;
}

/** Whether the Bot may use its browser now (the Browser capability in its access). */
async function hasBrowserAccess(botId: string): Promise<boolean> {
  try {
    const chat = await (await applicationService()).getCanonicalChat(botId);
    if (!chat) return false;
    const { botRuntimeAuthority, BOT_DESKTOP_AUDIENCE_ID } = await import("../bot-runtime-authority-main.js");
    const admission = await botRuntimeAuthority.admit({ audienceId: BOT_DESKTOP_AUDIENCE_ID, botId, chatId: chat.id });
    try {
      return admission.authority.otherCapabilities.some((grant) => grant.kind === "browser");
    } finally {
      admission.release();
    }
  } catch {
    return false;
  }
}

/**
 * Open a hand-off link in a new tab of the Bot's browser, shown to the
 * person and held for them until the card settles (`bot-browser-handoff.ts`).
 */
export const openInBotBrowser = createBotBrowserHandoffOpener({
  service: browserService,
  handoffs: botHandoffs,
  workspace: botBrowserWorkspace,
  hasBrowserAccess,
  mintOwner: mintBotBrowserOwner,
  onReleaseError: (error) => logger.warn("bots", "Could not release a Bot browser tab.", error),
});
