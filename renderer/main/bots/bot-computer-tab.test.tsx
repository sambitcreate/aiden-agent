import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DISABLED_APP_CAPABILITIES, type AppCapabilities } from "../../lib/app-capabilities";
import {
  BOT_COMPUTERS_CHANGED_CHANNEL,
  DEFAULT_BOT_COMPUTERS_SETTINGS,
  type BotComputersStatus,
  type BotComputerStatus,
} from "../../shared/bot-computers";
import type { BotLiveSnapshot } from "../../shared/bot-live";
import { BOT_PANEL_OPEN_KEY, BOT_PANEL_TAB_KEY } from "./bot-panel-context";
import { botFixture } from "./test-fixtures";
import { mountWithBotRouter } from "./test-providers";

const VM = "aiden-bot-0123456789abcdef";
const MAC: AppCapabilities = { ...DISABLED_APP_CAPABILITIES, platform: "darwin", bots: true, botComputers: true };

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function computer(overrides: Partial<BotComputerStatus> = {}): BotComputerStatus {
  return { botId: "bot-1", vmName: VM, state: "stopped", baseBuild: "25G83", outdated: false, controller: "bot", ...overrides };
}

function status(computers: BotComputerStatus[]): BotComputersStatus {
  return {
    setup: { kind: "ready", baseBuild: "25G83", baseVersion: "26.6.2", updateAvailable: false },
    settings: { ...DEFAULT_BOT_COMPUTERS_SETTINGS },
    diskUsedBytes: 0,
    computers,
    requirements: {
      downloadBytes: 19_772_231_540,
      baseDiskBytes: 50_000_000_000,
      setupFreeBytes: 84_196_731_252,
      memoryPerComputerBytes: 8 * 1024 ** 3,
      baseVersion: "26.6.2",
    },
  };
}

function chatSnapshot(): BotLiveSnapshot {
  return { botId: "bot-1", epoch: "e1", seq: 0, entries: [], partial: null, state: { kind: "idle" }, question: null, activity: null, queued: [] };
}

const never = () => new Promise<never>(() => undefined);

async function mountBotChat(
  state: { computers: BotComputerStatus[] },
  handlers: Record<string, (...args: unknown[]) => unknown> = {},
  capabilities: AppCapabilities = MAC,
) {
  const calls = installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => chatSnapshot(),
    "bots:live:unsubscribe": () => undefined,
    "bots:routines:list": () => [],
    "botComputers:status": () => status(state.computers),
    "botComputers:pointer": () => null,
    // The screen's own grant (start: false) is held, so no stream connects in the DOM.
    "botComputers:viewerGrant": never,
    ...handlers,
  });
  const mounted = await mountWithBotRouter(null, { initialPath: "/bots/bot-1/chat", capabilities });
  await screen.findByRole("button", { name: "Planner profile" });
  return { calls, ...mounted };
}

const botPanel = (): HTMLElement => {
  const panel = document.getElementById("bot-panel");
  assert.ok(panel, "the Bot panel is mounted");
  return panel;
};
const panelTabs = () => within(botPanel()).queryAllByRole("tab");
const tabNames = () => panelTabs().map((tab) => tab.textContent);
const selectedTab = () => panelTabs().find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
const computerCalls = (calls: BotTestIpcCall[], channel?: string) =>
  calls.filter((call) => (channel ? call.channel === channel : call.channel.startsWith("botComputers:")));

function openPanelOn(tab: string) {
  localStorage.setItem(BOT_PANEL_OPEN_KEY, "true");
  localStorage.setItem(BOT_PANEL_TAB_KEY, tab);
}

test("Computer is never offered where this Mac has no Bot computers, and main is never asked", async () => {
  openPanelOn("computer");
  const linux: AppCapabilities = { ...DISABLED_APP_CAPABILITIES, platform: "linux", bots: true };
  const { calls } = await mountBotChat({ computers: [computer({ state: "running" })] }, {}, linux);
  await waitFor(() => assert.equal(selectedTab(), "Activity"));
  assert.equal(tabNames().includes("Computer"), false);
  assert.deepEqual(computerCalls(calls), []);
});

test("Computer joins the panel while the Bot has a computer, and a saved Computer tab falls back once it is gone", async () => {
  openPanelOn("computer");
  const state = { computers: [] as BotComputerStatus[] };
  await mountBotChat(state);
  await waitFor(() => assert.equal(selectedTab(), "Activity"));
  assert.equal(tabNames().includes("Computer"), false, "a Bot without a computer");

  act(() => emitBotTestNotification(BOT_COMPUTERS_CHANGED_CHANNEL, status([computer()])));
  await waitFor(() => assert.deepEqual(tabNames(), ["Activity", "Files", "Memory", "Routines", "Computer"]));

  act(() => emitBotTestNotification(BOT_COMPUTERS_CHANGED_CHANNEL, status([])));
  await waitFor(() => assert.equal(tabNames().includes("Computer"), false, "the computer was removed"));
});

test("a Computer tab restored at launch never starts the computer; the person switching to it does", async () => {
  openPanelOn("computer");
  const state = { computers: [computer()] };
  let finishStart: (() => void) | undefined;
  const { calls } = await mountBotChat(state, {
    "botComputers:viewerGrant": (_botId, options) =>
      (options as { start: boolean }).start
        ? new Promise((resolve) => {
            finishStart = () => {
              state.computers = [computer({ state: "running" })];
              resolve({ hostId: "bot-computers", deviceId: VM, grant: { origin: "http://127.0.0.1:52100", token: "a".repeat(43), expiresAt: Date.now() + 60_000 } });
            };
          })
        : never(),
  });
  await waitFor(() => assert.equal(selectedTab(), "Computer"));
  const panel = botPanel();
  await within(panel).findByText("Planner's computer is off");
  assert.ok(within(panel).getByRole("button", { name: "Start" }));
  assert.deepEqual(computerCalls(calls, "botComputers:viewerGrant"), [], "nothing started on its own");

  fireEvent.click(within(panel).getByRole("tab", { name: "Activity" }));
  fireEvent.click(within(panel).getByRole("tab", { name: "Computer" }));
  await waitFor(() =>
    assert.deepEqual(
      computerCalls(calls, "botComputers:viewerGrant").map((call) => call.args),
      [["bot-1", { start: true }]],
    ),
  );
  const banner = within(panel).getByText("Starting Planner's computer…").closest("[data-bot-computer-banner]");
  assert.equal(banner?.getAttribute("role"), "status", "the start is announced");

  await act(async () => finishStart?.());
  // The start refreshes the status; the running computer's screen replaces the banner.
  const screenElement = await waitFor(() => {
    const element = panel.querySelector<HTMLElement>(`[data-bot-computer-screen="${VM}"]`);
    assert.ok(element, "the live screen");
    return element;
  });
  assert.equal(screenElement.getAttribute("role"), "application");
  assert.equal(within(panel).queryByText("Starting Planner's computer…"), null);
  // The screen asks only for a grant that never starts anything.
  await waitFor(() =>
    assert.deepEqual(
      computerCalls(calls, "botComputers:viewerGrant").map((call) => (call.args[1] as { start: boolean }).start),
      [true, false],
    ),
  );
});

test("while the Bot drives, the screen is read-only with its avatar at the last action point, and Take over and Give back hand it across", async () => {
  openPanelOn("computer");
  const running = computer({ state: "running", activity: "Clicking Save" });
  const { calls } = await mountBotChat(
    { computers: [running] },
    {
      "botComputers:pointer": () => ({ x: 256, y: 576, width: 1024, height: 768 }),
      "botComputers:takeOver": () => ({ ...running, controller: "person", activity: undefined }),
      "botComputers:giveBack": () => ({ ...running, controller: "bot" }),
    },
  );
  const panel = botPanel();
  const screenElement = await waitFor(() => {
    const element = panel.querySelector<HTMLElement>("[data-bot-computer-screen]");
    assert.ok(element);
    return element;
  });
  assert.match(screenElement.getAttribute("aria-label") ?? "", /Planner is using it; click or type here to take over/u);
  assert.ok(within(panel).getByText("Planner is using it · Click or type to take over"));
  assert.ok(within(panel).getByText("Clicking Save"), "the status line says what the Bot is doing");
  const avatar = await waitFor(() => {
    const element = panel.querySelector<HTMLElement>("[data-bot-computer-pointer]");
    assert.ok(element, "the Bot's avatar on the screen");
    return element;
  });
  assert.equal(avatar.style.left, "25%");
  assert.equal(avatar.style.top, "75%");

  fireEvent.click(within(panel).getByRole("button", { name: "Take over" }));
  await waitFor(() => assert.ok(within(panel).getByRole("button", { name: "Give back" })));
  assert.deepEqual(computerCalls(calls, "botComputers:takeOver").map((call) => call.args), [["bot-1"]]);
  assert.ok(within(panel).getByText("You're using Planner's computer"));
  assert.equal(within(panel).queryByText("Planner is using it · Click or type to take over"), null);
  assert.equal(panel.querySelector("[data-bot-computer-pointer]"), null, "no avatar while the person drives");
  const polled = computerCalls(calls, "botComputers:pointer").length;

  fireEvent.click(within(panel).getByRole("button", { name: "Give back" }));
  await waitFor(() => assert.ok(within(panel).getByRole("button", { name: "Take over" })));
  assert.deepEqual(computerCalls(calls, "botComputers:giveBack").map((call) => call.args), [["bot-1"]]);
  assert.ok(computerCalls(calls, "botComputers:pointer").length > polled, "the avatar is read again once the Bot drives");

  // Input on the screen takes over in main; its broadcast flips the tab the same way.
  act(() => emitBotTestNotification(BOT_COMPUTERS_CHANGED_CHANNEL, status([{ ...running, controller: "person" }])));
  await waitFor(() => assert.ok(within(panel).getByRole("button", { name: "Give back" })));
});

test("with Browser and Computer both shown, the six tabs keep their order and Open tabs reaches Computer, which starts it", async () => {
  openPanelOn("activity");
  const workspaceId = "bot-home-1";
  const browserState = {
    workspaceId, revision: 1, activeTabId: "tab-1", profiles: [], defaults: {}, agentAccessOverride: "inherit", agentAccessAllowed: true, history: [], servers: [],
    tabs: [{
      id: "tab-1", workspaceId, profileId: "bot:bot-1", url: "https://example.com/", title: "Example", loading: false, canGoBack: false,
      canGoForward: false, crashed: false, audible: false, muted: false, viewport: { mode: "fill", width: 1280, height: 720 },
      appearance: "system", zoom: 1, recording: false, agentControlling: false, floating: false, visible: true,
    }],
  };
  const { calls } = await mountBotChat(
    { computers: [computer()] },
    {
      "bots:browser:workspace": () => ({ workspaceId }),
      "browser:get-state": () => browserState,
      "botComputers:viewerGrant": never,
    },
  );
  const panel = botPanel();
  await waitFor(() => assert.deepEqual(tabNames(), ["Activity", "Files", "Memory", "Routines", "Browser", "Computer"]));
  fireEvent.keyDown(within(panel).getByRole("button", { name: "Open tabs" }), { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Activity", "Files", "Memory", "Routines", "Browser", "Computer"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Computer" }));
  await waitFor(() => assert.equal(selectedTab(), "Computer"));
  await waitFor(() =>
    assert.deepEqual(
      computerCalls(calls, "botComputers:viewerGrant").map((call) => call.args),
      [["bot-1", { start: true }]],
      "choosing Computer from the list is the person switching to it",
    ),
  );
});

test("a failed start says why and offers Try again", async () => {
  openPanelOn("activity");
  await mountBotChat(
    { computers: [computer()] },
    {
      "botComputers:viewerGrant": () => {
        throw new Error("Not enough free memory to start Planner's computer.");
      },
    },
  );
  const panel = botPanel();
  fireEvent.click(await within(panel).findByRole("tab", { name: "Computer" }));
  const alert = await within(panel).findByRole("alert");
  assert.match(alert.textContent ?? "", /Not enough free memory/u);
  assert.ok(within(panel).getByRole("button", { name: "Try again" }));
});

test("Float over chat moves the screen over the chat, and Escape or Dock brings it back to the tab", async () => {
  openPanelOn("computer");
  await mountBotChat({ computers: [computer({ state: "running" })] });
  const panel = botPanel();
  fireEvent.click(await within(panel).findByRole("button", { name: "Float over chat" }));

  const float = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-bot-computer-float="bot-1"]');
    assert.ok(element, "the floating computer");
    return element;
  });
  // The DOM has no chat area to measure, so the frame stays visibility-hidden and roles have no names; find controls by label.
  const labelled = (root: HTMLElement, label: string) => {
    const element = root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    assert.ok(element, label);
    return element;
  };
  assert.equal(float.getAttribute("aria-roledescription"), "floating computer");
  assert.ok(within(float).getByText("Planner's computer"));
  assert.equal(labelled(float, "Take over").tagName, "BUTTON", "Take over travels with the screen");
  assert.ok(float.querySelector(`[data-bot-computer-screen="${VM}"]`), "the float streams the screen");
  assert.equal(panel.querySelector("[data-bot-computer-screen]"), null, "and the tab does not stream a second copy");
  assert.ok(within(panel).getByText("Planner's computer is floating over the chat"));

  fireEvent.keyDown(labelled(float, "Move Planner's computer"), { key: "Escape" });
  await waitFor(() => assert.equal(document.querySelector("[data-bot-computer-float]"), null));
  await waitFor(() => assert.ok(panel.querySelector(`[data-bot-computer-screen="${VM}"]`)));

  // Docking from the float reopens the panel on Computer.
  fireEvent.click(within(panel).getByRole("button", { name: "Float over chat" }));
  fireEvent.click(within(panel).getByRole("tab", { name: "Activity" }));
  const again = await waitFor(() => {
    const element = document.querySelector<HTMLElement>("[data-bot-computer-float]");
    assert.ok(element);
    return element;
  });
  fireEvent.click(labelled(again, "Dock Planner's computer in the Bot panel"));
  await waitFor(() => assert.equal(selectedTab(), "Computer"));
  assert.equal(document.querySelector("[data-bot-computer-float]"), null);
});
