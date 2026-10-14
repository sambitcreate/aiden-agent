import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { rememberRoute } from "../../lib/bot-routes";
import {
  BOT_SIDEBAR_PREFERENCES_KEY,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
} from "../../lib/bot-sidebar-preferences";
import type { BotLiveSummary } from "../../shared/bot-live";
import type { BotDefinition } from "../../shared/bots";
import { BotSidebar } from "./bot-sidebar";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const PLANNER = botFixture({ id: "bot-1", name: "Planner", description: "Plans trips" });
const INBOX = botFixture({ id: "bot-2", name: "Inbox Helper", description: "Email" });
const SCOUT = botFixture({ id: "bot-3", name: "Scout", description: "Finds places" });

function summary(botId: string, patch: Partial<BotLiveSummary> = {}): BotLiveSummary {
  return { botId, preview: null, updatedAt: null, state: { kind: "idle" }, needsYou: false, lastReplyAt: null, ...patch };
}

function sidebarIpc(
  bots: BotDefinition[],
  summaries: Record<string, BotLiveSummary> = {},
  extra: Record<string, (...args: unknown[]) => unknown> = {},
) {
  return installBotTestIpc({
    "bots:list": () => bots,
    "bots:live:summary": (botId) => summaries[botId as string] ?? summary(botId as string),
    "bots:get": (botId) => bots.find((bot) => bot.id === botId) ?? null,
    "bots:live:subscribe": (botId) => ({
      botId,
      epoch: "e1",
      seq: 0,
      entries: [],
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
    }),
    "bots:live:unsubscribe": () => undefined,
    "bots:pendingApprovals": () => [],
    "profile:get": () => ({ name: "Sam" }),
    ...extra,
  });
}

async function mountSidebar(initialPath = "/bots") {
  const mounted = await mountWithBotRouter(null, { initialPath, sidebar: <BotSidebar /> });
  await screen.findByRole("navigation", { name: "Bots" });
  return mounted;
}

const rowButton = (name: string) =>
  within(screen.getByRole("navigation", { name: "Bots" })).getByRole("button", { name: new RegExp(`^${name}`, "u") });

/** Row order by each row's face, whose title is the Bot's name. */
const rowOrder = () =>
  within(screen.getByRole("list", { name: "Your Bots" }))
    .getAllByRole("listitem")
    .map((item) => item.querySelector("span[title]")?.getAttribute("title"));

const noUnread = (name: string) => within(rowButton(name)).queryByRole("img", { name: "Unread" }) === null;

const FILE_HANDLERS = {
  "bots:files:list": () => ({
    entries: [{ path: "notes.md", name: "notes.md", parentPath: "", depth: 0, kind: "file" }],
    truncated: false,
    skippedDirectories: 0,
  }),
  "bots:routines:list": () => [],
};

const botPanel = (): HTMLElement => {
  const panel = document.getElementById("bot-panel");
  assert.ok(panel, "the Bot panel is mounted");
  return panel;
};

test("rows show each Bot's last message, newest activity first, in plain words", async () => {
  sidebarIpc([PLANNER, INBOX, SCOUT], {
    "bot-1": summary("bot-1", { preview: "Lisbon in May", updatedAt: 100 }),
    "bot-2": summary("bot-2", { preview: "Inbox is clear", updatedAt: 300 }),
    "bot-3": summary("bot-3", { preview: "Found two cafés", updatedAt: 200 }),
  });
  await mountSidebar();
  await waitFor(() => assert.deepEqual(rowOrder(), ["Inbox Helper", "Scout", "Planner"]));
  assert.ok(within(rowButton("Planner")).getByText("Lisbon in May"));
  assert.equal(screen.queryByRole("navigation", { name: "Primary" }) === null, true, "only Bots in this sidebar");
  const text = document.body.textContent ?? "";
  for (const jargon of [/\bPi\b/u, /provider/iu, /workspace/iu, /capabilit/iu, /canonical/iu]) {
    assert.doesNotMatch(text, jargon);
  }
});

test("a working Bot's face works and its line reads Thinking…, and Needs you appears as soon as it asks", async () => {
  let asking = false;
  sidebarIpc([PLANNER, INBOX], {}, {
    "bots:live:summary": (botId) =>
      botId === "bot-1"
        ? summary("bot-1", { state: { kind: "running", submissionId: "s1" }, needsYou: asking })
        : summary("bot-2", { preview: "Inbox is clear" }),
  });
  await mountSidebar();
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Thinking…")));
  assert.equal(within(rowButton("Planner")).getByTitle("Planner").hasAttribute("data-working"), true);
  assert.equal(within(rowButton("Inbox Helper")).getByTitle("Inbox Helper").hasAttribute("data-working"), false);
  asking = true;
  emitBotTestNotification("bots:attention", { botId: "bot-1" });
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Needs you")));
  assert.ok(within(rowButton("Planner")).getByText("Waiting for you"));
  assert.equal(within(rowButton("Inbox Helper")).queryByText("Needs you") === null, true);
  assert.ok(screen.getByRole("button", { name: /^Planner.*Needs you/u }), "the row's name says it needs you");
});

test("a reply since the person last looked shows an unread dot, but not on the open Bot or on replies from before the sidebar existed", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1_000, pinnedBotId: null, lastViewed: { "bot-2": 5_000 } }),
  );
  sidebarIpc([PLANNER, INBOX, SCOUT], {
    "bot-1": summary("bot-1", { lastReplyAt: 9_000, updatedAt: 9_000 }),
    "bot-2": summary("bot-2", { lastReplyAt: 6_000, updatedAt: 6_000 }),
    "bot-3": summary("bot-3", { lastReplyAt: 500, updatedAt: 500 }),
  });
  const { router } = await mountSidebar("/bots/bot-1");
  await waitFor(() => assert.ok(within(rowButton("Inbox Helper")).getByRole("img", { name: "Unread" })));
  assert.ok(screen.getByRole("button", { name: /^Inbox Helper.*Unread/u }), "the row's name says it is unread");
  assert.ok(noUnread("Planner"), "the open Bot");
  assert.ok(noUnread("Scout"), "a reply from before the sidebar existed");
  assert.equal(rowButton("Planner").getAttribute("aria-current"), "page");

  fireEvent.click(rowButton("Inbox Helper"));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
});

test("opening a Bot's chat marks it read, so its dot is gone once the person moves on", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1_000, pinnedBotId: null, lastViewed: { "bot-2": 5_000 } }),
  );
  const summaries = {
    "bot-1": summary("bot-1", { lastReplyAt: 9_000, updatedAt: 9_000 }),
    "bot-2": summary("bot-2", { lastReplyAt: 6_000, updatedAt: 6_000 }),
  };
  sidebarIpc([PLANNER, INBOX], summaries);
  const { router } = await mountSidebar("/bots/bot-2/chat");
  await screen.findByRole("button", { name: "Inbox Helper profile" });
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByRole("img", { name: "Unread" })));
  await router.navigate({ to: "/bots/$botId", params: { botId: "bot-1" } });
  // Under `tsx --test` the router's server build does not re-render on navigation;
  // a row that changes does, and then the sidebar reads the new page.
  summaries["bot-2"] = summary("bot-2", { lastReplyAt: 6_000, updatedAt: 6_500, preview: "Inbox is clear" });
  emitBotTestNotification("bots:attention", { botId: "bot-2" });
  await waitFor(() => assert.equal(rowButton("Planner").getAttribute("aria-current"), "page"));
  assert.ok(noUnread("Inbox Helper"), "viewing its chat marked it read");
});

test("Needs you outranks the unread dot, and the row still tells a screen reader it is unread", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1_000, pinnedBotId: null, lastViewed: {} }),
  );
  sidebarIpc([PLANNER], { "bot-1": summary("bot-1", { needsYou: true, lastReplyAt: 9_000 }) });
  await mountSidebar();
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Needs you")));
  assert.ok(noUnread("Planner"), "no dot beside Needs you");
  assert.ok(screen.getByRole("button", { name: /^Planner.*Needs you.*Unread/u }));
});

test("a Needs-you change re-reads only that Bot, and an older answer that arrives late never replaces a newer one", async () => {
  const pending: Array<(value: BotLiveSummary) => void> = [];
  let hold = false;
  const calls = sidebarIpc([PLANNER, INBOX], {}, {
    "bots:live:summary": (botId) =>
      hold && botId === "bot-1"
        ? new Promise<BotLiveSummary>((resolve) => pending.push(resolve))
        : summary(botId as string),
  });
  await mountSidebar();
  await screen.findByRole("button", { name: /^Planner/u });
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:live:summary").length, 2));
  const before = calls.length;
  hold = true;
  emitBotTestNotification("bots:attention", { botId: "bot-1" });
  await waitFor(() => assert.equal(pending.length, 1));
  emitBotTestNotification("bots:attention", { botId: "bot-1" });
  await waitFor(() => assert.equal(pending.length, 2));
  pending[1]!(summary("bot-1", { needsYou: true }));
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Needs you")));
  pending[0]!(summary("bot-1", { needsYou: false }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(within(rowButton("Planner")).getByText("Needs you"), "the late, older answer is dropped");
  const reads = calls
    .slice(before)
    .filter((call) => call.channel === "bots:list" || call.channel === "bots:live:summary")
    .map((call) => `${call.channel} ${String(call.args[0])}`);
  assert.deepEqual(reads, ["bots:live:summary bot-1", "bots:live:summary bot-1"], "no other Bot and no list re-read");
});

test("a paused Bot says so, and one without a model says it needs one", async () => {
  sidebarIpc([PLANNER, INBOX], {
    "bot-1": summary("bot-1", { preview: "Reading your calendar", state: { kind: "interrupted", submissionId: "s1" } }),
    "bot-2": summary("bot-2", { state: { kind: "needs_model" } }),
  });
  await mountSidebar();
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Paused — tap to resume")));
  assert.equal(within(rowButton("Planner")).queryByText("Reading your calendar") === null, true);
  assert.ok(within(rowButton("Inbox Helper")).getByText("Needs an AI model"));
});

test("tapping a row opens that Bot's chat, and its context menu and ••• offer the Bot menu", async () => {
  sidebarIpc([PLANNER, INBOX]);
  const { router } = await mountSidebar();
  fireEvent.click(await screen.findByRole("button", { name: /^Inbox Helper/u }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));

  fireEvent.contextMenu(rowButton("Planner"));
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Profile", "Files", "Memory", "Routines", "Advanced", "Pin to top", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Advanced" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1"));
  assert.equal((router.state.location.search as { page?: string }).page, "advanced");

  fireEvent.keyDown(screen.getByRole("button", { name: "More for Inbox Helper" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Bot" }));
  const confirm = await screen.findByRole("alertdialog");
  assert.ok(within(confirm).getByRole("heading", { name: "Delete Inbox Helper?" }));
});

test("Memory in a row's menu opens that Bot's chat with the panel on Memory", async () => {
  const empty = { entries: [], usedChars: 0, limitChars: 1_375, overBudget: false };
  sidebarIpc([PLANNER, INBOX], {}, {
    "bots:memory:get": (botId) => ({ botId, revision: "r1", readable: true, user: empty, memory: { ...empty, limitChars: 2_200 }, updatedAt: 1 }),
  });
  const { router } = await mountSidebar("/bots/bot-1/chat");
  fireEvent.keyDown(await screen.findByRole("button", { name: "More for Inbox Helper" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Memory" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  const panel = await screen.findByRole("complementary", { name: "Bot panel" });
  assert.equal(within(panel).getByRole("tab", { name: "Memory" }).getAttribute("aria-selected"), "true");
});

test("Files from a row's right-click menu opens the panel, and closing the panel returns focus to that row", async () => {
  sidebarIpc([PLANNER, INBOX], {}, FILE_HANDLERS);
  await mountSidebar("/bots/bot-1/chat");
  await screen.findByRole("button", { name: "Planner profile" });
  const row = rowButton("Planner");
  row.focus();
  fireEvent.contextMenu(row);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  const filesTab = () => within(botPanel()).getByRole("tab", { name: "Files" });
  await waitFor(() => assert.equal(document.activeElement === filesTab(), true));
  // The menu's own close must not pull focus back out of the panel.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(document.activeElement === filesTab(), true);
  fireEvent.click(within(botPanel()).getByRole("button", { name: "Close Bot panel" }));
  await waitFor(() => assert.equal(document.activeElement === rowButton("Planner"), true));
});

test("when the row the panel was opened from is gone, closing the panel puts focus on the panel toggle", async () => {
  sidebarIpc([PLANNER, INBOX], {}, FILE_HANDLERS);
  await mountSidebar("/bots/bot-1/chat");
  await screen.findByRole("button", { name: "Planner profile" });
  fireEvent.contextMenu(rowButton("Planner"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  const filesTab = () => within(botPanel()).getByRole("tab", { name: "Files" });
  await waitFor(() => assert.equal(document.activeElement === filesTab(), true));
  // Searching unmounts the row the panel would hand focus back to.
  fireEvent.click(screen.getByRole("button", { name: "Search Bots" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Bots" }), { target: { value: "inbox" } });
  assert.deepEqual(rowOrder(), ["Inbox Helper"]);
  filesTab().focus();
  fireEvent.click(within(botPanel()).getByRole("button", { name: "Close Bot panel" }));
  await waitFor(() => assert.equal(document.activeElement === screen.getByRole("button", { name: "Show panel" }), true));
});

test("Pin to top shows the Bot large above the rows, Unpin puts it back, and a deleted pinned Bot leaves no hero", async () => {
  let bots = [PLANNER, INBOX];
  sidebarIpc([], {}, { "bots:list": () => bots });
  const { queryClient } = await mountSidebar();
  fireEvent.contextMenu(await screen.findByRole("button", { name: /^Inbox Helper/u }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin to top" }));
  const hero = await screen.findByRole("region", { name: "Pinned Bot" });
  assert.ok(within(hero).getByRole("button", { name: /^Inbox Helper/u }));
  assert.deepEqual(rowOrder(), ["Planner"], "a pinned Bot is not listed twice");

  fireEvent.keyDown(within(hero).getByRole("button", { name: "More for Inbox Helper" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
  await waitFor(() => assert.equal(screen.queryByRole("region", { name: "Pinned Bot" }) === null, true));
  assert.deepEqual(rowOrder(), ["Inbox Helper", "Planner"]);

  fireEvent.contextMenu(rowButton("Inbox Helper"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin to top" }));
  await screen.findByRole("region", { name: "Pinned Bot" });
  bots = [PLANNER];
  await queryClient.invalidateQueries({ queryKey: ["bots"] });
  await waitFor(() => assert.equal(screen.queryByRole("region", { name: "Pinned Bot" }) === null, true));
  assert.equal(parseBotSidebarPreferences(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY), 0).pinnedBotId, null);
});

test("search narrows rows by name, subtitle or last message, finds the pinned Bot, and Clear brings everything back", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: "bot-3", lastViewed: {} }),
  );
  sidebarIpc([PLANNER, INBOX, SCOUT], { "bot-1": summary("bot-1", { preview: "Lisbon in May" }) });
  await mountSidebar();
  await screen.findByRole("region", { name: "Pinned Bot" });
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Lisbon in May")));
  fireEvent.click(screen.getByRole("button", { name: "Search Bots" }));
  const search = screen.getByRole("searchbox", { name: "Search Bots" });
  await waitFor(() => assert.equal(document.activeElement === search, true));
  fireEvent.change(search, { target: { value: "email" } });
  assert.deepEqual(rowOrder(), ["Inbox Helper"]);
  fireEvent.change(search, { target: { value: "lisbon" } });
  assert.deepEqual(rowOrder(), ["Planner"]);
  fireEvent.change(search, { target: { value: "places" } });
  assert.equal(screen.queryByRole("region", { name: "Pinned Bot" }) === null, true);
  assert.deepEqual(rowOrder(), ["Scout"]);
  fireEvent.change(search, { target: { value: "zebra" } });
  assert.ok(within(screen.getByRole("status")).getByText("No matching Bots"));
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  assert.deepEqual(rowOrder(), ["Inbox Helper", "Planner"]);
  assert.ok(screen.getByRole("region", { name: "Pinned Bot" }));
});

test("Escape clears the search, then closes it and gives focus back to Search", async () => {
  sidebarIpc([PLANNER, INBOX]);
  await mountSidebar();
  await screen.findByRole("button", { name: /^Planner/u });
  fireEvent.click(screen.getByRole("button", { name: "Search Bots" }));
  const search = screen.getByRole("searchbox", { name: "Search Bots" });
  fireEvent.change(search, { target: { value: "inbox" } });
  fireEvent.keyDown(search, { key: "Escape" });
  assert.equal((search as HTMLInputElement).value, "");
  assert.deepEqual(rowOrder(), ["Inbox Helper", "Planner"]);
  fireEvent.keyDown(search, { key: "Escape" });
  assert.equal(screen.queryByRole("searchbox") === null, true);
  assert.equal(document.activeElement === screen.getByRole("button", { name: "Search Bots" }), true);
});

test("while the Bots load the sidebar shows placeholders, and a failed load offers Try again", async () => {
  let release!: (bots: BotDefinition[]) => void;
  sidebarIpc([], {}, { "bots:list": () => new Promise<BotDefinition[]>((resolve) => (release = resolve)) });
  await mountSidebar();
  assert.ok(screen.getByRole("status", { name: "Loading Bots" }));
  release([PLANNER]);
  await screen.findByRole("button", { name: /^Planner/u });
  cleanup();

  let fail = true;
  sidebarIpc([], {}, {
    "bots:list": () => {
      if (fail) throw new Error("Bots are still starting");
      return [PLANNER];
    },
  });
  await mountSidebar();
  const alert = await screen.findByRole("alert");
  fail = false;
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: /^Planner/u });
});

test("‹ returns to the last page outside Bots, and the footer opens Profile and Connect apps", async () => {
  rememberRoute("/scheduled");
  rememberRoute("/bots/bot-1/chat");
  sidebarIpc([PLANNER]);
  const { router } = await mountSidebar();
  fireEvent.click(screen.getByRole("button", { name: "Back to Aiden" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/scheduled"));
  await waitFor(() => assert.ok(within(screen.getByRole("button", { name: "Profile" })).getByText("S")));
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/profile"));
  fireEvent.click(screen.getByRole("button", { name: "Connect apps" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.equal((router.state.location.search as { section?: string }).section, "mcp");
});
