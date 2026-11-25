import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
// Before anything loads react-dom, so React reports its commits to the probe.
import { countRenders } from "./test-render-probe";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { rememberRoute } from "../../lib/bot-routes";
import { useCommandSystem } from "../../lib/command-system";
import type { CommandId } from "../../shared/keybindings";
import { useBotNotificationsSync } from "../../lib/bot-notifications-sync";
import { hostQueryKeys } from "../../lib/hosts/host-query-keys";
import { resetRemoteBotSeenForTests } from "../../lib/remote-bot-seen";
import {
  BOT_SIDEBAR_PREFERENCES_KEY,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
} from "../../lib/bot-sidebar-preferences";
import type { BotLiveSnapshot, BotLiveSummary, BotTranscriptEntry } from "../../shared/bot-live";
import type { BotDefinition } from "../../shared/bots";
import { BotRowMenus } from "./bot-menu";
import { BotSidebar } from "./bot-sidebar";
import { ChatSidebar } from "../../components/chat-sidebar";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import { createBotTestQueryClient, mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";

beforeEach(() => {
  localStorage.clear();
  resetRemoteBotSeenForTests();
});
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
  // The sprite settles into the running turn after a short debounce, so quick turns don't flicker.
  await waitFor(() => {
    const face = within(rowButton("Planner")).getByTitle("Planner");
    assert.equal(face.hasAttribute("data-working"), true);
    assert.equal(face.dataset.state, "thinking");
  });
  const resting = within(rowButton("Inbox Helper")).getByTitle("Inbox Helper");
  assert.equal(resting.hasAttribute("data-working"), false);
  assert.equal(resting.hasAttribute("data-live"), false, "a resting Bot's sidebar face is static");
  asking = true;
  act(() => emitBotTestNotification("bots:attention", { botId: "bot-1" }));
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Needs you")));
  await waitFor(() => assert.equal(within(rowButton("Planner")).getByTitle("Planner").dataset.state, "waiting"));
  assert.ok(within(rowButton("Planner")).getByText("Waiting for you"));
  assert.equal(within(rowButton("Inbox Helper")).queryByText("Needs you") === null, true);
  assert.ok(screen.getByRole("button", { name: /^Planner.*Needs you/u }), "the row's name says it needs you");
});

test("a sidebar face shows error when its turn failed, and a stopped turn rests without a done moment", async () => {
  const ends: Record<string, BotLiveSummary["lastTurnEnd"]> = {};
  let running = true;
  sidebarIpc([PLANNER, INBOX], {}, {
    "bots:live:summary": (botId) =>
      running
        ? summary(botId as string, { state: { kind: "running", submissionId: "s1" } })
        : summary(botId as string, ends[botId as string] ? { lastTurnEnd: ends[botId as string] } : {}),
  });
  await mountSidebar();
  const face = (name: string) => within(rowButton(name)).getByTitle(name);
  await waitFor(() => {
    assert.equal(face("Planner").dataset.state, "thinking");
    assert.equal(face("Inbox Helper").dataset.state, "thinking");
  });
  const seen: string[] = [];
  const observer = new MutationObserver(() => seen.push(face("Inbox Helper").dataset.state ?? ""));
  observer.observe(screen.getByRole("navigation", { name: "Bots" }), {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
  ends["bot-1"] = "failed";
  ends["bot-2"] = "stopped";
  running = false;
  act(() => emitBotTestNotification("bots:attention", { botId: "bot-1" }));
  act(() => emitBotTestNotification("bots:attention", { botId: "bot-2" }));
  await waitFor(() => assert.equal(face("Planner").dataset.state, "error"));
  await waitFor(() => assert.equal(face("Inbox Helper").dataset.state, "idle"));
  // Past the length of a done moment, the stopped Bot never showed one.
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  observer.disconnect();
  assert.ok(!seen.includes("done"), `Inbox Helper states: ${seen.join(" → ")}`);
  assert.equal(face("Inbox Helper").hasAttribute("data-live"), false);
  assert.equal(face("Planner").dataset.state, "idle", "the error moment passes");
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
  await screen.findByRole("button", { name: "Inbox Helper settings" });
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
  await screen.findByRole("button", { name: "Inbox Helper settings" });
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

test("an interrupted Bot and a paused one read differently, and one without a model says it needs one", async () => {
  sidebarIpc([PLANNER, INBOX, SCOUT], {
    "bot-1": summary("bot-1", { preview: "Reading your calendar", state: { kind: "interrupted", submissionId: "s1" } }),
    "bot-2": summary("bot-2", { state: { kind: "needs_model" } }),
    "bot-3": summary("bot-3", { preview: "Found three cafés", state: { kind: "paused", since: 1, by: "phone", interrupted: "s9" } }),
  });
  await mountSidebar();
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Interrupted — tap to resume")));
  assert.equal(within(rowButton("Planner")).queryByText("Reading your calendar") === null, true);
  assert.ok(within(rowButton("Inbox Helper")).getByText("Needs an AI model"));
  assert.ok(within(rowButton("Scout")).getByText("Paused"), "a pause outranks the reply it cut short");
  assert.equal(within(rowButton("Scout")).queryByText("Found three cafés"), null);
});

test("a row's menu pauses its Bot, and a paused Bot's menu resumes it", async () => {
  const calls = sidebarIpc([PLANNER, INBOX], {
    "bot-2": summary("bot-2", { state: { kind: "paused", since: 1, by: "mac" } }),
  }, {
    "bots:pause": () => ({ kind: "paused", since: 1, by: "mac" }),
    "bots:unpause": () => ({ kind: "idle" }),
  });
  await mountSidebar();
  await waitFor(() => assert.ok(within(rowButton("Inbox Helper")).getByText("Paused")));

  fireEvent.contextMenu(rowButton("Planner"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pause Bot" }));
  await waitFor(() => assert.deepEqual(calls.filter((call) => call.channel === "bots:pause").map((call) => call.args), [["bot-1"]]));

  fireEvent.keyDown(screen.getByRole("button", { name: "More for Inbox Helper" }), { key: "Enter" });
  assert.equal(screen.queryByRole("menuitem", { name: "Pause Bot" }), null);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Resume Bot" }));
  await waitFor(() => assert.deepEqual(calls.filter((call) => call.channel === "bots:unpause").map((call) => call.args), [["bot-2"]]));
});

test("tapping a row opens that Bot's chat, and its context menu and ••• offer the Bot menu", async () => {
  sidebarIpc([PLANNER, INBOX]);
  const { router } = await mountSidebar();
  fireEvent.click(await screen.findByRole("button", { name: /^Inbox Helper/u }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));

  fireEvent.contextMenu(rowButton("Planner"));
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Pin to top", "Pause Bot", "Delete Bot"]);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

  const inboxRow = rowButton("Inbox Helper").closest("li")!;
  fireEvent.keyDown(within(inboxRow).getByRole("button", { name: "More for Inbox Helper" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Bot" }));
  const confirm = await screen.findByRole("alertdialog");
  assert.ok(within(confirm).getByRole("heading", { name: "Delete Inbox Helper?" }));
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
  await mountSidebar();
  const row = await screen.findByRole("button", { name: /^Inbox Helper/u });
  row.focus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Pin to top", "Pause Bot", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Bot" }));
  assert.ok(within(await screen.findByRole("alertdialog")).getByRole("heading", { name: "Delete Inbox Helper?" }));
});

test("deleting a row's Bot leaves focus on the next row, and deleting the last Bot leaves it on Create", async () => {
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
  await waitFor(() => assert.equal(document.activeElement === screen.getByRole("button", { name: "Create" }), true));
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
  await screen.findByRole("button", { name: "Inbox Helper settings" });
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
      // Waiting on an approval there: its session is still running, and the host says it needs the person.
      {
        id: "remote-3",
        name: "Chief of Staff",
        purpose: "You are the chief of staff.",
        avatar: { semantic: { version: 1, shape: "hex", color: "rose" } },
        sessionState: "running",
        needsYou: true,
      },
    ],
    runs: [],
  });
  sidebarIpc([], {}, { "bots:list": () => [] });
  await mountSidebar("/host/host-b/bots/remote-2/chat", queryClient);
  const working = await screen.findByRole("button", { name: "Reviewer, on Studio, working" });
  assert.ok(within(working).getByText("Thinking…"));
  const open = screen.getByRole("button", { name: "Scout, on Studio" });
  assert.equal(open.getAttribute("aria-current"), "page");
  assert.equal(working.getAttribute("aria-current"), null);
  // A Bot's description is never shown as its line.
  assert.ok(!screen.queryByText("Reviews pull requests"));
  assert.ok(!screen.queryByText("Finds flights"));

  const waiting = screen.getByRole("button", { name: "Chief of Staff, on Studio, needs you" });
  assert.ok(within(waiting).getByText("Needs you"));
  assert.ok(within(waiting).getByText("Waiting for you"));
  assert.ok(!within(waiting).queryByText("Thinking…"));
  assert.ok(waiting.querySelector(".bot-avatar"), "the Bot's own avatar, not a stock icon");
  assert.ok(!working.querySelector(".bot-avatar"), "a row with no avatar keeps the stock icon");
});

test("a paired Mac's Bot shows its last message and photo, and only a reply after it was first listed shows a dot", async () => {
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(hostQueryKeys.list(), [
    { id: "host-b", name: "Studio", enabled: true, state: "connected", features: ["bot-durable-session-v1"], capabilities: ["chat:read", "chat:write", "bot:read", "bot:write"] },
  ]);
  queryClient.setQueryData(hostQueryKeys.statuses(), [
    { hostId: "host-b", generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false },
  ]);
  const revision = `avatar_revision_${"a".repeat(32)}`;
  const feed = (lastReplyAt: string) => ({
    hostId: "host-b",
    epoch: "e1",
    sequence: 1,
    stale: false,
    summaries: [],
    workspaces: [],
    bots: [
      {
        id: "remote-1",
        name: "Scout",
        purpose: "You find flights.",
        avatar: {
          semantic: { version: 1, shape: "orb", color: "rose" },
          asset: { assetRevision: revision, mimeType: "image/png", width: 512, height: 512, byteSize: 4 },
        },
        sessionState: "idle",
        summarized: true,
        lastReplyAt,
        // Another computer's text: the row shows it as one plain line.
        preview: "Flights to Lisbon\nare cheaper on Tuesday",
      },
    ],
    runs: [],
  });
  // The host's clock is a day ahead of this Mac's: only its own times are compared.
  const hostTime = (offset: number) => new Date(Date.now() + 86_400_000 + offset).toISOString();
  queryClient.setQueryData(hostQueryKeys.feed("host-b"), feed(hostTime(0)));
  const photoReads: unknown[] = [];
  sidebarIpc([], {}, {
    "bots:list": () => [],
    "remote:peerCall": (_hostId, raw) => {
      const call = raw as { operation: string; resourceId?: string; itemId?: string };
      if (call.operation !== "botAvatar") return { ok: false, error: { code: "not_found", message: "Not in this test." } };
      photoReads.push(call);
      return { ok: true, value: { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) } };
    },
  });
  const { router } = await mountSidebar("/bots", queryClient);
  // The reply already there when this Mac first lists the Bot starts read.
  const row = await screen.findByRole("button", { name: "Scout, on Studio" });
  assert.ok(within(row).getByText("Flights to Lisbon are cheaper on Tuesday"));
  assert.ok(!within(row).queryByRole("img", { name: "Unread", hidden: true }));
  assert.equal(row.getAttribute("aria-description"), "Flights to Lisbon are cheaper on Tuesday");
  await waitFor(() => assert.equal(row.querySelector("img")?.getAttribute("src"), "data:image/png;base64,AQIDBA=="));
  assert.deepEqual(photoReads, [{ operation: "botAvatar", resourceId: "remote-1", itemId: revision }]);

  // The next reply is new.
  await act(async () => {
    queryClient.setQueryData(hostQueryKeys.feed("host-b"), feed(hostTime(60_000)));
  });
  const unread = await screen.findByRole("button", { name: "Scout, on Studio, unread" });
  assert.ok(within(unread).getByRole("img", { name: "Unread", hidden: true }));

  // The open Bot shows no dot, but choosing it is not seeing the reply: only its chat showing it is.
  await act(async () => {
    await router.navigate({ to: "/host/$hostId/bots/$botId/chat", params: { hostId: "host-b", botId: "remote-1" } });
  });
  await screen.findByRole("button", { name: "Scout, on Studio" });
  await act(async () => {
    await router.navigate({ to: "/bots" });
  });
  await screen.findByRole("button", { name: "Scout, on Studio, unread" });
  assert.equal(photoReads.length, 1, "the same photo is read once");
});

test("a paired Mac whose Bot had no message when first listed shows a dot for that Bot's first reply", async () => {
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(hostQueryKeys.list(), [
    { id: "host-b", name: "Studio", enabled: true, state: "connected", features: ["bot-durable-session-v1"], capabilities: ["chat:read", "chat:write", "bot:read", "bot:write"] },
  ]);
  queryClient.setQueryData(hostQueryKeys.statuses(), [
    { hostId: "host-b", generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false },
  ]);
  const scout = { id: "remote-1", name: "Scout", purpose: "", avatar: { semantic: { version: 1, shape: "orb", color: "rose" } }, sessionState: "idle" };
  const feed = (bot: Record<string, unknown>) => ({
    hostId: "host-b", epoch: "e1", sequence: 1, stale: false, summaries: [], workspaces: [], bots: [bot], runs: [],
  });
  // A new Bot: the host read its summary and found nothing to show.
  queryClient.setQueryData(hostQueryKeys.feed("host-b"), feed({ ...scout, summarized: true }));
  sidebarIpc([], {}, { "bots:list": () => [] });
  await mountSidebar("/bots", queryClient);
  await screen.findByRole("button", { name: "Scout, on Studio" });
  await act(async () => {
    queryClient.setQueryData(hostQueryKeys.feed("host-b"), feed({
      ...scout,
      summarized: true,
      lastReplyAt: new Date(Date.now() - 86_400_000).toISOString(),
      preview: "Found three flights",
    }));
  });
  const unread = await screen.findByRole("button", { name: "Scout, on Studio, unread" });
  assert.ok(within(unread).getByRole("img", { name: "Unread", hidden: true }));
});

test("a paired Mac first listed during a search counts every Bot's reply, also the ones the search hides", async () => {
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(hostQueryKeys.list(), [
    { id: "host-b", name: "Studio", enabled: true, state: "connected", features: ["bot-durable-session-v1"], capabilities: ["chat:read", "chat:write", "bot:read", "bot:write"] },
  ]);
  queryClient.setQueryData(hostQueryKeys.statuses(), [
    { hostId: "host-b", generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false },
  ]);
  const at = (offset: number) => new Date(Date.now() - 86_400_000 + offset).toISOString();
  const bot = (id: string, name: string, lastReplyAt: string) => ({
    id, name, purpose: "", avatar: { semantic: { version: 1, shape: "orb", color: "rose" } }, sessionState: "idle",
    summarized: true, lastReplyAt, preview: `${name} replied`,
  });
  sidebarIpc([], {}, { "bots:list": () => [] });
  await mountSidebar("/bots", queryClient);
  fireEvent.click(screen.getByRole("button", { name: "Search Bots" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Bots" }), { target: { value: "scout" } });
  // The host's Bots arrive while the search shows only Scout; Planner replied later.
  await act(async () => {
    queryClient.setQueryData(hostQueryKeys.feed("host-b"), {
      hostId: "host-b", epoch: "e1", sequence: 1, stale: false, summaries: [], workspaces: [], runs: [],
      bots: [bot("remote-1", "Scout", at(0)), bot("remote-2", "Planner", at(60_000))],
    });
  });
  await screen.findByRole("button", { name: "Scout, on Studio" });
  assert.equal(screen.queryByRole("button", { name: /^Planner/u }), null);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Bots" }), { target: { value: "" } });
  assert.ok(await screen.findByRole("button", { name: "Planner, on Studio" }), "Planner's reply was already there");
});

test("on a Bots page, a paired Mac's Bots keep up with what that Mac sends", async () => {
  const host = {
    id: "host-b",
    name: "Studio",
    enabled: true,
    state: "connected",
    features: ["bot-durable-session-v1", "host-events-v1"],
    capabilities: ["chat:read", "chat:write", "bot:read", "bot:write"],
  };
  const feed = {
    hostId: "host-b",
    epoch: "e1",
    sequence: 1,
    stale: false,
    summaries: [],
    workspaces: [],
    bots: [{ id: "remote-1", name: "Chief of Staff", sessionState: "idle" }],
    runs: [],
  };
  sidebarIpc([], {}, {
    "bots:list": () => [],
    "remote:peersList": () => [host],
    "remote:peerHostStatuses": () => [
      { hostId: "host-b", generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false },
    ],
    "remote:peerHostFeed": () => feed,
  });
  await mountWithBotRouter(null, {
    initialPath: "/bots",
    sidebar: (
      <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, bots: true }}>
        <ChatSidebar activeChatId={undefined} />
      </AppCapabilitiesProvider>
    ),
  });
  await screen.findByRole("button", { name: "Chief of Staff, on Studio" });
  act(() => {
    emitBotTestNotification("remote:host-feed", {
      hostId: "host-b",
      epoch: "e1",
      sequence: 2,
      change: { type: "bot.upsert", row: { id: "remote-1", name: "Chief of Staff", sessionState: "running", needsYou: true } },
    });
  });
  const waiting = await screen.findByRole("button", { name: "Chief of Staff, on Studio, needs you" });
  assert.ok(within(waiting).getByText("Waiting for you"));
});

async function mountLegacyHostWithSlowBot() {
  const queryClient = createBotTestQueryClient();
  // An older host: opening a Bot asks it to create the Bot's chat.
  queryClient.setQueryData(hostQueryKeys.list(), [
    { id: "host-b", name: "Studio", enabled: true, state: "connected", features: [], capabilities: ["chat:read", "chat:write", "bot:read", "bot:write"] },
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
      { id: "slow", name: "Slow", sessionState: "idle" },
      { id: "quick", name: "Quick", sessionState: "idle" },
    ],
    runs: [],
  });
  const slow: { release: () => void } = { release: () => undefined };
  sidebarIpc([], {}, {
    "bots:list": () => [],
    "remote:peerHostStatuses": () => [
      { hostId: "host-b", generation: 1, state: { kind: "connected", since: 1 }, feed: "live", stale: false },
    ],
    "remote:peerCall": (_hostId, raw) => {
      const operation = raw as { operation: string; resourceId?: string };
      if (operation.operation !== "createBotChat") return { ok: false, error: { code: "not_found", message: "Not in this test." } };
      const created = { ok: true, value: { id: `chat-${operation.resourceId}`, workspaceId: "w1", botId: operation.resourceId } };
      return operation.resourceId === "slow" ? new Promise((resolve) => (slow.release = () => resolve(created))) : created;
    },
  });
  const { router } = await mountSidebar("/bots", queryClient);
  return { router, releaseSlow: () => slow.release() };
}

test("while one paired Mac's Bot chat opens, picking another opens that one instead", async () => {
  const { router, releaseSlow } = await mountLegacyHostWithSlowBot();
  fireEvent.click(await screen.findByRole("button", { name: "Slow, on Studio" }));
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Slow, on Studio" }).getAttribute("aria-busy"), "true"));
  fireEvent.click(screen.getByRole("button", { name: "Quick, on Studio" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/host/host-b/chat/chat-quick"));
  await act(async () => {
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(router.state.location.pathname, "/host/host-b/chat/chat-quick", "the earlier open does not take over");
});

test("picking a paired Mac's Bot again while its chat opens still opens it", async () => {
  const { router, releaseSlow } = await mountLegacyHostWithSlowBot();
  const row = () => screen.getByRole("button", { name: "Slow, on Studio" });
  fireEvent.click(await screen.findByRole("button", { name: "Slow, on Studio" }));
  await waitFor(() => assert.equal(row().getAttribute("aria-busy"), "true"));
  fireEvent.click(row());
  await act(async () => {
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await waitFor(() => assert.equal(router.state.location.pathname, "/host/host-b/chat/chat-slow"));
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
  await mountSidebar();
  const row = await screen.findByRole("button", { name: /^Planner/u });
  row.focus();
  fireEvent.keyDown(row, { key: "ContextMenu" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin to top" }));
  await waitFor(() =>
    assert.equal(parseBotSidebarPreferences(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY), 0).pinnedBotId, "bot-1"),
  );
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
  await screen.findByRole("button", { name: "Planner settings" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const before = rowRenders();
  await act(() => router.navigate({ to: "/bots/$botId/chat", params: { botId: "bot-3" } }));
  await screen.findByRole("button", { name: "Scout settings" });
  await waitFor(() => assert.equal(rowButton("Scout").getAttribute("aria-current"), "page"));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(rowRenders() - before, 2, "Planner and Scout, not every row");
});

test("the chat keys work for Bots too: ⌘1–9 open the Bot on that row, ⇧⌘[ and ⇧⌘] the one above or below", async () => {
  sidebarIpc([PLANNER, INBOX, SCOUT], {
    "bot-1": summary("bot-1", { updatedAt: 100 }),
    "bot-2": summary("bot-2", { updatedAt: 300 }),
    "bot-3": summary("bot-3", { updatedAt: 200 }),
  });
  let run: (commandId: CommandId) => boolean = () => false;
  function Commands() {
    run = useCommandSystem().execute;
    return null;
  }
  const { router } = await mountWithBotRouter(null, {
    initialPath: "/bots",
    sidebar: (
      <>
        <Commands />
        <BotSidebar />
      </>
    ),
  });
  await waitFor(() => assert.deepEqual(rowOrder(), ["Inbox Helper", "Scout", "Planner"]));
  const at = () => router.state.location.pathname;

  act(() => void run("chat.jump.3"));
  // The third row is Planner.
  await waitFor(() => assert.equal(at(), "/bots/bot-1/chat"));
  act(() => void run("chat.previous"));
  await waitFor(() => assert.equal(at(), "/bots/bot-3/chat"));
  act(() => void run("chat.previous"));
  await waitFor(() => assert.equal(at(), "/bots/bot-2/chat"));
  act(() => void run("chat.next"));
  await waitFor(() => assert.equal(at(), "/bots/bot-3/chat"));
  assert.equal(run("chat.jump.4"), false, "no fourth Bot, so nothing to open");
});

test("the Bot list is one Tab stop on the open Bot, and ↓ and Home move between rows", async () => {
  sidebarIpc([PLANNER, INBOX, SCOUT], {
    "bot-1": summary("bot-1", { updatedAt: 100 }),
    "bot-2": summary("bot-2", { updatedAt: 300 }),
    "bot-3": summary("bot-3", { updatedAt: 200 }),
  });
  await mountSidebar("/bots/bot-3/chat");
  await waitFor(() => assert.equal(rowButton("Scout").getAttribute("aria-current"), "page"));
  const stops = () =>
    ["Inbox Helper", "Scout", "Planner"].filter((name) => rowButton(name).getAttribute("tabindex") !== "-1");
  await waitFor(() => assert.deepEqual(stops(), ["Scout"]));
  rowButton("Scout").focus();
  fireEvent.keyDown(rowButton("Scout"), { key: "ArrowDown" });
  assert.equal(document.activeElement, rowButton("Planner"));
  fireEvent.keyDown(rowButton("Planner"), { key: "Home" });
  assert.equal(document.activeElement, rowButton("Inbox Helper"));
});
