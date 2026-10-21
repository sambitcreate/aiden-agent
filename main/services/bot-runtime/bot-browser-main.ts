// Production wiring of a Bot's own browser: the browser service, loaded
// lazily, the window that owns a Bot's browser when none shows it, the Bot
// panel's request for its browser, hand-off links opened in it, and the hold
// each such tab keeps until its card settles (blueprint G13, G14).

import { registerBotBrowserWorkspace, browserWorkspacesOfBot } from "../browser/bot-workspaces.js";
import { currentMainWindow } from "../bot-connection-setup.js";
import { logger } from "../../platform.js";
import { windowDocumentOwner, type RendererDocumentOwner } from "../renderer-document-owner.js";
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

let releasing = false;

/** A settled or withdrawn card gives its tabs back to the Bot. */
function releaseHoldsOnSettle(): void {
  if (releasing) return;
  releasing = true;
  botHandoffs.onSettled((prompt) => {
    const workspaces = browserWorkspacesOfBot(prompt.botId);
    if (workspaces.length === 0) return;
    void browserService()
      .then((service) => {
        for (const workspaceId of workspaces) service.release(workspaceId, prompt.waitId);
      })
      .catch((error: unknown) => logger.warn("bots", "Could not release a Bot browser tab.", error));
  });
}

/**
 * Open a hand-off link in a new tab of the Bot's browser, shown to the
 * person and held for them until the card settles. `owner` is the document
 * that asked (the card's Open); without one, the current main window. False
 * when the Bot has no browser to open it in (an action card then opens the
 * system browser).
 */
export async function openInBotBrowser(
  botId: string,
  waitId: string,
  url: string,
  hold: "handoff" | "sign_in",
  owner?: RendererDocumentOwner,
): Promise<boolean> {
  releaseHoldsOnSettle();
  // An action's link opens in the Bot's browser only for a Bot that browses
  // (its cart, its sign-ins); otherwise the person's own browser is better.
  if (hold === "handoff" && !(await hasBrowserAccess(botId))) return false;
  const workspaceId = await botBrowserWorkspace(botId);
  if (workspaceId === null) return false;
  const service = await browserService();
  const document = owner ?? (service.hasOwner(workspaceId) ? undefined : mintBotBrowserOwner());
  if (!document && !service.hasOwner(workspaceId)) return false;
  if (document) service.transferOwner(workspaceId, document);
  const result = await service.command(workspaceId, { action: "create", url, show: true }, { source: "user" });
  if (!result.tabId) return false;
  service.hold(workspaceId, result.tabId, { holdId: waitId, reason: hold });
  // The card may have settled while the tab opened: nothing would release it then.
  if (botHandoffs.get(botId, waitId) === undefined) service.release(workspaceId, waitId);
  return true;
}
