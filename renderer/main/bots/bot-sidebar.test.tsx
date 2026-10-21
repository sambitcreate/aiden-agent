import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
// Before anything loads react-dom, so React reports its commits to the probe.
import { countRenders } from "./test-render-probe";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { rememberRoute } from "../../lib/bot-routes";
import { useBotNotificationsSync } from "../../lib/bot-notifications-sync";
import { hostQueryKeys } from "../../lib/hosts/host-query-keys";
import {
  BOT_SIDEBAR_PREFERENCES_KEY,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
} from "../../lib/bot-sidebar-preferences";
import type { BotLiveSnapshot, BotLiveSummary, BotTranscriptEntry } from "../../shared/bot-live";
import type { BotDefinition } from "../../shared/bots";
import { BotRowMenus } from "./bot-menu";
import { BotSidebar } from "./bot-sidebar";
import { createBotTestQueryClient, mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const PLANNER = botFixture({ id: "bot-1", name: "Planner", description: "Plans trips" });
const INBOX = botFixture({ id: "bot-2", name: "Inbox Helper", description: "Email" });
const SCOUT = botFixture({ id: "bot-3", name: "Scout", description: "Finds places" });

function summary(botId: string, patch: Partial<BotLiveSummary> = {}): BotLiveSummary {
  return { botId, preview: null, updatedAt: null, state: { kind: "idle" }, needsYou: false, lastReplyAt: null, ...patch };
}

function liveSnapshot(botId: string, entries: BotTranscriptEntry[] = [], partial: string | null = null): BotLiveSnapshot {
  return {
    botId,
    epoch: "e1",
    seq: 0,
    entries,
    partial,
    state: partial === null ? { kind: "idle" } : { kind: "running", submissionId: "s1" },
    question: null,
    activity: null,
    queued: [],
  };
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

/** As in the app, one per window: re-reads rows on `bots:changed` and `bots:attention`. */
function BotNotifications() {
  useBotNotificationsSync(useQueryClient());
  return null;
}

async function mountSidebar(initialPath = "/bots", queryClient?: QueryClient) {
  const mounted = await mountWithBotRouter(null, {
    initialPath,
    ...(queryClient ? { queryClient } : {}),
    sidebar: (
      <>
        <BotNotifications />
        <BotSidebar />
      </>
    ),
  });
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
  act(() => emitBotTestNotification("bots:attention", { botId: "bot-1" }));
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Needs you")));
  assert.ok(within(rowButton("Planner")).getByText("Waiting for you"));
  assert.equal(within(rowButton("Inbox Helper")).queryByText("Needs you") === null, true);
  assert.ok(screen.getByRole("button", { name: /^Planner.*Needs you/u }), "the row's name says it needs you");
});

test("a reply since the person last looked shows an unread dot, but not on the open Bot or on replies from before the sidebar existed", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1_000, pinnedBotId: null, lastViewed: { "bot-2": 5_000 }, seenReplyAt: { "bot-2": 5_000 } }),
  );
  sidebarIpc(
    [PLANNER, INBOX, SCOUT],
    {
      "bot-1": summary("bot-1", { lastReplyAt: 9_000, updatedAt: 9_000 }),
      "bot-2": summary("bot-2", { lastReplyAt: 6_000, updatedAt: 6_000 }),
      "bot-3": summary("bot-3", { lastReplyAt: 500, updatedAt: 500 }),
    },
    {
      // Main's chat and its summary agree: Inbox Helper's newest reply is the one at 6 000.
      "bots:live:subscribe": (botId) =>
        liveSnapshot(
          botId as string,
          botId === "bot-2" ? [{ id: "a1", type: "assistant", text: "Inbox is clear.", toolCalls: [], stopReason: "stop", at: 6_000 }] : [],
        ),
    },
  );
  const { router } = await mountSidebar("/bots/bot-1");
  await waitFor(() => assert.ok(within(rowButton("Inbox Helper")).getByRole("img", { name: "Unread" })));
  assert.ok(screen.getByRole("button", { name: /^Inbox Helper.*Unread/u }), "the row's name says it is unread");
  assert.ok(noUnread("Planner"), "the open Bot");
  assert.ok(noUnread("Scout"), "a reply from before the sidebar existed");
  assert.equal(rowButton("Planner").getAttribute("aria-current"), "page");

  fireEvent.click(rowButton("Inbox Helper"));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  await screen.findByRole("button", { name: "Inbox Helper profile" });
  await act(() => router.navigate({ to: "/bots/$botId", params: { botId: "bot-1" } }));
  await waitFor(() => assert.equal(rowButton("Planner").getAttribute("aria-current"), "page"));
  assert.ok(noUnread("Inbox Helper"), "viewing its chat marked it read");
});

test("leaving a chat while a reply still streams shows that reply as unread once it finishes", async () => {
  const replied = Date.now() - 60_000;
  const streamStarted = Date.now() - 30_000;
  let plannerReplyAt = replied;
  sidebarIpc(
    [PLANNER, INBOX],
    {},
    {
      "bots:live:summary": (botId) =>
        botId === "bot-1" ? summary("bot-1", { lastReplyAt: plannerReplyAt, updatedAt: plannerReplyAt }) : summary("bot-2"),
      "bots:live:subscribe": (botId) =>
        liveSnapshot(
          botId as string,
          botId === "bot-1"
            ? [
                { id: "u1", type: "user", text: "Plan dinners", imageCount: 0, at: replied - 1_000 },
                { id: "a1", type: "assistant", text: "Here's Monday.", toolCalls: [], stopReason: "stop", at: replied },
                { id: "u2", type: "user", text: "And Tuesday?", imageCount: 0, at: streamStarted - 1_000 },
              ]
            : [],
          botId === "bot-1" ? "Tuesday is" : null,
        ),
    },
  );
  const { router } = await mountSidebar("/bots/bot-1/chat");
  await screen.findByText("Here's Monday.");
  // The person leaves while Tuesday's reply is still streaming.
  fireEvent.click(rowButton("Inbox Helper"));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  await screen.findByRole("button", { name: "Inbox Helper profile" });
  assert.ok(noUnread("Planner"), "nothing new yet");
  // It finishes. Main times it from when it started streaming: before the person left.
  plannerReplyAt = streamStarted;
  act(() => emitBotTestNotification("bots:attention", { botId: "bot-1" }));
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByRole("img", { name: "Unread" })));
});

test("Needs you outranks the unread dot, and the row still tells a screen reader it is unread", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1_000, pinnedBotId: null, lastViewed: {}, seenReplyAt: {} }),
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
  act(() => emitBotTestNotification("bots:attention", { botId: "bot-1" }));
  await waitFor(() => assert.equal(pending.length, 1));
  act(() => emitBotTestNotification("bots:attention", { botId: "bot-1" }));
  await waitFor(() => assert.equal(pending.length, 2));
  pending[1]!(summary("bot-1", { needsYou: true }));
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Needs you")));
  pending[0]!(summary("bot-1", { needsYou: false }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
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

test("Memory in a row's menu opens that Bot's chat with the panel on that Bot's Memory", async () => {
  const store = (text: string, limitChars: number) => ({
    entries: [{ id: `${text}-id`, text }],
    usedChars: text.length,
    limitChars,
    overBudget: false,
  });
  const memories: Record<string, string> = { "bot-1": "Lives in Lisbon", "bot-2": "Prefers short replies" };
  const calls = sidebarIpc([PLANNER, INBOX], {}, {
    "bots:memory:get": (botId) => ({
      botId,
      revision: "r1",
      readable: true,
      user: store(memories[botId as string]!, 1_375),
      memory: { entries: [], usedChars: 0, limitChars: 2_200, overBudget: false },
      updatedAt: 1,
    }),
  });
  const { router } = await mountSidebar("/bots/bot-1/chat");
  fireEvent.keyDown(await screen.findByRole("button", { name: "More for Inbox Helper" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Memory" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  await screen.findByRole("button", { name: "Inbox Helper profile" });
  const panel = await screen.findByRole("complementary", { name: "Bot panel" });
  assert.equal(within(panel).getByRole("tab", { name: "Memory" }).getAttribute("aria-selected"), "true");
  assert.ok(await within(panel).findByText("Prefers short replies"));
  assert.equal(within(panel).queryByText("Lives in Lisbon") === null, true);
  const memoryReads = calls.filter((call) => call.channel === "bots:memory:get");
  assert.equal(memoryReads[memoryReads.length - 1]?.args[0], "bot-2");
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
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
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
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: "bot-3", lastViewed: {}, seenReplyAt: {} }),
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
  // The visible name leads the accessible name.
  const profile = await screen.findByRole("button", { name: "Sam, Profile" });
  assert.ok(within(profile).getByText("S"));
  fireEvent.click(profile);
  await waitFor(() => assert.equal(router.state.location.pathname, "/profile"));
  fireEvent.click(screen.getByRole("button", { name: "Connect apps" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.equal((router.state.location.search as { section?: string }).section, "mcp");
});

test("a Bot's state change re-reads only that Bot's row; other changes to a Bot also re-read the list; an unnamed change re-reads all", async () => {
  const calls = sidebarIpc([PLANNER, INBOX, SCOUT]);
  await mountSidebar();
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:live:summary").length, 3));
  const readsAfter = (emit: () => void) => {
    const before = calls.length;
    act(emit);
    return () =>
      calls
        .slice(before)
        .filter((call) => call.channel === "bots:list" || call.channel === "bots:live:summary")
        .map((call) => (call.channel === "bots:list" ? "list" : String(call.args[0])))
        .sort();
  };

  const session = readsAfter(() =>
    emitBotTestNotification("bots:changed", { botId: "bot-2", session: { kind: "running", submissionId: "s1" } }),
  );
  await waitFor(() => assert.deepEqual(session(), ["bot-2"]));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(session(), ["bot-2"], "one summary read, for that Bot only");

  const edited = readsAfter(() => emitBotTestNotification("bots:changed", { botId: "bot-2" }));
  await waitFor(() => assert.deepEqual(edited(), ["bot-2", "list"]));

  const everything = readsAfter(() => emitBotTestNotification("bots:changed", {}));
  await waitFor(() => assert.deepEqual(everything(), ["bot-1", "bot-2", "bot-3", "list"]));
});

test("Shift+F10 on a focused row opens its menu from the keyboard", async () => {
  sidebarIpc([PLANNER, INBOX]);
  const { router } = await mountSidebar();
  const row = await screen.findByRole("button", { name: /^Inbox Helper/u });
  row.focus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Profile", "Files", "Memory", "Routines", "Advanced", "Pin to top", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Profile" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2"));
});

test("deleting a row's Bot leaves focus on the next row, and deleting the last Bot leaves it on New Bot", async () => {
  let bots = [PLANNER, INBOX, SCOUT];
  sidebarIpc([], {
    "bot-1": summary("bot-1", { updatedAt: 300 }),
    "bot-2": summary("bot-2", { updatedAt: 200 }),
    "bot-3": summary("bot-3", { updatedAt: 100 }),
  }, {
    "bots:list": () => bots,
    "bots:delete": (botId) => {
      bots = bots.filter((bot) => bot.id !== botId);
    },
  });
  await mountSidebar();
  await waitFor(() => assert.deepEqual(rowOrder(), ["Planner", "Inbox Helper", "Scout"]));
  const remove = async (name: string) => {
    const row = rowButton(name);
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Bot" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Bot" }));
    await waitFor(() => assert.equal(screen.queryByRole("alertdialog") === null, true));
  };
  await remove("Inbox Helper");
  await waitFor(() => assert.equal(document.activeElement === rowButton("Scout"), true));
  await remove("Scout");
  // None below: the row above.
  await waitFor(() => assert.equal(document.activeElement === rowButton("Planner"), true));
  await remove("Planner");
  await waitFor(() => assert.equal(document.activeElement === screen.getByRole("button", { name: "New Bot" }), true));
});

test("deleting a Bot from its own chat leaves nothing behind for it, not even a last-viewed time", async () => {
  let bots = [PLANNER, INBOX];
  sidebarIpc([], {}, {
    "bots:list": () => bots,
    "bots:get": (botId) => bots.find((bot) => bot.id === botId) ?? null,
    "bots:delete": (botId) => {
      bots = bots.filter((bot) => bot.id !== botId);
    },
  });
  const { router } = await mountSidebar("/bots/bot-2/chat");
  await screen.findByRole("button", { name: "Inbox Helper profile" });
  await waitFor(() =>
    assert.ok(parseBotSidebarPreferences(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY), Date.now()).lastViewed["bot-2"]),
  );
  fireEvent.keyDown(screen.getAllByRole("button", { name: "More for Inbox Helper" })[0]!, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Bot" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete Bot" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots"));
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
  const stored = parseBotSidebarPreferences(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY), Date.now());
  assert.equal(stored.lastViewed["bot-2"], undefined, "leaving the deleted Bot's chat does not mark it viewed");
});

test("a refresh that fails keeps the Bots on screen and offers Try again", async () => {
  let fail = false;
  sidebarIpc([], {}, {
    "bots:list": () => {
      if (fail) throw new Error("Bots are busy");
      return [PLANNER, INBOX];
    },
  });
  const { queryClient } = await mountSidebar();
  await waitFor(() => assert.deepEqual(rowOrder(), ["Inbox Helper", "Planner"]));
  fail = true;
  await queryClient.refetchQueries({ queryKey: ["bots"] });
  const alert = await screen.findByRole("alert");
  assert.deepEqual(rowOrder(), ["Inbox Helper", "Planner"], "the Bots already shown stay");
  fail = false;
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await waitFor(() => assert.equal(screen.queryByRole("alert") === null, true));
});

test("search ignores accents and case, so cafe finds café", async () => {
  sidebarIpc([PLANNER, INBOX], { "bot-1": summary("bot-1", { preview: "Found two CAFÉS near the river" }) });
  await mountSidebar();
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Found two CAFÉS near the river")));
  fireEvent.click(screen.getByRole("button", { name: "Search Bots" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Bots" }), { target: { value: "cafe" } });
  assert.deepEqual(rowOrder(), ["Planner"]);
});

test("Bots on a paired Mac count: with only those, and with a search only they match, there is no empty state", async () => {
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(hostQueryKeys.list(), [
    { id: "host-b", name: "Studio", enabled: true, state: "connected", features: [], capabilities: ["chat:read", "chat:write", "workspace:read", "bot:read", "bot:write"] },
  ]);
  queryClient.setQueryData(hostQueryKeys.statuses(), [
    { hostId: "host-b", generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false },
  ]);
  queryClient.setQueryData(hostQueryKeys.feed("host-b"), {
    hostId: "host-b",
    epoch: "e1",
    sequence: 1,
    stale: false,
    summaries: [],
    workspaces: [],
    bots: [{ id: "remote-1", name: "Reviewer", purpose: "Reviews pull requests" }],
    runs: [],
  });
  let bots: BotDefinition[] = [];
  sidebarIpc([], {}, { "bots:list": () => bots });
  await mountSidebar("/bots", queryClient);
  assert.ok(await screen.findByRole("button", { name: "Reviewer, on Studio" }));
  assert.equal(screen.queryByText("No Bots yet") === null, true);

  bots = [PLANNER];
  await queryClient.invalidateQueries({ queryKey: ["bots"] });
  await screen.findByRole("button", { name: /^Planner/u });
  fireEvent.click(screen.getByRole("button", { name: "Search Bots" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Bots" }), { target: { value: "pull requests" } });
  assert.ok(screen.getByRole("button", { name: "Reviewer, on Studio" }));
  assert.equal(screen.queryByText("No matching Bots") === null, true);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Bots" }), { target: { value: "zebra" } });
  assert.ok(screen.getByText("No matching Bots"));
});

test("a paired Mac's Bot shows when it is working there, and marks the one whose chat is open", async () => {
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(hostQueryKeys.list(), [
    { id: "host-b", name: "Studio", enabled: true, state: "connected", features: ["bot-durable-session-v1"], capabilities: ["chat:read", "chat:write", "bot:read", "bot:write"] },
  ]);
  queryClient.setQueryData(hostQueryKeys.statuses(), [
    { hostId: "host-b", generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false },
  ]);
  queryClient.setQueryData(hostQueryKeys.feed("host-b"), {
    hostId: "host-b",
    epoch: "e1",
    sequence: 1,
    stale: false,
    summaries: [],
    workspaces: [],
    bots: [
      { id: "remote-1", name: "Reviewer", purpose: "Reviews pull requests", sessionState: "running" },
      { id: "remote-2", name: "Scout", purpose: "Finds flights", sessionState: "idle" },
    ],
    runs: [],
  });
  sidebarIpc([], {}, { "bots:list": () => [] });
  await mountSidebar("/host/host-b/bots/remote-2/chat", queryClient);
  const working = await screen.findByRole("button", { name: "Reviewer, on Studio, working" });
  assert.ok(within(working).getByText("Working…"));
  const open = screen.getByRole("button", { name: "Scout, on Studio" });
  assert.equal(open.getAttribute("aria-current"), "page");
  assert.equal(working.getAttribute("aria-current"), null);
});

test("Cancel in a row's Delete puts focus back on that row", async () => {
  sidebarIpc([PLANNER, INBOX, SCOUT]);
  await mountSidebar();
  const row = await screen.findByRole("button", { name: /^Inbox Helper/u });
  row.focus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Bot" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog") === null, true));
  await waitFor(() => assert.equal(document.activeElement === rowButton("Inbox Helper"), true));
});

test("the Menu key on a focused row opens that row's menu", async () => {
  sidebarIpc([PLANNER, INBOX]);
  const { router } = await mountSidebar();
  const row = await screen.findByRole("button", { name: /^Planner/u });
  row.focus();
  fireEvent.keyDown(row, { key: "ContextMenu" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Advanced" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1"));
  assert.equal(router.state.location.searchStr, "?page=advanced");
});

test("deleting the pinned Bot leaves focus on the row below it on screen, not the next by activity", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: "bot-3", lastViewed: {}, seenReplyAt: {} }),
  );
  let bots = [PLANNER, INBOX, SCOUT];
  sidebarIpc([], {
    "bot-1": summary("bot-1", { updatedAt: 300 }),
    "bot-2": summary("bot-2", { updatedAt: 200 }),
    "bot-3": summary("bot-3", { updatedAt: 100 }),
  }, {
    "bots:list": () => bots,
    "bots:delete": (botId) => {
      bots = bots.filter((bot) => bot.id !== botId);
    },
  });
  await mountSidebar();
  const hero = await screen.findByRole("region", { name: "Pinned Bot" });
  await waitFor(() => assert.deepEqual(rowOrder(), ["Planner", "Inbox Helper"]));
  // Scout is pinned, so on screen it sits above Planner, though its activity is the oldest.
  const heroRow = within(hero).getByRole("button", { name: /^Scout/u });
  heroRow.focus();
  fireEvent.keyDown(heroRow, { key: "F10", shiftKey: true });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Bot" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete Bot" }));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog") === null, true));
  await waitFor(() => assert.equal(document.activeElement === rowButton("Planner"), true));
});

test("the pinned Bot says when it is working, as the rows do", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: "bot-1", lastViewed: {}, seenReplyAt: {} }),
  );
  sidebarIpc([PLANNER, INBOX], { "bot-1": summary("bot-1", { state: { kind: "running", submissionId: "s1" } }) });
  await mountSidebar();
  const hero = await screen.findByRole("region", { name: "Pinned Bot" });
  const heroRow = within(hero).getByRole("button", { name: /^Planner/u });
  const description = () => {
    const id = heroRow.getAttribute("aria-describedby");
    return id ? document.getElementById(id)?.textContent ?? "" : "";
  };
  await waitFor(() => assert.equal(description(), "Thinking…"));
});

test("opening another Bot redraws only the two rows whose selection changed", async () => {
  const rowRenders = countRenders(BotRowMenus);
  const MOSS = botFixture({ id: "bot-4", name: "Moss", description: "Garden" });
  sidebarIpc([PLANNER, INBOX, SCOUT, MOSS], {
    "bot-1": summary("bot-1", { updatedAt: 400 }),
    "bot-2": summary("bot-2", { updatedAt: 300 }),
    "bot-3": summary("bot-3", { updatedAt: 200 }),
    "bot-4": summary("bot-4", { updatedAt: 100 }),
  });
  const { router } = await mountSidebar("/bots/bot-1/chat");
  await waitFor(() => assert.deepEqual(rowOrder(), ["Planner", "Inbox Helper", "Scout", "Moss"]));
  await screen.findByRole("button", { name: "Planner profile" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const before = rowRenders();
  await act(() => router.navigate({ to: "/bots/$botId/chat", params: { botId: "bot-3" } }));
  await screen.findByRole("button", { name: "Scout profile" });
  await waitFor(() => assert.equal(rowButton("Scout").getAttribute("aria-current"), "page"));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(rowRenders() - before, 2, "Planner and Scout, not every row");
});
