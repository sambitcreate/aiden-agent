import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserPanel } from "../../components/browser-panel";
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_SETTINGS,
  type BrowserState,
  type BrowserTab,
} from "../../shared/browser";
import type { BotLiveSnapshot } from "../../shared/bot-live";
import { BOT_PANEL_OPEN_KEY, BOT_PANEL_TAB_KEY } from "./bot-panel-context";
import { botFixture } from "./test-fixtures";
import { mountWithBotRouter } from "./test-providers";

const WORKSPACE = "bot-home-1";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function browserTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: "tab-1", workspaceId: WORKSPACE, profileId: "bot:bot-1", url: "https://github.com/login", title: "Sign in to GitHub",
    loading: false, canGoBack: false, canGoForward: false, crashed: false, audible: false, muted: false,
    viewport: { mode: "fill", width: 1280, height: 720 }, appearance: "system", zoom: 1, recording: false,
    agentControlling: false, floating: false, visible: true, ...overrides,
  };
}

function browserState(tabs: BrowserTab[]): BrowserState {
  return {
    workspaceId: WORKSPACE, revision: 1, tabs, activeTabId: tabs[0]?.id ?? null,
    profiles: structuredClone(BUILT_IN_BROWSER_PROFILES), defaults: structuredClone(DEFAULT_BROWSER_SETTINGS),
    agentAccessOverride: "inherit", agentAccessAllowed: true, history: [{ url: "https://bank.example/", title: "My bank", visitedAt: 1 }],
    servers: [],
  };
}

function chatSnapshot(): BotLiveSnapshot {
  return { botId: "bot-1", epoch: "e1", seq: 0, entries: [], partial: null, state: { kind: "idle" }, question: null, activity: null, queued: [] };
}

/** The browser IPC as the Bot's own browser answers it: `state()` is read on every call. */
function browserIpc(state: () => BrowserState) {
  return {
    "bots:browser:workspace": () => ({ workspaceId: WORKSPACE }),
    "browser:get-state": (workspaceId: unknown) => {
      assert.equal(workspaceId, WORKSPACE);
      return state();
    },
    "browser:command": () => ({ state: state() }),
  };
}

async function mountBotChat(state: () => BrowserState) {
  const calls = installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => chatSnapshot(),
    "bots:live:unsubscribe": () => undefined,
    "bots:routines:list": () => [],
    ...browserIpc(state),
  });
  const mounted = await mountWithBotRouter(null, { initialPath: "/bots/bot-1/chat" });
  await screen.findByRole("button", { name: "Planner profile" });
  return { calls, ...mounted };
}

const botPanel = (): HTMLElement => {
  const panel = document.getElementById("bot-panel");
  assert.ok(panel, "the Bot panel is mounted");
  return panel;
};
const panelTabs = () => within(botPanel()).queryAllByRole("tab").filter((tab) => tab.closest(".browser-panel") === null);
const tabNames = () => panelTabs().map((tab) => tab.textContent);
const selectedTab = () => panelTabs().find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

test("Browser joins the Bot panel once its browser has a tab; a saved Browser tab shows Activity until then", async () => {
  localStorage.setItem(BOT_PANEL_OPEN_KEY, "true");
  localStorage.setItem(BOT_PANEL_TAB_KEY, "browser");
  let tabs: BrowserTab[] = [];
  await mountBotChat(() => browserState(tabs));
  await waitFor(() => assert.equal(selectedTab(), "Activity"));
  assert.deepEqual(tabNames(), ["Activity", "Files", "Memory", "Routines"]);

  tabs = [browserTab()];
  await act(async () => emitBotTestNotification("browser:event", { type: "state", state: browserState(tabs) }));
  await waitFor(() => assert.deepEqual(tabNames(), ["Activity", "Files", "Memory", "Routines", "Browser"]));
  assert.equal(selectedTab(), "Browser", "the saved choice comes back once there is something to show");

  // Closing the last tab keeps the Browser view where the person is.
  tabs = [];
  await act(async () => emitBotTestNotification("browser:event", { type: "state", state: browserState(tabs) }));
  assert.equal(selectedTab(), "Browser");
  assert.ok(await within(botPanel()).findByText(/Planner opens pages here/u));
});

test("a tab the Bot opens to show reveals its Browser tab without taking focus from the person", async () => {
  let tabs: BrowserTab[] = [];
  await mountBotChat(() => browserState(tabs));
  assert.equal(botPanel().getAttribute("data-state"), "closed");
  const composer = screen.getByRole("textbox");
  composer.focus();

  tabs = [browserTab({ agentControlling: true, url: "https://shop.example.com/", title: "Shop" })];
  await act(async () => emitBotTestNotification("browser:event", { type: "show", workspaceId: WORKSPACE, tabId: "tab-1" }));
  await waitFor(() => assert.equal(botPanel().getAttribute("data-state"), "open"));
  assert.equal(selectedTab(), "Browser");
  assert.ok(await within(botPanel()).findByText("Planner is using this browser"));
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(document.activeElement === composer, true, "the person keeps typing where they were");

  // Another Bot's browser opening a tab changes nothing here.
  await act(async () => emitBotTestNotification("browser:event", { type: "show", workspaceId: "bot-home-2", tabId: "x" }));
  assert.equal(selectedTab(), "Browser");
});

test("a Bot's browser has no profile choice, annotations, DevTools, capture, recording or floating; a workspace browser keeps them", async () => {
  const state = browserState([browserTab()]);
  installBotTestIpc(browserIpc(() => state));
  const menuItems = async () => {
    fireEvent.keyDown(screen.getByRole("button", { name: "Browser menu" }), { key: "Enter" });
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent ?? "");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    return items;
  };

  const workspace = render(<BrowserPanel workspaceId={WORKSPACE} active />);
  await screen.findByRole("tab", { name: "Sign in to GitHub" });
  assert.ok(screen.getByRole("button", { name: "Choose browser profile" }));
  assert.ok(screen.getByRole("button", { name: "Annotate" }));
  const full = await menuItems();
  for (const item of ["Open DevTools", "Record browser", "Float browser over chat", "Open separate preview window", "Clear cookies"]) {
    assert.ok(full.some((entry) => entry.includes(item)), item);
  }
  workspace.unmount();

  render(<BrowserPanel workspaceId={WORKSPACE} active variant="bot" agentName="Planner" />);
  await screen.findByRole("tab", { name: "Sign in to GitHub" });
  assert.equal(screen.queryByRole("button", { name: "Choose browser profile" }), null);
  assert.equal(screen.queryByRole("button", { name: "Annotate" }), null);
  const bot = await menuItems();
  assert.ok(bot.some((entry) => entry.includes("Open in system browser")));
  for (const item of ["Open DevTools", "Capture screenshot", "Record browser", "Float browser over chat", "Open separate preview window", "Clear cookies", "Browser settings"]) {
    assert.equal(bot.some((entry) => entry.includes(item)), false, item);
  }
});

test("a tab the person holds says so and names the Bot, and an empty Bot browser never lists the person's history", async () => {
  let state = browserState([browserTab({ heldForPerson: { reason: "sign_in" } })]);
  installBotTestIpc(browserIpc(() => state));
  const view = render(<BrowserPanel workspaceId={WORKSPACE} active variant="bot" agentName="Planner" />);
  const notice = await screen.findByText(/This tab is yours: sign in, then press Done on Planner’s card/u);
  assert.equal(notice.getAttribute("role"), "status");
  view.unmount();

  state = browserState([]);
  const workspace = render(<BrowserPanel workspaceId={WORKSPACE} active />);
  assert.ok(await screen.findByText("My bank"), "a workspace browser starts from recent pages");
  workspace.unmount();
  render(<BrowserPanel workspaceId={WORKSPACE} active variant="bot" agentName="Planner" />);
  assert.ok(await screen.findByText(/Planner opens pages here, with its own sign-ins/u));
  assert.equal(screen.queryByText("My bank"), null);
});
