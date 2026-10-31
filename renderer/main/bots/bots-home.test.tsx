import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import { MCP_PRESETS } from "../../../main/services/mcp-presets";
import { BotConnectionSetupHost } from "./bot-connection-setup-host";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BotsView } from "../bots-view";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queries";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";
import { BOT_SIDEBAR_PREFERENCES_KEY, serializeBotSidebarPreferences } from "../../lib/bot-sidebar-preferences";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const idle = { botId: "bot-1", preview: null, updatedAt: null, state: { kind: "idle" }, needsYou: false, lastReplyAt: null };

const PLANNER = botFixture();
const INBOX = botFixture({ id: "bot-2", name: "Inbox" });

function twoBots(updatedAt: Record<string, number>) {
  installBotTestIpc({
    "bots:list": () => [PLANNER, INBOX],
    "bots:live:summary": (botId) => ({ ...idle, botId, updatedAt: updatedAt[botId as string] ?? null }),
    "bots:get": (botId) => [PLANNER, INBOX].find((bot) => bot.id === botId) ?? null,
    "bots:live:subscribe": (botId) => ({ ...idle, botId, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [] }),
    "bots:pendingApprovals": () => [],
  });
}

test("/bots opens the chat of the Bot the person last looked at", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: null, lastViewed: { "bot-2": 50 }, seenReplyAt: {} }),
  );
  twoBots({ "bot-1": 900, "bot-2": 100 });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  assert.equal(screen.queryByRole("heading", { name: "Meet your first Bot" }), null);
});

test("with nothing viewed yet, or the last one deleted, /bots opens the Bot with the newest activity", async () => {
  twoBots({ "bot-1": 100, "bot-2": 900 });
  const first = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  await waitFor(() => assert.equal(first.router.state.location.pathname, "/bots/bot-2/chat"));
  cleanup();
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: null, lastViewed: { "bot-gone": 999 }, seenReplyAt: {} }),
  );
  twoBots({ "bot-1": 900, "bot-2": 100 });
  const second = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  await waitFor(() => assert.equal(second.router.state.location.pathname, "/bots/bot-1/chat"));
});

test("/bots replaces its own entry, so Back does not return to it", async () => {
  twoBots({ "bot-1": 100, "bot-2": 900 });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  assert.equal(router.history.length, 1);
});

function hungSummaryIpc(summary: (botId: unknown) => unknown = () => new Promise(() => {})) {
  // The Bots' own times disagree with what the summaries would say, so the test can tell which ordered the pick.
  const planner = botFixture({ updatedAt: 100 });
  const inbox = botFixture({ id: "bot-2", name: "Inbox", updatedAt: 900 });
  installBotTestIpc({
    "bots:list": () => [planner, inbox],
    "bots:live:summary": summary,
    "bots:get": (botId) => [planner, inbox].find((bot) => bot.id === botId) ?? null,
    "bots:live:subscribe": (botId) => ({ ...idle, botId, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [] }),
    "bots:pendingApprovals": () => [],
  });
}

test("a summary that never answers does not leave /bots blank: it shows a skeleton, then opens the Bot updated last", async () => {
  hungSummaryIpc();
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  assert.ok(await screen.findByRole("status", { name: "Opening your Bot" }));
  assert.equal(router.state.location.pathname, "/bots");
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"), { timeout: 3000 });
});

/** Counts the summaries' grace timers that are still pending (set, and neither fired nor cleared) and those that fired. */
function trackGraceTimers() {
  const pending = new Set<unknown>();
  let fired = 0;
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 800) return realSet(callback, delay, ...args);
    const id: unknown = realSet(() => {
      pending.delete(id);
      fired += 1;
      callback();
    }, delay);
    pending.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(id);
    realClear(id);
  }) as typeof clearTimeout;
  return {
    pending: () => pending.size,
    fired: () => fired,
    restore: () => {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

test("leaving /bots before the summaries' grace runs out leaves no timer behind and goes nowhere", async () => {
  hungSummaryIpc();
  const timers = trackGraceTimers();
  try {
    const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
    assert.ok(await screen.findByRole("status", { name: "Opening your Bot" }));
    assert.equal(timers.pending(), 1, "waiting for the summaries");
    cleanup();
    assert.equal(timers.pending(), 0, "nothing is left to fire and navigate");
    assert.equal(timers.fired(), 0);
    assert.equal(router.state.location.pathname, "/bots");
  } finally {
    timers.restore();
  }
});

test("summaries that settle inside the grace cancel it, and their order picks the Bot", async () => {
  let answer: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    answer = resolve;
  });
  // By the summaries, Planner has the newest chat; by the Bots' own times, Inbox.
  hungSummaryIpc(async (botId) => {
    await settled;
    return { ...idle, botId, updatedAt: botId === "bot-1" ? 5_000 : 1_000 };
  });
  const timers = trackGraceTimers();
  try {
    const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
    assert.ok(await screen.findByRole("status", { name: "Opening your Bot" }));
    assert.equal(timers.pending(), 1);
    answer();
    await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1/chat"));
    assert.equal(timers.pending(), 0, "the grace timer was cleared, so it never fires");
    assert.equal(timers.fired(), 0);
  } finally {
    timers.restore();
  }
});

test("an open create flow keeps /bots in place even when the list becomes non-empty underneath it", async () => {
  let bots: ReturnType<typeof botFixture>[] = [];
  installBotTestIpc({
    "bots:list": () => bots,
    "bots:live:summary": () => idle,
    "bots:get": () => PLANNER,
    "bots:live:subscribe": () => ({ ...idle, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [] }),
    "bots:pendingApprovals": () => [],
  });
  const { router, queryClient } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  fireEvent.click(await screen.findByRole("button", { name: "Create my own" }));
  assert.ok(await screen.findByRole("dialog", { name: "New Bot" }));
  // Another window (or a phone) adds a Bot while the dialog is open.
  bots = [PLANNER];
  await queryClient.invalidateQueries({ queryKey: queryKeys.bots });
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(router.state.location.pathname, "/bots");
  assert.ok(screen.getByRole("dialog", { name: "New Bot" }));
});

test("a stale cached Bots list does not navigate until the refetch settles", async () => {
  let release: (bots: ReturnType<typeof botFixture>[]) => void = () => {};
  installBotTestIpc({
    "bots:list": () => new Promise<ReturnType<typeof botFixture>[]>((resolve) => (release = resolve)),
    "bots:live:summary": () => idle,
    "bots:get": (botId) => [PLANNER, INBOX].find((bot) => bot.id === botId) ?? null,
    "bots:live:subscribe": (botId) => ({ ...idle, botId, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [] }),
    "bots:pendingApprovals": () => [],
  });
  // The cache still holds a Bot that has since been deleted; the app's default staleTime would refetch.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } } });
  queryClient.setQueryData([...queryKeys.bots, "active"], [INBOX]);
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots", queryClient });
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.equal(router.state.location.pathname, "/bots");
  release([PLANNER]);
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1/chat"));
});

test("/bots with no Bots stays put and offers to create one", async () => {
  installBotTestIpc({ "bots:list": () => [] });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  assert.ok(await screen.findByRole("heading", { name: "Meet your first Bot" }));
  assert.ok(screen.getByRole("button", { name: "New Bot" }));
  assert.equal(router.state.location.pathname, "/bots");
});

test("/bots does not open a Bot while the list is still loading, and says so", async () => {
  installBotTestIpc({ "bots:list": () => new Promise(() => {}) });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  assert.ok(await screen.findByRole("status", { name: "Loading Bots" }));
  assert.equal(router.state.location.pathname, "/bots");
});

test("a Bots list that fails to load offers Try again, then opens the Bot once it loads", async () => {
  let fail = true;
  installBotTestIpc({
    "bots:list": () => {
      if (fail) throw new Error("not ready");
      return [PLANNER];
    },
    "bots:live:summary": () => idle,
    "bots:get": () => PLANNER,
    "bots:live:subscribe": () => ({ ...idle, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [] }),
    "bots:pendingApprovals": () => [],
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const retry = await screen.findByRole("button", { name: "Try again" });
  assert.equal(router.state.location.pathname, "/bots");
  fail = false;
  fireEvent.click(retry);
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1/chat"));
});

test("Profile's back returns to the Bot's chat", async () => {
  twoBots({});
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-2" });
  fireEvent.click(await screen.findByRole("button", { name: "Chat" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
});

test("Start chat on a starter Bot sends one create request and opens its chat", async () => {
  let created = false;
  const calls = installBotTestIpc({
    "bots:list": () => (created ? [botFixture({ id: "bot-chief", name: "Chief of Staff" })] : []),
    "bots:live:summary": () => idle,
    "bots:createFromPreset": () => {
      const firstTime = !created;
      created = true;
      return { bot: botFixture({ id: "bot-chief", name: "Chief of Staff" }), created: firstTime };
    },
    "bots:live:subscribe": () => ({
      botId: "bot-chief",
      epoch: "e1",
      seq: 0,
      entries: [],
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
    }),
  });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const heading = await screen.findByRole("heading", { name: "Meet your first Bot" });
  assert.ok(heading);
  const starters = screen.getByRole("list", { name: "Starter Bots" });
  const startChat = within(starters).getAllByRole("button", { name: "Start chat" })[0]!;

  // A second tap while the first is still answering is ignored; the same Bot opens.
  fireEvent.click(startChat);
  fireEvent.click(startChat);
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-chief/chat"));
  const presetCalls = calls.filter((call) => call.channel === "bots:createFromPreset");
  assert.equal(presetCalls.length, 1);
  assert.deepEqual(presetCalls[0]!.args[0], { presetId: "chief-of-staff" });
});

test("Create my own from the first run opens the create flow", async () => {
  installBotTestIpc({
    "bots:list": () => [],
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  fireEvent.click(await screen.findByRole("button", { name: "Create my own" }));
  assert.ok(await screen.findByRole("dialog", { name: "New Bot" }));
});

test("a phone's Finish on your Mac opens the connection setup even with the Bots list closed", async () => {
  const presets = MCP_PRESETS.map((preset) => ({
    preset,
    serverId: `preset-${preset.id}`,
    configured: false,
    enabled: false,
    ready: false,
  }));
  let loaded = false;
  installBotTestIpc({
    "mcp:list": () => [],
    "mcp:presets": () => {
      loaded = true;
      return presets;
    },
  });
  // Mounted where the app mounts it, with the person on another page.
  await mountWithBotRouter(<BotConnectionSetupHost />, { initialPath: "/settings" });
  await waitFor(() => assert.ok(loaded));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  act(() => emitBotTestNotification("bots:connections:setup", { pluginId: "gmail" }));
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getAllByText(/Gmail/u).length > 0);
});

test("/bots opens the Bot last looked at from a recent cached list while that list refreshes", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: null, lastViewed: { "bot-2": 50 }, seenReplyAt: {} }),
  );
  installBotTestIpc({
    // The refresh never answers; the cached list, read moments ago, is enough.
    "bots:list": () => new Promise<never>(() => undefined),
    "bots:live:summary": () => idle,
    "bots:get": (botId) => [PLANNER, INBOX].find((bot) => bot.id === botId) ?? null,
    "bots:live:subscribe": (botId) => ({ ...idle, botId, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [] }),
    "bots:pendingApprovals": () => [],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } } });
  queryClient.setQueryData([...queryKeys.bots, "active"], [PLANNER, INBOX]);
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots", queryClient });
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
});
