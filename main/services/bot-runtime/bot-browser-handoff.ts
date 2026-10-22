// A hand-off card's Open in the Bot's own browser (blueprint §2.5, G14): the
// `botBrowser` opener of `bot-handoff-open.ts`.
//
// - A sign-in opens its site in a new tab of the Bot's browser. An action's
//   link opens in the Bot's tab already showing that page (a rule handed the
//   Bot's own step there to the person), else in a new tab. Either is shown
//   to the person (`source: "user"`, so the panel's Browser tab comes
//   forward).
// - Open again on the same card brings back the tab it already opened,
//   rather than opening another.
// - The tab is held for the person (`sign_in` or `handoff`) under the card's
//   `waitId`: the Bot can't read or drive it until the card settles or is
//   withdrawn, which releases it. A card asked again under its `waitId` is
//   the same card and keeps its tab. A tab two waiting cards opened (both
//   pages the same) stays held until neither waits.
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
 * its tab for the person. `owner` is the document whose Open was pressed.
 * False when the Bot's browser can't open it.
 */
export type BotBrowserHandoffOpener = (
  botId: string,
  waitId: string,
  url: string,
  hold: "handoff" | "sign_in",
  owner?: RendererDocumentOwner,
) => Promise<boolean>;

interface HeldTab {
  workspaceId: string;
  tabId: string;
}

/** The tabs one waiting card opened. */
interface CardTabs {
  botId: string;
  waitId: string;
  hold: "handoff" | "sign_in";
  tabs: HeldTab[];
}

function heldKey(botId: string, waitId: string): string {
  return `${botId}\u0000${waitId}`;
}

export function createBotBrowserHandoffOpener(deps: BotBrowserHandoffDeps): BotBrowserHandoffOpener {
  /** The tabs each waiting card holds. */
  const held = new Map<string, CardTabs>();

  /** Another waiting card of `botId` that opened `tab` too. */
  const otherHolder = (botId: string, waitId: string, tab: HeldTab): CardTabs | undefined =>
    [...held.values()].find(
      (card) =>
        card.botId === botId &&
        card.waitId !== waitId &&
        card.tabs.some((each) => each.workspaceId === tab.workspaceId && each.tabId === tab.tabId),
    );

  const release = (botId: string, waitId: string): void => {
    const key = heldKey(botId, waitId);
    const card = held.get(key);
    if (card === undefined) return;
    held.delete(key);
    // The browser keeps one hold per tab: a tab another waiting card opened
    // passes to that card, so the release below leaves it held.
    const handedOver = card.tabs.flatMap((tab) => {
      const next = otherHolder(botId, waitId, tab);
      return next === undefined ? [] : [{ tab, next }];
    });
    void deps
      .service()
      .then((service) => {
        for (const { tab, next } of handedOver) service.hold(tab.workspaceId, tab.tabId, { holdId: next.waitId, reason: next.hold });
        for (const workspaceId of new Set(card.tabs.map((tab) => tab.workspaceId))) service.release(workspaceId, waitId);
      })
      .catch((error: unknown) => deps.onReleaseError?.(error));
  };

  // A settled or withdrawn card gives its tabs back to the Bot. One asked
  // again under the same `waitId` (its stale invocation withdrawn) is the
  // same card and keeps them: `request` registers it right after withdrawing
  // the old one, so it waits again by the time this runs.
  deps.handoffs.onSettled((prompt) => {
    queueMicrotask(() => {
      if (deps.handoffs.get(prompt.botId, prompt.waitId) === undefined) release(prompt.botId, prompt.waitId);
    });
  });

  /** The tab this card already opened in `workspaceId`, brought forward; `undefined` when the person closed it. */
  async function reopen(service: BotBrowserHandoffService, key: string, workspaceId: string): Promise<string | undefined> {
    for (const tab of held.get(key)?.tabs ?? []) {
      if (tab.workspaceId !== workspaceId) continue;
      try {
        await service.command(workspaceId, { action: "select", tabId: tab.tabId }, { source: "user" });
        return tab.tabId;
      } catch {
        // Closed since: forget it, and open the page again below.
        const card = held.get(key);
        if (card === undefined) continue;
        card.tabs = card.tabs.filter((each) => each !== tab);
        if (card.tabs.length === 0) held.delete(key);
      }
    }
    return undefined;
  }

  return async (botId, waitId, url, hold, owner) => {
    if (hold === "handoff" && !(await deps.hasBrowserAccess(botId))) return false;
    const workspaceId = await deps.workspace(botId);
    if (workspaceId === null) return false;
    const service = await deps.service();
    const document = owner ?? (service.hasOwner(workspaceId) ? undefined : deps.mintOwner());
    if (document === undefined && !service.hasOwner(workspaceId)) return false;
    if (document !== undefined) service.transferOwner(workspaceId, document);
    const key = heldKey(botId, waitId);
    let tabId = await reopen(service, key, workspaceId);
    if (tabId === undefined) {
      // `open_link` shows the Bot's tab already on that page, else opens one.
      const command: BrowserCommand =
        hold === "sign_in" ? { action: "create", url, show: true } : { action: "open_link", url };
      tabId = (await service.command(workspaceId, command, { source: "user" })).tabId;
    }
    if (tabId === undefined) return false;
    service.hold(workspaceId, tabId, { holdId: waitId, reason: hold });
    const tabs = (held.get(key)?.tabs ?? []).filter((tab) => !(tab.workspaceId === workspaceId && tab.tabId === tabId));
    held.set(key, { botId, waitId, hold, tabs: [...tabs, { workspaceId, tabId }] });
    // The card may have settled while the tab opened: nothing would release it then.
    if (deps.handoffs.get(botId, waitId) === undefined) release(botId, waitId);
    return true;
  };
}
