import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserCommand, BrowserHoldReason } from "../../../renderer/shared/browser.js";
import type { BrowserCommandContext } from "../browser/service.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { createBotBrowserHandoffOpener, type BotBrowserHandoffService } from "./bot-browser-handoff.js";
import { createBotHandoffs } from "./bot-handoffs.js";

const BOT = "bot:ada";
const WORKSPACE = "bot-home-ada";

function owner(id: number): RendererDocumentOwner {
  return { id, documentId: `document-${id}`, isDestroyed: () => false, send: () => undefined, onInvalidated: () => () => undefined };
}

/** The Bot's browser: tabs, the holds on them, and the window that shows it. */
function fakeBrowser(options: { owner?: RendererDocumentOwner } = {}) {
  const tabs = new Map<string, { url: string; hold?: { holdId: string; reason: BrowserHoldReason } }>();
  const created: Array<{ command: BrowserCommand; context: BrowserCommandContext }> = [];
  let opened = 0;
  let shownIn = options.owner;
  const service: BotBrowserHandoffService = {
    hasOwner: () => shownIn !== undefined,
    transferOwner(workspaceId, next) {
      assert.equal(workspaceId, WORKSPACE);
      shownIn = next;
    },
    // As the browser service runs them: `open_link` shows a tab already on the
    // page, else opens one; `select` needs a tab that is still open.
    async command(workspaceId, command, context) {
      assert.equal(workspaceId, WORKSPACE);
      created.push({ command, context });
      if (command.action === "select") {
        if (!tabs.has(command.tabId)) throw new Error("This browser tab is no longer available.");
        return { state: {} as never, tabId: command.tabId };
      }
      const url = (command as { url?: string }).url ?? "about:blank";
      if (command.action === "open_link") {
        const existing = [...tabs].find(([, tab]) => tab.url === url)?.[0];
        if (existing !== undefined) return { state: {} as never, tabId: existing };
      }
      const tabId = `tab-${(opened += 1)}`;
      tabs.set(tabId, { url });
      return { state: {} as never, tabId };
    },
    hold(workspaceId, tabId, hold) {
      assert.equal(workspaceId, WORKSPACE);
      tabs.get(tabId)!.hold = hold;
    },
    release(workspaceId, holdId) {
      assert.equal(workspaceId, WORKSPACE);
      for (const tab of tabs.values()) if (tab.hold?.holdId === holdId) delete tab.hold;
    },
    // The most recently opened tab is the one on screen.
    getState(workspaceId) {
      assert.equal(workspaceId, WORKSPACE);
      return { activeTabId: [...tabs.keys()].pop() ?? null };
    },
  };
  return {
    service,
    tabs,
    created,
    shownIn: () => shownIn,
    heldBy: (tabId: string) => tabs.get(tabId)?.hold,
  };
}

function setup(options: { browserAccess?: boolean; owner?: RendererDocumentOwner; window?: RendererDocumentOwner; workspace?: string | null } = {}) {
  const browser = fakeBrowser({ owner: options.owner });
  const handoffs = createBotHandoffs();
  const open = createBotBrowserHandoffOpener({
    service: async () => browser.service,
    handoffs,
    workspace: async () => ("workspace" in options ? options.workspace! : WORKSPACE),
    hasBrowserAccess: async () => options.browserAccess ?? true,
    mintOwner: () => options.window,
  });
  const ask = (waitId: string, kind: "action" | "sign_in" = "sign_in") => {
    const controller = new AbortController();
    const answer = handoffs
      .request({
        botId: BOT, waitId, toolCallId: `call-${waitId}`, kind, action: "Sign in to github.com",
        open: { url: "https://github.com" }, source: "tool", signal: controller.signal,
      })
      .catch(() => null);
    return { controller, answer };
  };
  return { browser, handoffs, open, ask };
}

/** Lets the release, which loads the browser service, land. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a sign-in opens a shown tab in the Bot's browser, held for the person until they answer", async () => {
  const { browser, handoffs, open, ask } = setup({ owner: owner(1) });
  const card = ask("wait-1");
  assert.equal(await open(BOT, "wait-1", "https://github.com", "sign_in"), true);
  assert.deepEqual(browser.created.map(({ command, context }) => [command, context.source]), [
    [{ action: "create", url: "https://github.com", show: true }, "user"],
  ]);
  assert.deepEqual(browser.heldBy("tab-1"), { holdId: "wait-1", reason: "sign_in" });

  handoffs.answer(BOT, "wait-1", { outcome: "done" });
  await card.answer;
  await settled();
  assert.equal(browser.heldBy("tab-1"), undefined, "the Bot has its tab back");
});

test("a withdrawn card releases its tab, and another card's tab stays held", async () => {
  const { browser, open, ask } = setup({ owner: owner(1) });
  const first = ask("wait-1");
  ask("wait-2");
  await open(BOT, "wait-1", "https://github.com", "sign_in");
  await open(BOT, "wait-2", "https://shop.example.com/cart", "handoff");

  first.controller.abort(new Error("Stopped"));
  await first.answer;
  await settled();
  assert.equal(browser.heldBy("tab-1"), undefined);
  assert.deepEqual(browser.heldBy("tab-2"), { holdId: "wait-2", reason: "handoff" });
});

test("a card that settled while its tab opened doesn't leave the tab held", async () => {
  const { browser, handoffs, open, ask } = setup({ owner: owner(1) });
  const card = ask("wait-1");
  const create = browser.service.command.bind(browser.service);
  browser.service.command = async (...args) => {
    handoffs.answer(BOT, "wait-1", { outcome: "skipped" });
    return create(...args);
  };
  assert.equal(await open(BOT, "wait-1", "https://github.com", "sign_in"), true);
  await card.answer;
  await settled();
  assert.equal(browser.heldBy("tab-1"), undefined);
});

test("the window whose Open was pressed shows the tab; without one, the window already showing it, else the current one", async () => {
  const pressed = setup({ owner: owner(1), window: owner(3) });
  pressed.ask("wait-1");
  await pressed.open(BOT, "wait-1", "https://github.com", "sign_in", owner(2));
  assert.equal(pressed.browser.shownIn()?.id, 2);

  const fromPhone = setup({ owner: owner(1), window: owner(3) });
  fromPhone.ask("wait-1");
  await fromPhone.open(BOT, "wait-1", "https://github.com", "sign_in");
  assert.equal(fromPhone.browser.shownIn()?.id, 1, "the Bot's browser stays where it is shown");

  const unshown = setup({ window: owner(3) });
  unshown.ask("wait-1");
  await unshown.open(BOT, "wait-1", "https://github.com", "sign_in");
  assert.equal(unshown.browser.shownIn()?.id, 3);
});

test("nothing opens with no window, for a Bot that is gone, or for an action card of a Bot without the browser", async () => {
  const noWindow = setup();
  noWindow.ask("wait-1");
  assert.equal(await noWindow.open(BOT, "wait-1", "https://github.com", "sign_in"), false);
  assert.equal(noWindow.browser.created.length, 0);

  const gone = setup({ owner: owner(1), workspace: null });
  assert.equal(await gone.open(BOT, "wait-1", "https://github.com", "sign_in"), false);
  assert.equal(gone.browser.created.length, 0);

  // An action's link then opens in the system browser; a sign-in still opens here.
  const noAccess = setup({ owner: owner(1), browserAccess: false });
  noAccess.ask("wait-1", "action");
  assert.equal(await noAccess.open(BOT, "wait-1", "https://shop.example.com/cart", "handoff"), false);
  assert.equal(noAccess.browser.created.length, 0);
  noAccess.ask("wait-2");
  assert.equal(await noAccess.open(BOT, "wait-2", "https://github.com", "sign_in"), true);
});

test("an action card's Open shows the Bot's tab already on that page and holds it, rather than opening another", async () => {
  const { browser, open, ask } = setup({ owner: owner(1) });
  // The Bot was on the cart when a rule handed the purchase to the person.
  browser.tabs.set("tab-0", { url: "https://shop.example.com/cart" });
  ask("wait-1", "action");
  assert.equal(await open(BOT, "wait-1", "https://shop.example.com/cart", "handoff"), true);
  assert.deepEqual(browser.created.map(({ command, context }) => [command, context.source]), [
    [{ action: "open_link", url: "https://shop.example.com/cart" }, "user"],
  ]);
  assert.equal(browser.tabs.size, 1);
  assert.deepEqual(browser.heldBy("tab-0"), { holdId: "wait-1", reason: "handoff" });
});

test("a step that names no page holds the tab the Bot is on, as it is, and opens nothing without one", async () => {
  const { browser, handoffs, open, ask } = setup({ owner: owner(1) });
  const card = ask("wait-1", "action");
  assert.equal(await open(BOT, "wait-1", undefined, "handoff"), false, "no tab yet: nothing to hold");
  assert.equal(browser.created.length, 0);
  browser.tabs.set("tab-9", { url: "https://shop.example/checkout" });
  assert.equal(await open(BOT, "wait-1", undefined, "handoff"), true);
  assert.deepEqual(browser.created.map(({ command, context }) => [command, context.source]), [
    [{ action: "select", tabId: "tab-9" }, "user"],
  ]);
  assert.equal(browser.tabs.get("tab-9")?.url, "https://shop.example/checkout", "the page stays where the Bot left it");
  assert.deepEqual(browser.heldBy("tab-9"), { holdId: "wait-1", reason: "handoff" });
  assert.equal(await open(BOT, "wait-2", undefined, "sign_in"), false, "a sign-in always names its page");

  handoffs.answer(BOT, "wait-1", { outcome: "done" });
  await card.answer;
  await settled();
  assert.equal(browser.heldBy("tab-9"), undefined);
});

test("Open again on the same card brings back the tab it opened; once the person closed it, the page opens again", async () => {
  const { browser, handoffs, open, ask } = setup({ owner: owner(1) });
  const card = ask("wait-1");
  await open(BOT, "wait-1", "https://github.com", "sign_in");
  await open(BOT, "wait-1", "https://github.com", "sign_in");
  assert.deepEqual(
    browser.created.map(({ command }) => command),
    [{ action: "create", url: "https://github.com", show: true }, { action: "select", tabId: "tab-1" }],
  );
  assert.equal(browser.tabs.size, 1);

  browser.tabs.delete("tab-1");
  await open(BOT, "wait-1", "https://github.com", "sign_in");
  assert.deepEqual(browser.created[browser.created.length - 1]?.command, { action: "create", url: "https://github.com", show: true });
  assert.deepEqual(browser.heldBy("tab-2"), { holdId: "wait-1", reason: "sign_in" });

  handoffs.answer(BOT, "wait-1", { outcome: "done" });
  await card.answer;
  await settled();
  assert.equal(browser.heldBy("tab-2"), undefined);
});

test("a card asked again under the same wait id keeps the tab the person is using, and Open brings it back", async () => {
  const { browser, handoffs, open, ask } = setup({ owner: owner(1) });
  ask("wait-1");
  await open(BOT, "wait-1", "https://github.com", "sign_in");
  // The same call asks again (a stale invocation is withdrawn): it is the same card.
  const again = ask("wait-1");
  await settled();
  assert.deepEqual(browser.heldBy("tab-1"), { holdId: "wait-1", reason: "sign_in" }, "the person is still signing in there");
  await open(BOT, "wait-1", "https://github.com", "sign_in");
  assert.equal(browser.tabs.size, 1, "Open shows the tab the person was using");
  assert.deepEqual(browser.created[browser.created.length - 1]?.command, { action: "select", tabId: "tab-1" });

  handoffs.answer(BOT, "wait-1", { outcome: "done" });
  await again.answer;
  await settled();
  assert.equal(browser.heldBy("tab-1"), undefined, "answered, the tab goes back to the Bot");
});

test("a tab two cards opened stays held until neither waits, whichever settles first", async () => {
  for (const first of ["wait-1", "wait-2"] as const) {
    const { browser, handoffs, open, ask } = setup({ owner: owner(1) });
    const cards = { "wait-1": ask("wait-1", "action"), "wait-2": ask("wait-2", "action") };
    await open(BOT, "wait-1", "https://shop.example.com/cart", "handoff");
    // The second card's page is the same: `open_link` shows the tab the first opened.
    await open(BOT, "wait-2", "https://shop.example.com/cart", "handoff");
    assert.equal(browser.tabs.size, 1);
    const second = first === "wait-1" ? "wait-2" : "wait-1";

    handoffs.answer(BOT, first, { outcome: "done" });
    await cards[first].answer;
    await settled();
    assert.deepEqual(browser.heldBy("tab-1"), { holdId: second, reason: "handoff" }, `${first} settled first: ${second} still waits`);

    handoffs.answer(BOT, second, { outcome: "done" });
    await cards[second].answer;
    await settled();
    assert.equal(browser.heldBy("tab-1"), undefined);
  }
});
