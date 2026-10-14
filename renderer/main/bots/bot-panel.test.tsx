import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotLiveSnapshot } from "../../shared/bot-live";
import { BotLiveProvider, useBotLive, useSharedBotLive } from "../../lib/use-bot-live";
import { BOT_PANEL_OPEN_KEY, BOT_PANEL_TAB_KEY, BotPanelProvider, useBotPanel } from "./bot-panel-context";

beforeEach(() => {
  installBotTestIpc();
  localStorage.clear();
});
afterEach(cleanup);

function PanelProbe() {
  const panel = useBotPanel();
  const request = panel.fileRequest ? `${panel.fileRequest.path}#${panel.fileRequest.key}` : "none";
  return (
    <>
      <output aria-label="Panel">{`${panel.open ? "open" : "closed"} ${panel.tab} ${request}`}</output>
      <button type="button" onClick={() => panel.show("files", { path: "lists/groceries.md" })}>
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
  assert.match(first, /^open files lists\/groceries\.md#\d+$/u);
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
  localStorage.setItem(BOT_PANEL_TAB_KEY, "browser");
  localStorage.setItem(BOT_PANEL_OPEN_KEY, "yes");
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "closed activity none");
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
  const live = useSharedBotLive("bot-1");
  return <p aria-label={label}>{live.snapshot ? `${live.snapshot.entries.length} entries` : "loading"}</p>;
}

function SharedLive({ second }: { second: boolean }) {
  return (
    <BotLiveProvider botId="bot-1">
      <LiveProbe label="Chat view" />
      {second ? <LiveProbe label="Activity view" /> : null}
    </BotLiveProvider>
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
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "e1",
    seq: 1,
    type: "entry",
    entry: { id: "u1", type: "user", text: "Plan dinners", imageCount: 0 },
  });
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
  assert.equal(liveCalls(calls, "unsubscribe"), 1);
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
  const view = render(<SwitchProbe botId="bot-1" />);
  await waitFor(() => assert.equal(screen.getByLabelText("Switched").textContent, "bot-1:bot-1-u0"));
  view.rerender(<SwitchProbe botId="bot-2" />);
  assert.equal(screen.getByLabelText("Switched").textContent, "loading", "not the old Bot's view, not even for one render");
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "e1",
    seq: 1,
    type: "entry",
    entry: { id: "late", type: "user", text: "too late", imageCount: 0 },
  });
  assert.equal(screen.getByLabelText("Switched").textContent, "loading");
  answerSecond(liveSnapshot("bot-2", "second Bot's message"));
  await waitFor(() => assert.equal(screen.getByLabelText("Switched").textContent, "bot-2:bot-2-u0"));
  assert.deepEqual(
    calls.filter((call) => call.channel.startsWith("bots:live:")).map((call) => `${call.channel}:${String(call.args[0])}`),
    ["bots:live:subscribe:bot-1", "bots:live:unsubscribe:bot-1", "bots:live:subscribe:bot-2"],
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
