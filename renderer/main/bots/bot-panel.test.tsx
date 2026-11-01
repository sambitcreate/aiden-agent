import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
// Before anything loads react-dom, so React reports its commits to the probe.
import { countRenders } from "./test-render-probe";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { BotLiveSnapshot, BotTranscriptEntry } from "../../shared/bot-live";
import type { BotMemoryView } from "../../shared/bot-memory";
import { useBotLive } from "../../lib/use-bot-live";
import {
  BOT_PANEL_OPEN_KEY,
  BOT_PANEL_TAB_KEY,
  BotPanelProvider,
  RoutedBotPanelProvider,
  useBotPanel,
  useBotPanelActions,
} from "./bot-panel-context";
import { BOT_SIDEBAR_PREFERENCES_KEY, parseBotSidebarPreferences } from "../../lib/bot-sidebar-preferences";
import { BotPanelFiles } from "./bot-panel-files";
import { BotPanelActivity } from "./bot-panel-activity";
import { BotChatPane } from "./bot-chat-pane";
import { botSidebarPreferenceActions } from "./use-bot-sidebar-preferences";
import { shouldRestoreEnvironmentFocus } from "../../lib/environment-panel-state";
import { botFixture } from "./test-fixtures";
import { mountWithBotRouter } from "./test-providers";

beforeEach(() => {
  installBotTestIpc();
  localStorage.clear();
});
afterEach(cleanup);

function PanelProbe() {
  const panel = useBotPanel();
  const request = panel.fileRequest
    ? `${panel.fileRequest.botId}:${panel.fileRequest.path}#${panel.fileRequest.key}`
    : "none";
  return (
    <>
      <output aria-label="Panel">{`${panel.open ? "open" : "closed"} ${panel.tab} ${request}`}</output>
      <button type="button" onClick={() => panel.show("files", { botId: "bot-a", path: "lists/groceries.md" })}>
        Open groceries
      </button>
      <button type="button" onClick={() => panel.show("memory")}>
        Open memory
      </button>
      <button type="button" onClick={panel.toggle}>
        Toggle
      </button>
    </>
  );
}

const panelState = () => screen.getByRole("status", { name: "Panel" }).textContent ?? "";

test("a file asked for twice is two requests, and the toggle closes and reopens on the same tab", () => {
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "closed activity none");
  fireEvent.click(screen.getByRole("button", { name: "Open groceries" }));
  const first = panelState();
  assert.match(first, /^open files bot-a:lists\/groceries\.md#\d+$/u);
  fireEvent.click(screen.getByRole("button", { name: "Open groceries" }));
  assert.notEqual(panelState(), first, "the same chip clicked again selects its file again");
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  assert.match(panelState(), /^closed files /u);
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  assert.match(panelState(), /^open files /u);
});

test("the Bot panel comes back open on its last tab after a relaunch, under its own keys only", () => {
  const first = render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open memory" }));
  first.unmount();
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "open memory none");
  assert.equal(localStorage.getItem(BOT_PANEL_OPEN_KEY), "true");
  assert.equal(localStorage.getItem(BOT_PANEL_TAB_KEY), "memory");
  for (const key of [
    "aiden-agent.environment.open",
    "aiden-agent.environment.open-tabs-v1",
    "aiden-agent.environment.tab",
    "aiden-agent.quick-view.open",
  ]) {
    assert.equal(localStorage.getItem(key), null, key);
  }
});

test("a saved tab this build doesn't know, or a garbled open flag, opens closed on Activity", () => {
  localStorage.setItem(BOT_PANEL_TAB_KEY, "sketchbook");
  localStorage.setItem(BOT_PANEL_OPEN_KEY, "yes");
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "closed activity none");
});

test("the panel persists under its literal keys, so a relaunch finds them", () => {
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open memory" }));
  assert.equal(localStorage.getItem("aiden-agent.bot-panel.open"), "true");
  assert.equal(localStorage.getItem("aiden-agent.bot-panel.tab"), "memory");
});

test("storage that throws leaves the panel closed on Activity, and it still works", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const broken = {
    getItem: () => {
      throw new Error("storage is blocked");
    },
    setItem: () => {
      throw new Error("storage is blocked");
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: broken });
  try {
    render(
      <BotPanelProvider>
        <PanelProbe />
      </BotPanelProvider>,
    );
    assert.equal(panelState(), "closed activity none");
    fireEvent.click(screen.getByRole("button", { name: "Open memory" }));
    assert.equal(panelState(), "open memory none");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
  }
});

test("a path asked for without its Bot selects nothing, and the same path twice is two requests", () => {
  function Unscoped() {
    const panel = useBotPanel();
    return (
      <>
        <output aria-label="Key">{String(panel.fileRequest?.key ?? "none")}</output>
        <button
          type="button"
          onClick={() => panel.show("files", { path: "a.md" } as unknown as { path: string; botId: string })}
        >
          Unscoped
        </button>
        <button type="button" onClick={() => panel.show("files", { botId: "bot-a", path: "a.md" })}>
          Scoped
        </button>
      </>
    );
  }
  render(
    <BotPanelProvider>
      <Unscoped />
    </BotPanelProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Unscoped" }));
  assert.equal(screen.getByLabelText("Key").textContent, "none");
  fireEvent.click(screen.getByRole("button", { name: "Scoped" }));
  const first = screen.getByLabelText("Key").textContent;
  fireEvent.click(screen.getByRole("button", { name: "Scoped" }));
  assert.notEqual(screen.getByLabelText("Key").textContent, first);
});

test("a file asked for in one Bot's chat is dropped when the chat moves to another Bot", () => {
  const view = render(
    <BotPanelProvider routedBotId="bot-a">
      <PanelProbe />
    </BotPanelProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open groceries" }));
  assert.match(panelState(), /^open files bot-a:lists\/groceries\.md#\d+$/u);
  view.rerender(
    <BotPanelProvider routedBotId="bot-b">
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "open files none", "the panel stays open on its tab; only the stale file request goes");
});

test("a page that is not a Bot chat keeps a file request, so it lands when that Bot's chat opens", () => {
  const tree = (routedBotId: string | null) => (
    <BotPanelProvider routedBotId={routedBotId}>
      <PanelProbe />
    </BotPanelProvider>
  );
  // From Bot B's chat the person asks for one of Bot A's files (say, from the sidebar), on the way to A's chat.
  const view = render(tree("bot-b"));
  fireEvent.click(screen.getByRole("button", { name: "Open groceries" }));
  const request = panelState();
  assert.match(request, /^open files bot-a:lists\/groceries\.md#\d+$/u);
  view.rerender(tree(null));
  assert.equal(panelState(), request, "a page that is no Bot's chat keeps it");
  view.rerender(tree("bot-a"));
  assert.equal(panelState(), request, "B → nowhere → A keeps the request made for A");
  view.rerender(tree(null));
  view.rerender(tree("bot-b"));
  assert.equal(panelState(), "open files none", "reaching a different Bot drops it");
});

test("the routed provider follows the router: a request for one Bot is dropped on reaching another, and it stops listening when it unmounts", async () => {
  const rootRoute = createRootRoute({
    component: () => (
      <RoutedBotPanelProvider>
        <PanelProbe />
        <Outlet />
      </RoutedBotPanelProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ["/bots", "/bots/$botId/chat"].map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null })),
    ),
    history: createMemoryHistory({ initialEntries: ["/bots/bot-a/chat"] }),
  });
  let listening = 0;
  const subscribe = router.subscribe.bind(router);
  router.subscribe = ((eventType, listener) => {
    const stop = subscribe(eventType, listener);
    if (eventType !== "onResolved") return stop;
    listening += 1;
    return () => {
      listening -= 1;
      stop();
    };
  }) as typeof router.subscribe;
  // Under `tsx --test` TanStack runs as on a server and never emits onResolved itself.
  const resolve = () =>
    act(() =>
      router.emit({
        type: "onResolved",
        fromLocation: undefined,
        toLocation: router.state.location,
        pathChanged: true,
        hrefChanged: true,
        hashChanged: false,
      }),
    );
  await router.load();
  const view = render(<RouterProvider router={router} />);
  await screen.findByRole("button", { name: "Open groceries" });
  fireEvent.click(screen.getByRole("button", { name: "Open groceries" }));
  assert.match(panelState(), /^open files bot-a:/u);
  await act(() => router.navigate({ to: "/bots" }));
  resolve();
  assert.match(panelState(), /^open files bot-a:/u, "the Bots home is not another Bot");
  await act(() => router.navigate({ to: "/bots/$botId/chat", params: { botId: "bot-b" } }));
  resolve();
  assert.equal(panelState(), "open files none");
  assert.equal(listening, 1);
  view.unmount();
  assert.equal(listening, 0, "unmounting removes its router listener");
  resolve();
});

test("a component that only acts keeps one stable set of actions while panel state changes", () => {
  const seen: unknown[] = [];
  function ActsOnly() {
    seen.push(useBotPanelActions());
    return null;
  }
  render(
    <BotPanelProvider>
      <ActsOnly />
      <PanelProbe />
    </BotPanelProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open memory" }));
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  assert.equal(new Set(seen).size, 1);
});

const liveSnapshot = (botId: string, text?: string): BotLiveSnapshot => ({
  botId,
  epoch: "e1",
  seq: 0,
  entries: text ? [{ id: `${botId}-u0`, type: "user", text, imageCount: 0 }] : [],
  partial: null,
  state: { kind: "idle" },
  question: null,
  activity: null,
  queued: [],
});

const liveCalls = (calls: { channel: string }[], channel: "subscribe" | "unsubscribe") =>
  calls.filter((call) => call.channel === `bots:live:${channel}`).length;

function LiveProbe({ label }: { label: string }) {
  const live = useBotLive("bot-1");
  return <p aria-label={label}>{live.snapshot ? `${live.snapshot.entries.length} entries` : "loading"}</p>;
}

function SharedLive({ second }: { second: boolean }) {
  return (
    <>
      <LiveProbe label="Chat view" />
      {second ? <LiveProbe label="Activity view" /> : null}
    </>
  );
}

test("a Bot's chat and its Activity tab share one live subscription, and closing the tab never stops the chat's", async () => {
  const calls = installBotTestIpc({
    "bots:live:subscribe": () => liveSnapshot("bot-1"),
    "bots:live:unsubscribe": () => undefined,
  });
  const view = render(<SharedLive second />);
  await waitFor(() => assert.equal(screen.getByLabelText("Activity view").textContent, "0 entries"));
  view.rerender(<SharedLive second={false} />);
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "e1",
    seq: 1,
    type: "entry",
    entry: { id: "u1", type: "user", text: "Plan dinners", imageCount: 0 },
  }));
  await waitFor(() => assert.equal(screen.getByLabelText("Chat view").textContent, "1 entries"));
  assert.equal(liveCalls(calls, "subscribe"), 1);
  assert.equal(liveCalls(calls, "unsubscribe"), 0);
});

function Standalone({ label }: { label: string }) {
  const live = useBotLive("bot-1");
  return <p aria-label={label}>{live.snapshot ? "ready" : live.failed ? "failed" : "loading"}</p>;
}

test("independent consumers of one Bot still make a single subscribe, and the last one out closes it", async () => {
  const calls = installBotTestIpc({
    "bots:live:subscribe": () => liveSnapshot("bot-1"),
    "bots:live:unsubscribe": () => undefined,
  });
  const view = render(
    <>
      <Standalone label="One" />
      <Standalone label="Two" />
      <LiveProbe label="Three" />
    </>,
  );
  await waitFor(() => assert.equal(screen.getByLabelText("Three").textContent, "0 entries"));
  assert.equal(screen.getByLabelText("One").textContent, "ready");
  assert.equal(screen.getByLabelText("Two").textContent, "ready");
  view.rerender(<Standalone label="Two" />);
  assert.equal(liveCalls(calls, "unsubscribe"), 0, "one consumer is still watching");
  view.unmount();
  await waitFor(() => assert.equal(liveCalls(calls, "unsubscribe"), 1));
  assert.equal(liveCalls(calls, "subscribe"), 1);
});

function SwitchProbe({ botId }: { botId: string }) {
  const live = useBotLive(botId);
  const seen = live.snapshot ? `${live.snapshot.botId}:${live.snapshot.entries.map((entry) => entry.id).join(",")}` : "loading";
  return <p aria-label="Switched">{seen}</p>;
}

test("switching Bots never shows the old Bot's conversation, even for an old event or a slow answer", async () => {
  let answerSecond: (snapshot: BotLiveSnapshot) => void = () => undefined;
  const calls = installBotTestIpc({
    "bots:live:subscribe": (botId) =>
      botId === "bot-1"
        ? liveSnapshot("bot-1", "first Bot's message")
        : new Promise<BotLiveSnapshot>((resolve) => {
            answerSecond = resolve;
          }),
    "bots:live:unsubscribe": () => undefined,
  });
  // A sibling keeps Bot 1's feed open, so its events still reach this window:
  // only the Bot id filter stands between them and the Bot 2 view.
  const tree = (botId: string) => (
    <>
      <SwitchProbe botId={botId} />
      <Standalone label="Bot 1 elsewhere" />
    </>
  );
  const view = render(tree("bot-1"));
  await waitFor(() => assert.equal(screen.getByLabelText("Switched").textContent, "bot-1:bot-1-u0"));
  view.rerender(tree("bot-2"));
  assert.equal(screen.getByLabelText("Switched").textContent, "loading", "not the old Bot's view, not even for one render");
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "e1",
    seq: 1,
    type: "entry",
    entry: { id: "late", type: "user", text: "too late", imageCount: 0 },
  }));
  assert.equal(screen.getByLabelText("Switched").textContent, "loading");
  act(() => answerSecond(liveSnapshot("bot-2", "second Bot's message")));
  await waitFor(() => assert.equal(screen.getByLabelText("Switched").textContent, "bot-2:bot-2-u0"));
  assert.deepEqual(
    calls.filter((call) => call.channel.startsWith("bots:live:")).map((call) => `${call.channel}:${String(call.args[0])}`),
    ["bots:live:subscribe:bot-1", "bots:live:subscribe:bot-2"],
  );
});

test("a subscribe that failed is retried when a later consumer joins, instead of wedging it", async () => {
  let attempts = 0;
  const calls = installBotTestIpc({
    "bots:live:subscribe": () => {
      attempts += 1;
      if (attempts === 1) throw new Error("main was busy");
      return liveSnapshot("bot-1");
    },
    "bots:live:unsubscribe": () => undefined,
  });
  const view = render(<Standalone label="First" />);
  await waitFor(() => assert.equal(screen.getByLabelText("First").textContent, "failed"));
  view.rerender(
    <>
      <Standalone label="First" />
      <Standalone label="Later" />
    </>,
  );
  await waitFor(() => assert.equal(screen.getByLabelText("Later").textContent, "ready"));
  assert.equal(screen.getByLabelText("First").textContent, "ready");
  assert.equal(liveCalls(calls, "subscribe"), 2);
  view.unmount();
  render(<Standalone label="After everyone left" />);
  await waitFor(() => assert.equal(screen.getByLabelText("After everyone left").textContent, "ready"));
});

test("remounting a consumer in one commit, then a second root joining mid-subscribe, still leaves one open subscription", async () => {
  let answer: (snapshot: BotLiveSnapshot) => void = () => undefined;
  const calls = installBotTestIpc({
    "bots:live:subscribe": () =>
      new Promise<BotLiveSnapshot>((resolve) => {
        answer = resolve;
      }),
    "bots:live:unsubscribe": () => undefined,
  });
  const first = render(<Standalone key="before" label="Chat" />);
  first.rerender(<Standalone key="after" label="Chat" />);
  const second = render(<Standalone label="Panel" />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  answer(liveSnapshot("bot-1"));
  await waitFor(() => assert.equal(screen.getByLabelText("Panel").textContent, "ready"));
  assert.equal(screen.getByLabelText("Chat").textContent, "ready");
  assert.equal(liveCalls(calls, "subscribe"), 1);
  const liveChannels = calls.filter((call) => call.channel.startsWith("bots:live:"));
  assert.notEqual(liveChannels[liveChannels.length - 1]?.channel, "bots:live:unsubscribe", "main is still subscribed");
  second.unmount();
  first.unmount();
  await waitFor(() => assert.equal(liveCalls(calls, "unsubscribe"), 1));
});

test("a gap that cannot be re-subscribed keeps the last view, flagged as failed, once retries run out", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    installBotTestIpc({
      "bots:live:subscribe": () => {
        calls += 1;
        if (calls === 1) return liveSnapshot("bot-1", "still here");
        throw new Error("main went away");
      },
      "bots:live:unsubscribe": () => undefined,
    });
    function Last() {
      const live = useBotLive("bot-1");
      return <p aria-label="Last">{`${live.snapshot ? live.snapshot.entries.length : "none"} ${live.failed ? "failed" : "ok"}`}</p>;
    }
    const flush = () => act(async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); });
    render(<Last />);
    await flush();
    assert.equal(screen.getByLabelText("Last").textContent, "1 ok");
    act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "e1", seq: 9, type: "partial", text: "x" }));
    await flush();
    for (const delay of [500, 1000, 1500]) {
      assert.equal(screen.getByLabelText("Last").textContent, "1 ok", "still retrying");
      mock.timers.tick(delay);
      await flush();
    }
    assert.equal(screen.getByLabelText("Last").textContent, "1 failed");
  } finally {
    mock.timers.reset();
  }
});

test("a consumer joining a store that failed after it had a view retries it", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    const ipc = installBotTestIpc({
      "bots:live:subscribe": () => {
        calls += 1;
        if (calls === 2 || calls === 3 || calls === 4 || calls === 5) throw new Error("main went away");
        return liveSnapshot("bot-1", `reply ${calls}`);
      },
      "bots:live:unsubscribe": () => undefined,
    });
    const flush = () => act(async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); });
    const view = render(<Standalone label="Chat" />);
    await flush();
    act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "e1", seq: 9, type: "partial", text: "x" }));
    await flush();
    for (const delay of [500, 1000, 1500]) {
      mock.timers.tick(delay);
      await flush();
    }
    assert.equal(screen.getByLabelText("Chat").textContent, "ready", "failed, but its last view is kept");
    view.rerender(
      <>
        <Standalone label="Chat" />
        <Standalone label="Panel" />
      </>,
    );
    await flush();
    assert.equal(calls, 6, "joining retried the subscription once");
    assert.equal(liveCalls(ipc, "subscribe"), 6);
    assert.equal(screen.getByLabelText("Panel").textContent, "ready");
  } finally {
    mock.timers.reset();
  }
});

test("a joining consumer's retry that fails too keeps the last view on screen, flagged as failed", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    installBotTestIpc({
      "bots:live:subscribe": () => {
        calls += 1;
        if (calls === 1) return liveSnapshot("bot-1", "still here");
        throw new Error("main went away");
      },
      "bots:live:unsubscribe": () => undefined,
    });
    function Kept({ label }: { label: string }) {
      const live = useBotLive("bot-1");
      return <p aria-label={label}>{`${live.snapshot ? live.snapshot.entries.length : "none"} ${live.failed ? "failed" : "ok"}`}</p>;
    }
    const flush = () => act(async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); });
    const view = render(<Kept label="Chat" />);
    await flush();
    act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "e1", seq: 9, type: "partial", text: "x" }));
    await flush();
    for (const delay of [500, 1000, 1500]) {
      mock.timers.tick(delay);
      await flush();
    }
    assert.equal(screen.getByLabelText("Chat").textContent, "1 failed");
    assert.equal(calls, 5, "the first view, the gap's re-subscribe and three retries");
    view.rerender(
      <>
        <Kept label="Chat" />
        <Kept label="Panel" />
      </>,
    );
    assert.equal(screen.getByLabelText("Panel").textContent, "1 failed", "the joiner sees the kept view while it retries");
    await flush();
    assert.equal(calls, 6, "joining retried the subscription once");
    assert.equal(screen.getByLabelText("Chat").textContent, "1 failed", "the retry failed, and the view is still there");
    assert.equal(screen.getByLabelText("Panel").textContent, "1 failed");
  } finally {
    mock.timers.reset();
  }
});

function chatSnapshot(entries: BotTranscriptEntry[] = []): BotLiveSnapshot {
  return {
    botId: "bot-1",
    epoch: "e1",
    seq: 0,
    entries,
    partial: null,
    state: { kind: "idle" },
    question: null,
    activity: null,
    queued: [],
  };
}

const FILE_HANDLERS = {
  "bots:files:list": () => ({
    entries: [
      { path: "lists", name: "lists", parentPath: "", depth: 0, kind: "directory" },
      { path: "lists/groceries.md", name: "groceries.md", parentPath: "lists", depth: 1, kind: "file" },
    ],
    truncated: false,
    skippedDirectories: 0,
  }),
  "bots:files:read": (_botId: unknown, path: unknown) => ({ path, content: "eggs\nmilk", size: 9, modifiedAt: 1, version: "v1" }),
};

async function mountBotChat(handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls = installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => chatSnapshot(),
    "bots:live:unsubscribe": () => undefined,
    "bots:routines:list": () => [],
    ...handlers,
  });
  const mounted = await mountWithBotRouter(null, { initialPath: "/bots/bot-1/chat" });
  await screen.findByRole("button", { name: "Planner profile" });
  return { calls, ...mounted };
}

// A closed panel is aria-hidden, which leaves it without an accessible name; find it by its id.
const botPanel = (): HTMLElement => {
  const panel = document.getElementById("bot-panel");
  assert.ok(panel, "the Bot panel is mounted");
  return panel;
};
const panelTab = (name: string) => within(botPanel()).getByRole("tab", { name });

test("the panel toggle opens the Bot panel with only Bot tabs, focused on the selected tab, and Close gives focus back", async () => {
  await mountBotChat();
  assert.equal(botPanel().getAttribute("data-state"), "closed");
  const toggle = screen.getByRole("button", { name: "Show panel" });
  toggle.focus();
  fireEvent.click(toggle);
  assert.equal(botPanel().getAttribute("data-state"), "open");
  assert.equal(screen.getByRole("complementary", { name: "Bot panel" }) === botPanel(), true);
  assert.deepEqual(
    within(botPanel()).getAllByRole("tab").map((tab) => tab.textContent),
    ["Activity", "Files", "Memory", "Routines"],
  );
  assert.equal(within(botPanel()).queryByRole("button", { name: /^Close .+ tab$/u }), null, "Bot tabs are fixed");
  assert.equal(within(botPanel()).queryByRole("button", { name: "New workspace tab" }), null);
  assert.equal(within(botPanel()).queryByRole("button", { name: "Open tabs" }) === null, true, "four fixed tabs need no list");
  await waitFor(() => assert.equal(document.activeElement === panelTab("Activity"), true));
  assert.equal(
    shouldRestoreEnvironmentFocus(document.activeElement, "tools"),
    false,
    "focus in the Bot panel is never the workspace panel's to restore",
  );
  fireEvent.keyDown(panelTab("Activity"), { key: "ArrowRight" });
  await waitFor(() => assert.equal(document.activeElement === panelTab("Files"), true));
  assert.equal(panelTab("Files").getAttribute("aria-selected"), "true");
  assert.equal(screen.getByRole("button", { name: "Hide panel" }).getAttribute("aria-pressed"), "true");
  fireEvent.click(within(botPanel()).getByRole("button", { name: "Close Bot panel" }));
  assert.equal(botPanel().getAttribute("data-state"), "closed");
  await waitFor(() => assert.equal(document.activeElement === screen.getByRole("button", { name: "Show panel" }), true));
});

test("a panel restored open at launch does not take focus", async () => {
  localStorage.setItem("aiden-agent.bot-panel.open", "true");
  await mountBotChat();
  assert.equal(botPanel().getAttribute("data-state"), "open");
  await waitFor(() => assert.ok(within(botPanel()).getByText("No activity yet")));
  // The panel's focus hand-off runs in the frame after it opens; let that frame pass.
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(botPanel().contains(document.activeElement), false);
});

test("Escape inside the Bot panel closes it and leaves the workspace panel's saved state alone", async () => {
  localStorage.setItem("aiden-agent.environment.open", "true");
  localStorage.setItem("aiden-agent.environment.open-tabs-v1", JSON.stringify(["files"]));
  await mountBotChat();
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Routines"));
  panelTab("Routines").focus();
  fireEvent.keyDown(panelTab("Routines"), { key: "Escape" });
  assert.equal(botPanel().getAttribute("data-state"), "closed");
  assert.equal(localStorage.getItem("aiden-agent.environment.open"), "true");
  assert.equal(localStorage.getItem("aiden-agent.environment.open-tabs-v1"), JSON.stringify(["files"]));
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  assert.equal(panelTab("Routines").getAttribute("aria-selected"), "true", "it reopens where it was");
});

test("Activity lists every step newest reply first, names a routine run, and tells failed from blocked", async () => {
  const today = new Date().setHours(12, 0, 0, 0);
  const yesterday = new Date(today).setDate(new Date(today).getDate() - 1);
  const { calls } = await mountBotChat({
    "bots:live:subscribe": () =>
      chatSnapshot([
        { id: "r1", type: "routine", label: "Sunday plan", text: "Plan next week", at: yesterday },
        { id: "a1", type: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", kind: "reading", label: "Read 1 file", detail: "pantry.md" }], stopReason: "toolUse", at: yesterday },
        { id: "t1", type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, status: "ok" },
        { id: "a2", type: "assistant", text: "Planned.", toolCalls: [], stopReason: "stop", at: yesterday },
        { id: "u1", type: "user", text: "Plan dinners for this week", imageCount: 0, at: today },
        {
          id: "a3",
          type: "assistant",
          text: "",
          toolCalls: [
            { id: "c2", name: "web_search", kind: "searching", label: "Searched the web", detail: "dairy-free dinners" },
            { id: "c3", name: "run_command", kind: "command", label: "Ran a command" },
            { id: "c4", name: "edit_file", kind: "editing", label: "Edited 1 file", detail: "meal-plan.md" },
          ],
          stopReason: "toolUse",
          at: today,
        },
        { id: "t2", type: "tool_result", toolCallId: "c2", toolName: "web_search", isError: false, status: "ok" },
        { id: "t3", type: "tool_result", toolCallId: "c3", toolName: "run_command", isError: true, status: "failed" },
        { id: "t4", type: "tool_result", toolCallId: "c4", toolName: "edit_file", isError: true, status: "blocked" },
        { id: "a4", type: "assistant", text: "Here's your week.", toolCalls: [], stopReason: "stop", at: today },
      ]),
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  const headings = await within(botPanel()).findAllByRole("heading");
  assert.match(headings[0]!.textContent ?? "", /^Today, .+ · Plan dinners for this week$/u);
  assert.match(headings[1]!.textContent ?? "", /^Yesterday, .+ · Sunday plan \(routine\)$/u);
  const steps = within(botPanel()).getAllByRole("listitem").map((item) => item.textContent);
  assert.deepEqual(steps, [
    "Searched the web · dairy-free dinners",
    "Couldn’t run a command",
    "Blocked: edit a file · meal-plan.md",
    "Read 1 file · pantry.md",
  ]);
  assert.equal(calls.filter((call) => call.channel === "bots:live:subscribe").length, 1, "the chat and Activity share one subscription");
});

test("Activity shows every step even when the chat keeps its activity quiet", async () => {
  await mountBotChat({
    "bots:get": () => botFixture({ chatActivity: { level: "quiet", wording: "follows" } }),
    "bots:live:subscribe": () =>
      chatSnapshot([
        { id: "u1", type: "user", text: "Go", imageCount: 0, at: Date.now() },
        { id: "a1", type: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", kind: "reading", label: "Read 1 file" }], stopReason: "toolUse" },
        { id: "t1", type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, status: "ok" },
        { id: "a2", type: "assistant", text: "Done.", toolCalls: [], stopReason: "stop" },
      ]),
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  assert.deepEqual(
    (await within(botPanel()).findAllByRole("listitem")).map((item) => item.textContent),
    ["Read 1 file"],
  );
});

test("Files lists the Bot's folder and opens a file read-only, with All files to go back, keeping focus in the panel", async () => {
  const { calls } = await mountBotChat(FILE_HANDLERS);
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Files"));
  const fileRow = await within(botPanel()).findByRole("button", { name: "groceries.md" });
  fileRow.focus();
  fireEvent.click(fileRow);
  assert.equal((await within(botPanel()).findByLabelText("Contents of lists/groceries.md")).textContent, "eggs\nmilk");
  assert.deepEqual(calls.find((call) => call.channel === "bots:files:read")?.args, ["bot-1", "lists/groceries.md"]);
  // The row it was on is gone; focus lands on the open file's name, not on the page.
  await waitFor(() =>
    assert.equal(document.activeElement === within(botPanel()).getByRole("heading", { name: "groceries.md" }), true),
  );
  const allFiles = within(botPanel()).getByRole("button", { name: "All files" });
  allFiles.focus();
  fireEvent.click(allFiles);
  assert.ok(await within(botPanel()).findByRole("list", { name: "Files" }));
  await waitFor(() =>
    assert.equal(document.activeElement === within(botPanel()).getByRole("button", { name: "groceries.md" }), true),
  );
  // Escape still closes the panel, because focus never fell out of it.
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
  assert.equal(botPanel().getAttribute("data-state"), "closed");
});

test("Files opens a requested file only for its own Bot, once, and not again after a remount", async () => {
  const calls = installBotTestIpc(FILE_HANDLERS);
  function Harness({ mounted }: { mounted: boolean }) {
    const panel = useBotPanel();
    return (
      <>
        <button type="button" onClick={() => panel.show("files", { botId: "bot-2", path: "lists/groceries.md" })}>
          Other Bot's file
        </button>
        <button type="button" onClick={() => panel.show("files", { botId: "bot-1", path: "lists/groceries.md" })}>
          This Bot's file
        </button>
        {mounted ? <BotPanelFiles botId="bot-1" botName="Planner" active request={panel.fileRequest} /> : null}
      </>
    );
  }
  const tree = (mounted: boolean) => (
    <BotPanelProvider routedBotId="bot-1">
      <Harness mounted={mounted} />
    </BotPanelProvider>
  );
  const reads = () => calls.filter((call) => call.channel === "bots:files:read").length;
  const view = render(tree(true));
  await screen.findByRole("list", { name: "Files" });
  fireEvent.click(screen.getByRole("button", { name: "Other Bot's file" }));
  assert.ok(screen.getByRole("list", { name: "Files" }), "another Bot's request is not this Bot's file");
  assert.equal(reads(), 0);
  fireEvent.click(screen.getByRole("button", { name: "This Bot's file" }));
  assert.ok(await screen.findByLabelText("Contents of lists/groceries.md"));
  fireEvent.click(screen.getByRole("button", { name: "All files" }));
  view.rerender(tree(false));
  view.rerender(tree(true));
  assert.ok(await screen.findByRole("list", { name: "Files" }), "a remount does not reopen an old request");
  assert.equal(reads(), 1);
  fireEvent.click(screen.getByRole("button", { name: "This Bot's file" }));
  assert.ok(await screen.findByLabelText("Contents of lists/groceries.md"), "the same chip again is a new request");
  assert.equal(reads(), 2);
});

test("a file the Bot wrote is a chip that opens the panel's Files tab on that file, again after going back", async () => {
  await mountBotChat({
    ...FILE_HANDLERS,
    "bots:live:subscribe": () =>
      chatSnapshot([
        { id: "u1", type: "user", text: "Write my grocery list", imageCount: 0 },
        { id: "f1", type: "file", path: "lists/groceries.md", operation: "written" },
        { id: "a1", type: "assistant", text: "Done.", toolCalls: [], stopReason: "stop" },
      ]),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open groceries.md" }));
  assert.equal(botPanel().getAttribute("data-state"), "open");
  assert.equal(panelTab("Files").getAttribute("aria-selected"), "true");
  assert.equal((await within(botPanel()).findByLabelText("Contents of lists/groceries.md")).textContent, "eggs\nmilk");
  fireEvent.click(within(botPanel()).getByRole("button", { name: "All files" }));
  await within(botPanel()).findByRole("list", { name: "Files" });
  fireEvent.click(screen.getByRole("button", { name: "Open groceries.md" }));
  assert.ok(await within(botPanel()).findByLabelText("Contents of lists/groceries.md"), "the same chip selects its file again");
  assert.equal(screen.queryByRole("dialog"), null, "no Files dialog any more");
});

test("Files and Memory in the chat's ••• menu open the panel on that tab", async () => {
  await mountBotChat({ ...FILE_HANDLERS, "bots:memory:get": () => memoryView([]) });
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  assert.equal(panelTab("Files").getAttribute("aria-selected"), "true");
  assert.ok(await within(botPanel()).findByRole("button", { name: "groceries.md" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Memory" }));
  assert.equal(panelTab("Memory").getAttribute("aria-selected"), "true");
});

test("Routines in the chat's ••• menu opens the panel on Routines, and Pin to top pins the Bot", async () => {
  await mountBotChat();
  const more = () => screen.getByRole("button", { name: "More for Planner" });
  fireEvent.keyDown(more(), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Routines" }));
  assert.equal(panelTab("Routines").getAttribute("aria-selected"), "true");
  fireEvent.keyDown(more(), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin to top" }));
  assert.equal(parseBotSidebarPreferences(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY), 0).pinnedBotId, "bot-1");
  fireEvent.keyDown(more(), { key: "Enter" });
  assert.ok(await screen.findByRole("menuitem", { name: "Unpin" }));
});

test("opening the panel from ••• → Files focuses the panel's tab, and closing it returns focus to the ••• button", async () => {
  await mountBotChat(FILE_HANDLERS);
  const more = screen.getByRole("button", { name: "More for Planner" });
  more.focus();
  fireEvent.keyDown(more, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  await waitFor(() => assert.equal(document.activeElement === panelTab("Files"), true));
  // Radix restores focus when the menu closes; that must not outlast the panel's own focus.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(document.activeElement === panelTab("Files"), true);
  fireEvent.click(within(botPanel()).getByRole("button", { name: /^Close/ }));
  await waitFor(() => assert.equal(document.activeElement === more, true));
});

test("Delete Bot in the chat's ••• menu asks first and deletes nothing until confirmed", async () => {
  const { calls } = await mountBotChat({ "bots:delete": () => undefined, "bots:list": () => [] });
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Bot" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.ok(within(dialog).getByText("Delete Planner?"));
  assert.equal(calls.some((call) => call.channel === "bots:delete"), false, "nothing is deleted before confirming");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete Bot" }));
  await waitFor(() => assert.equal(calls.some((call) => call.channel === "bots:delete"), true));
});

function memoryView(entries: { id: string; text: string }[]): BotMemoryView {
  const store = (list: { id: string; text: string }[], limitChars: number) => ({
    entries: list,
    usedChars: list.reduce((sum, entry) => sum + entry.text.length, 0),
    limitChars,
    overBudget: false,
  });
  return { botId: "bot-1", revision: `rev-${entries.length}`, readable: true, user: store(entries, 1_375), memory: store([], 2_200), updatedAt: 1 };
}

test("Memory in the panel edits an entry exactly as Profile → Memory does", async () => {
  const edits: unknown[] = [];
  await mountBotChat({
    "bots:memory:get": () => memoryView([{ id: "u-short", text: "Prefers short answers." }]),
    "bots:memory:edit": (input) => {
      edits.push((input as { edit: unknown }).edit);
      return { ok: true, view: memoryView([{ id: "u-short", text: "Prefers short, friendly answers." }]) };
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Memory"));
  assert.ok(await within(botPanel()).findByText("Prefers short answers."));
  fireEvent.keyDown(within(botPanel()).getByRole("button", { name: "Memory options" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit memory" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Memory" }), { target: { value: "Prefers short, friendly answers." } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    assert.deepEqual(edits, [{ kind: "replace", target: "user", entryId: "u-short", text: "Prefers short, friendly answers." }]),
  );
  assert.ok(await within(botPanel()).findByText("Prefers short, friendly answers."));
});

test("Routines in the panel lists the Bot's routines and offers Add routine", async () => {
  await mountBotChat({
    "bots:routines:list": () => [
      {
        id: "task-1",
        botId: "bot-1",
        name: "Weekly meal prep",
        prompt: "Plan this week's meals.",
        schedule: { kind: "weekly", days: [0], time: "08:41" },
        timezone: "UTC",
        label: "Every Sunday at 8:41 AM",
        enabled: true,
        updatedAt: 10,
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Routines"));
  const list = await within(botPanel()).findByRole("list", { name: "Routines" });
  assert.ok(within(list).getByText("Every Sunday at 8:41 AM"));
  fireEvent.click(within(botPanel()).getByRole("button", { name: /Add routine/u }));
  assert.ok(await screen.findByRole("dialog", { name: "Add routine" }));
});

test("Home and End in the tab strip jump to the first and last tab, and focus follows", async () => {
  await mountBotChat();
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  await waitFor(() => assert.equal(document.activeElement === panelTab("Activity"), true));
  fireEvent.keyDown(panelTab("Activity"), { key: "End" });
  await waitFor(() => assert.equal(document.activeElement === panelTab("Routines"), true));
  assert.equal(panelTab("Routines").getAttribute("aria-selected"), "true");
  fireEvent.keyDown(panelTab("Routines"), { key: "Home" });
  await waitFor(() => assert.equal(document.activeElement === panelTab("Activity"), true));
  assert.equal(panelTab("Activity").getAttribute("aria-selected"), "true");
});

test("resizing the Bot panel saves its width under its own key and leaves the workspace width alone", async () => {
  localStorage.setItem("aiden-agent.environment.width", "512");
  await mountBotChat();
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  const separator = within(botPanel()).getByRole("separator", { name: "Resize Bot panel" });
  fireEvent.keyDown(separator, { key: "End" });
  const saved = localStorage.getItem("aiden-agent.bot-panel.width");
  assert.ok(saved !== null && /^\d+$/u.test(saved), "the Bot panel's width is saved");
  assert.equal(localStorage.getItem("aiden-agent.environment.width"), "512");
});

test("Activity says when the conversation couldn't be read, and Try again reads it", async () => {
  let failing = true;
  await mountBotChat({
    "bots:live:subscribe": () => {
      if (failing) throw new Error("main was busy");
      return chatSnapshot([
        { id: "u1", type: "user", text: "Go", imageCount: 0, at: Date.now() },
        { id: "a1", type: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", kind: "reading", label: "Read 1 file" }], stopReason: "toolUse" },
        { id: "t1", type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, status: "ok" },
      ]);
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  const alert = await within(botPanel()).findByRole("alert");
  assert.equal(alert.textContent?.includes("Aiden couldn’t load Planner’s activity."), true);
  assert.equal(within(botPanel()).queryByText("No activity yet") === null, true, "a failure is not an empty log");
  failing = false;
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  assert.deepEqual(
    (await within(botPanel()).findAllByRole("listitem")).map((item) => item.textContent),
    ["Read 1 file"],
  );
});

test("the Activity log's scroller can be reached by keyboard, inside a tab panel named once", async () => {
  await mountBotChat();
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  const tabPanel = await within(botPanel()).findByRole("tabpanel", { name: "Activity" });
  const scroller = within(tabPanel).getByText("No activity yet").closest("[tabindex]") as HTMLElement | null;
  assert.equal(scroller?.tabIndex, 0, "the scroller takes a tab stop");
  assert.equal(within(botPanel()).queryByRole("region", { name: "Activity" }) === null, true, "no second landmark repeats the name");
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("coming back to Files keeps the list and the open file on screen while they are read again", async () => {
  let listCalls = 0;
  let readCalls = 0;
  let laterList = deferred<unknown>();
  let laterRead = deferred<unknown>();
  await mountBotChat({
    "bots:files:list": () => (++listCalls === 1 ? FILE_HANDLERS["bots:files:list"]() : laterList.promise),
    "bots:files:read": (botId, path) => (++readCalls === 1 ? FILE_HANDLERS["bots:files:read"](botId, path) : laterRead.promise),
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Files"));
  await within(botPanel()).findByRole("list", { name: "Files" });
  fireEvent.click(panelTab("Memory"));
  fireEvent.click(panelTab("Files"));
  await waitFor(() => assert.equal(listCalls, 2));
  assert.ok(within(botPanel()).getByRole("list", { name: "Files" }), "the list stays while it is read again");
  assert.equal(within(botPanel()).queryByRole("status", { name: "Loading files" }) === null, true);
  laterList.resolve(FILE_HANDLERS["bots:files:list"]());
  fireEvent.click(await within(botPanel()).findByRole("button", { name: "groceries.md" }));
  await within(botPanel()).findByLabelText("Contents of lists/groceries.md");
  fireEvent.click(panelTab("Activity"));
  fireEvent.click(panelTab("Files"));
  await waitFor(() => assert.equal(readCalls, 2));
  assert.equal(within(botPanel()).getByLabelText("Contents of lists/groceries.md").textContent, "eggs\nmilk");
  assert.equal(within(botPanel()).queryByRole("status", { name: "Opening file" }) === null, true, "no skeleton over the open file");
  laterRead.resolve({ path: "lists/groceries.md", content: "eggs\nmilk\nbread", size: 15, modifiedAt: 2, version: "v2" });
  await waitFor(() =>
    assert.equal(within(botPanel()).getByLabelText("Contents of lists/groceries.md").textContent, "eggs\nmilk\nbread"),
  );
  laterList = deferred();
  laterRead = deferred();
});

test("a list that fails to refresh stays on screen with the failure above it, and Try again reads only the list", async () => {
  let listCalls = 0;
  const { calls } = await mountBotChat({
    ...FILE_HANDLERS,
    "bots:files:list": () => {
      listCalls += 1;
      if (listCalls === 2) throw new Error("disk went away");
      return FILE_HANDLERS["bots:files:list"]();
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Files"));
  await within(botPanel()).findByRole("list", { name: "Files" });
  fireEvent.click(panelTab("Memory"));
  fireEvent.click(panelTab("Files"));
  const alert = await within(botPanel()).findByRole("alert");
  assert.ok(within(botPanel()).getByRole("list", { name: "Files" }), "the last good list stays");
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await waitFor(() => assert.equal(within(botPanel()).queryByRole("alert") === null, true));
  assert.equal(listCalls, 3);
  assert.equal(calls.filter((call) => call.channel === "bots:files:read").length, 0, "Try again read nothing else");
});

test("a Bot's turn ending re-reads the open Files list, so a file it just wrote shows without Refresh", async () => {
  let written = false;
  await mountBotChat({
    ...FILE_HANDLERS,
    "bots:files:list": () => {
      const list = FILE_HANDLERS["bots:files:list"]();
      return written
        ? { ...list, entries: [...list.entries, { path: "lists/todo.md", name: "todo.md", parentPath: "lists", depth: 1, kind: "file" }] }
        : list;
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Files"));
  const files = await within(botPanel()).findByRole("list", { name: "Files" });
  assert.equal(within(files).queryByText("todo.md"), null);
  written = true;
  act(() => emitBotTestNotification("bots:changed", { botId: "bot-1", session: { state: "idle" } }));
  assert.ok(await within(botPanel()).findByText("todo.md"));
});

const FILE_CHAT = [
  { id: "u1", type: "user", text: "Write my grocery list", imageCount: 0 },
  { id: "f1", type: "file", path: "lists/groceries.md", operation: "written" },
  { id: "a1", type: "assistant", text: "Done.", toolCalls: [], stopReason: "stop" },
] as BotTranscriptEntry[];

test("a chip whose file can't be read shows why, Try again reads only that file, and All files still works", async () => {
  let readCalls = 0;
  let listCalls = 0;
  await mountBotChat({
    "bots:live:subscribe": () => chatSnapshot(FILE_CHAT),
    "bots:files:list": () => {
      listCalls += 1;
      return FILE_HANDLERS["bots:files:list"]();
    },
    "bots:files:read": (botId, path) => {
      readCalls += 1;
      if (readCalls === 1) throw new Error("permission denied");
      return FILE_HANDLERS["bots:files:read"](botId, path);
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open groceries.md" }));
  const alert = await within(botPanel()).findByRole("alert");
  await waitFor(() => assert.equal(listCalls, 1));
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  assert.equal((await within(botPanel()).findByLabelText("Contents of lists/groceries.md")).textContent, "eggs\nmilk");
  assert.equal(readCalls, 2);
  assert.equal(listCalls, 1, "the list was not read again");
  fireEvent.click(within(botPanel()).getByRole("button", { name: "All files" }));
  assert.ok(await within(botPanel()).findByRole("list", { name: "Files" }));
});

test("a chip clicked while the panel is open on Memory switches it to Files on that file", async () => {
  await mountBotChat({
    ...FILE_HANDLERS,
    "bots:live:subscribe": () => chatSnapshot(FILE_CHAT),
    "bots:memory:get": () => memoryView([]),
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Memory"));
  assert.equal(panelTab("Memory").getAttribute("aria-selected"), "true");
  fireEvent.click(await screen.findByRole("button", { name: "Open groceries.md" }));
  assert.equal(panelTab("Files").getAttribute("aria-selected"), "true");
  assert.equal((await within(botPanel()).findByLabelText("Contents of lists/groceries.md")).textContent, "eggs\nmilk");
});

test("a live event re-renders the Activity tab and leaves the Files tab alone", async () => {
  const activityRenders = countRenders(BotPanelActivity);
  const filesRenders = countRenders(BotPanelFiles);
  await mountBotChat(FILE_HANDLERS);
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Files"));
  await within(botPanel()).findByRole("list", { name: "Files" });
  fireEvent.click(panelTab("Activity"));
  await within(botPanel()).findByText("No activity yet");
  const filesBefore = filesRenders();
  const activityBefore = activityRenders();
  for (let seq = 1; seq <= 3; seq += 1) {
    act(() =>
      emitBotTestNotification("bots:live:event", {
        botId: "bot-1",
        epoch: "e1",
        seq,
        type: "entry",
        entry: { id: `u${seq}`, type: "user", text: `Message ${seq}`, imageCount: 0 },
      }),
    );
  }
  await waitFor(() => assert.ok(activityRenders() >= activityBefore + 3, "the probe sees Activity re-render"));
  assert.equal(filesRenders(), filesBefore, "Files did not re-render");
});

test("a streamed token leaves a mounted Activity log alone; a new step redraws it", async () => {
  const activityRenders = countRenders(BotPanelActivity);
  await mountBotChat();
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  await within(botPanel()).findByText("No activity yet");
  const before = activityRenders();
  for (let seq = 1; seq <= 3; seq += 1) {
    act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "e1", seq, type: "partial", text: "Here".repeat(seq) }));
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(activityRenders(), before, "tokens don't redraw the log");
  act(() =>
    emitBotTestNotification("bots:live:event", {
      botId: "bot-1",
      epoch: "e1",
      seq: 4,
      type: "entry",
      entry: { id: "u1", type: "user", text: "Plan dinners", imageCount: 0 },
    }),
  );
  await waitFor(() => assert.ok(activityRenders() > before, "an entry does"));
});

test("another Bot's pin or visit leaves the open chat alone; its own pin redraws it", async () => {
  const chatRenders = countRenders(BotChatPane);
  await mountBotChat();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const before = chatRenders();
  act(() => botSidebarPreferenceActions.togglePin("bot-9"));
  act(() => botSidebarPreferenceActions.markViewed("bot-9", 5));
  assert.equal(chatRenders(), before, "the transcript is not redrawn for another Bot");
  act(() => botSidebarPreferenceActions.togglePin("bot-1"));
  assert.ok(chatRenders() > before, "its own pin is shown in its menu");
});

test("coming back to a Bot shows its last view at once, marked stale, until the fresh snapshot lands", async () => {
  let answer: (snapshot: BotLiveSnapshot) => void = () => undefined;
  let opens = 0;
  installBotTestIpc({
    "bots:live:subscribe": () => {
      opens += 1;
      if (opens === 1) return liveSnapshot("bot-1", "Welcome back");
      return new Promise<BotLiveSnapshot>((resolve) => (answer = resolve));
    },
    "bots:live:unsubscribe": () => undefined,
  });
  function StaleProbe() {
    const live = useBotLive("bot-1");
    return <p aria-label="Reopened">{live.snapshot ? `${live.snapshot.entries.length} entries ${live.stale ? "stale" : "fresh"}` : "loading"}</p>;
  }
  const first = render(<StaleProbe />);
  await waitFor(() => assert.equal(screen.getByLabelText("Reopened").textContent, "1 entries fresh"));
  first.unmount();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  render(<StaleProbe />);
  assert.equal(screen.getByLabelText("Reopened").textContent, "1 entries stale", "the remembered view shows on the first render");
  await waitFor(() => assert.equal(opens, 2));
  act(() => answer({ ...liveSnapshot("bot-1", "Welcome back"), entries: [...liveSnapshot("bot-1", "Welcome back").entries, { id: "a2", type: "assistant", text: "New", toolCalls: [], stopReason: "stop" }] }));
  await waitFor(() => assert.equal(screen.getByLabelText("Reopened").textContent, "2 entries fresh"));
});

test("reload keeps the conversation on screen, marked stale, instead of blanking it", async () => {
  let answer: (snapshot: BotLiveSnapshot) => void = () => undefined;
  let opens = 0;
  installBotTestIpc({
    "bots:live:subscribe": () => {
      opens += 1;
      if (opens === 1) return liveSnapshot("bot-1", "Hello");
      return new Promise<BotLiveSnapshot>((resolve) => (answer = resolve));
    },
    "bots:live:unsubscribe": () => undefined,
  });
  function ReloadProbe() {
    const live = useBotLive("bot-1");
    return (
      <>
        <p aria-label="View">{live.snapshot ? `${live.snapshot.entries.length} entries ${live.stale ? "stale" : "fresh"} ${live.failed ? "failed" : "ok"}` : "loading"}</p>
        <button type="button" onClick={live.reload}>
          Reload
        </button>
      </>
    );
  }
  render(<ReloadProbe />);
  await waitFor(() => assert.equal(screen.getByLabelText("View").textContent, "1 entries fresh ok"));
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  assert.equal(screen.getByLabelText("View").textContent, "1 entries stale ok");
  await waitFor(() => assert.equal(opens, 2));
  act(() => answer(liveSnapshot("bot-1", "Hello again")));
  await waitFor(() => assert.equal(screen.getByLabelText("View").textContent, "1 entries fresh ok"));
});
