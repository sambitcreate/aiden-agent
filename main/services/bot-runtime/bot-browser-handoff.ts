// A hand-off card's Open in the Bot's own browser (blueprint §2.5, G14): the
// `botBrowser` opener of `bot-handoff-open.ts`.
//
// - The link opens in a new tab of the Bot's browser, shown to the person
//   (`source: "user"`, so the panel's Browser tab comes forward).
// - The tab is held for the person (`sign_in` or `handoff`) under the card's
//   `waitId`: the Bot can't read or drive it until the card settles or is
//   withdrawn, which releases it.
// - The window whose Open was pressed shows it; without one (an Open from a
//   phone), the window already showing the Bot's browser, else the focused or
//   most recent main window. With no window at all it opens nothing.
// - An action card's link opens here only for a Bot whose access includes
//   Browser; otherwise the system browser is the better place for it. A
//   sign-in always opens here.
//
// Holds live in memory: tabs don't survive a restart, so neither do holds.

import type { BrowserCommand, BrowserCommandResult } from "../../../renderer/shared/browser.js";
import type { BrowserCommandContext, BrowserHold } from "../browser/service.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import type { BotHandoffs } from "./bot-handoffs.js";

/** The browser service as the hand-off opener uses it (`browser/service.ts`). */
export interface BotBrowserHandoffService {
  hasOwner(workspaceId: string): boolean;
  transferOwner(workspaceId: string, owner: RendererDocumentOwner): void;
  command(workspaceId: string, command: BrowserCommand, context: BrowserCommandContext): Promise<BrowserCommandResult>;
  hold(workspaceId: string, tabId: string, hold: BrowserHold): void;
  release(workspaceId: string, holdId: string): void;
}

export interface BotBrowserHandoffDeps {
  service(): Promise<BotBrowserHandoffService>;
  handoffs: Pick<BotHandoffs, "get" | "onSettled">;
  /** The Bot's browser workspace, admitted to the browser service; `null` when the Bot is gone. */
  workspace(botId: string): Promise<string | null>;
  /** Whether the Bot's access includes Browser right now. */
  hasBrowserAccess(botId: string): Promise<boolean>;
  /** The focused or most recent main window's document; `undefined` with no window. */
  mintOwner(): RendererDocumentOwner | undefined;
  /** A hold that couldn't be released (the browser service failed to load). */
  onReleaseError?(error: unknown): void;
}

/**
 * Open `url` for the card `waitId` of `botId` in the Bot's browser and hold
 * the new tab for the person. `owner` is the document whose Open was pressed.
 * False when the Bot's browser can't open it.
 */
export type BotBrowserHandoffOpener = (
  botId: string,
  waitId: string,
  url: string,
  hold: "handoff" | "sign_in",
  owner?: RendererDocumentOwner,
) => Promise<boolean>;

function heldKey(botId: string, waitId: string): string {
  return `${botId}\u0000${waitId}`;
}

export function createBotBrowserHandoffOpener(deps: BotBrowserHandoffDeps): BotBrowserHandoffOpener {
  /** The workspaces holding a tab for each waiting card. */
  const held = new Map<string, Set<string>>();

  const release = (botId: string, waitId: string): void => {
    const key = heldKey(botId, waitId);
    const workspaces = held.get(key);
    if (workspaces === undefined) return;
    held.delete(key);
    void deps
      .service()
      .then((service) => {
        for (const workspaceId of workspaces) service.release(workspaceId, waitId);
      })
      .catch((error: unknown) => deps.onReleaseError?.(error));
  };

  // A settled or withdrawn card gives its tabs back to the Bot.
  deps.handoffs.onSettled((prompt) => release(prompt.botId, prompt.waitId));

  return async (botId, waitId, url, hold, owner) => {
    if (hold === "handoff" && !(await deps.hasBrowserAccess(botId))) return false;
    const workspaceId = await deps.workspace(botId);
    if (workspaceId === null) return false;
    const service = await deps.service();
    const document = owner ?? (service.hasOwner(workspaceId) ? undefined : deps.mintOwner());
    if (document === undefined && !service.hasOwner(workspaceId)) return false;
    if (document !== undefined) service.transferOwner(workspaceId, document);
    const result = await service.command(workspaceId, { action: "create", url, show: true }, { source: "user" });
    if (result.tabId === undefined) return false;
    service.hold(workspaceId, result.tabId, { holdId: waitId, reason: hold });
    const key = heldKey(botId, waitId);
    held.set(key, new Set([...(held.get(key) ?? []), workspaceId]));
    // The card may have settled while the tab opened: nothing would release it then.
    if (deps.handoffs.get(botId, waitId) === undefined) release(botId, waitId);
    return true;
  };
}
