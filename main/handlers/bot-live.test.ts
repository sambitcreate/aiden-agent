import assert from "node:assert/strict";
import test from "node:test";
import type { BotLiveEvent, BotLiveSnapshot } from "../../renderer/shared/bot-live.js";
import type { BotLiveProjection, BotLiveSink } from "../services/bot-runtime/live-projection.js";
import { registerBotLiveHandlers, type BotLiveOwner } from "./bot-live.js";

class FakeDocument implements BotLiveOwner {
  readonly received: Array<{ channel: string; event: BotLiveEvent }> = [];
  private listeners = new Set<() => void>();
  private destroyed = false;
  /** Whether this document's window is focused with the person at the Mac. */
  focused = false;
  constructor(readonly key: string) {}
  inFront = () => this.focused;
  isDestroyed = () => this.destroyed;
  onInvalidated = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  send = (channel: "bots:live:event", event: BotLiveEvent) => {
    this.received.push({ channel, event });
  };
  reload() {
    this.destroyed = true;
    for (const listener of [...this.listeners]) listener();
  }
}

/** A projection that hands out snapshots and lets the test push events to live sinks. */
function fakeProjection() {
  const sinks = new Map<number, { botId: string; sink: BotLiveSink }>();
  let next = 0;
  const projection: BotLiveProjection = {
    async subscribe(botId, sink) {
      const id = (next += 1);
      sinks.set(id, { botId, sink });
      const snapshot: BotLiveSnapshot = {
        botId,
        epoch: "e1",
        seq: id,
        entries: [],
        partial: null,
        state: { kind: "idle" },
        question: null,
        activity: null,
        queued: [],
      };
      return { snapshot, unsubscribe: () => sinks.delete(id) };
    },
    notifyState: () => undefined,
    refresh: async () => undefined,
    refreshQuestion: async () => undefined,
    refreshHandoff: async () => undefined,
    refreshAccessRequest: async () => undefined,
    refreshPlan: async () => undefined,
    notifyStopping: () => undefined,
    notifyResuming: () => undefined,
    cancelStopping: () => undefined,
    refreshActivity: async () => undefined,
    needsYou: async () => true,
    inboxSignals: async () => ({ state: { kind: "idle" }, needsYou: true, lastReplyAt: null }),
    summary: async (botId) => ({
      botId,
      preview: "hi",
      updatedAt: 1,
      state: { kind: "idle" },
      needsYou: true,
      lastReplyAt: 1,
    }),
    close: async () => undefined,
  };
  return {
    projection,
    push(botId: string, seq: number) {
      for (const { botId: id, sink } of sinks.values()) {
        if (id === botId) sink.send({ botId, epoch: "e1", seq, type: "partial", text: `t${seq}` });
      }
    },
    live: () => sinks.size,
  };
}

function register(projection: BotLiveProjection) {
  return registerWithProbe(projection).invoke;
}

function registerWithProbe(projection: BotLiveProjection) {
  const handlers = new Map<string, (event: FakeDocument, ...args: unknown[]) => unknown>();
  const live = registerBotLiveHandlers<FakeDocument>({
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: (event) => event,
    projection: () => projection,
    parseBotId: (value) => {
      if (typeof value !== "string" || !value) throw new Error("Invalid bot id.");
      return value;
    },
  });
  return {
    live,
    invoke: (channel: string, document: FakeDocument, ...args: unknown[]) => handlers.get(channel)!(document, ...args),
  };
}

test("a document gets its snapshot, then only its own Bot's events", async () => {
  const fake = fakeProjection();
  const invoke = register(fake.projection);
  const mac = new FakeDocument("window-1");
  const snapshot = (await invoke("bots:live:subscribe", mac, "bot:a")) as BotLiveSnapshot;
  assert.equal(snapshot.botId, "bot:a");
  fake.push("bot:a", 2);
  fake.push("bot:b", 3);
  assert.deepEqual(
    mac.received.map(({ channel, event }) => [channel, event.botId, event.seq]),
    [["bots:live:event", "bot:a", 2]],
  );
});

test("subscribing again replaces the document's earlier subscription", async () => {
  const fake = fakeProjection();
  const invoke = register(fake.projection);
  const mac = new FakeDocument("window-1");
  await invoke("bots:live:subscribe", mac, "bot:a");
  await invoke("bots:live:subscribe", mac, "bot:a");
  assert.equal(fake.live(), 1);
  fake.push("bot:a", 5);
  assert.equal(mac.received.length, 1);
});

test("unsubscribe and a reload both end the document's subscriptions", async () => {
  const fake = fakeProjection();
  const invoke = register(fake.projection);
  const first = new FakeDocument("window-1");
  const second = new FakeDocument("window-2");
  await invoke("bots:live:subscribe", first, "bot:a");
  await invoke("bots:live:subscribe", first, "bot:b");
  await invoke("bots:live:subscribe", second, "bot:a");
  await invoke("bots:live:unsubscribe", first, "bot:b");
  assert.equal(fake.live(), 2);
  first.reload();
  assert.equal(fake.live(), 1);
  fake.push("bot:a", 9);
  assert.equal(first.received.length, 0);
  assert.equal(second.received.length, 1);
  await assert.rejects(invoke("bots:live:subscribe", first, "bot:a") as Promise<unknown>, /document changed/u);
});

test("the list summary comes from the projection", async () => {
  const fake = fakeProjection();
  const invoke = register(fake.projection);
  assert.deepEqual(await invoke("bots:live:summary", new FakeDocument("w"), "bot:a"), {
    botId: "bot:a",
    preview: "hi",
    updatedAt: 1,
    state: { kind: "idle" },
    needsYou: true,
    lastReplyAt: 1,
  });
});

/** A projection whose subscribes finish only when the test releases them, in any order. */
function gatedProjection() {
  const fake = fakeProjection();
  const gates: Array<() => void> = [];
  const projection: BotLiveProjection = {
    ...fake.projection,
    async subscribe(botId, sink) {
      await new Promise<void>((resolve) => gates.push(resolve));
      return fake.projection.subscribe(botId, sink);
    },
  };
  return { ...fake, projection, release: (index: number) => gates[index]!() };
}

test("leaving a Bot chat while its subscribe is still opening leaves no live subscription", async () => {
  const gated = gatedProjection();
  const invoke = register(gated.projection);
  const mac = new FakeDocument("window-1");
  const opening = invoke("bots:live:subscribe", mac, "bot:a") as Promise<BotLiveSnapshot>;
  await invoke("bots:live:unsubscribe", mac, "bot:a");
  gated.release(0);
  await opening;
  assert.equal(gated.live(), 0, "the late subscription released itself");
  gated.push("bot:a", 4);
  assert.equal(mac.received.length, 0);
});

test("when an older subscribe finishes after a newer one, the newer subscription is kept", async () => {
  const gated = gatedProjection();
  const invoke = register(gated.projection);
  const mac = new FakeDocument("window-1");
  const older = invoke("bots:live:subscribe", mac, "bot:a") as Promise<BotLiveSnapshot>;
  const newer = invoke("bots:live:subscribe", mac, "bot:a") as Promise<BotLiveSnapshot>;
  gated.release(1);
  await newer;
  gated.release(0);
  await older;
  assert.equal(gated.live(), 1);
  gated.push("bot:a", 6);
  assert.equal(mac.received.length, 1, "events arrive once, through the newer subscription");
  await invoke("bots:live:unsubscribe", mac, "bot:a");
  assert.equal(gated.live(), 0);
});

test("two windows on one Bot each get the events, and one leaving keeps the other", async () => {
  const fake = fakeProjection();
  const invoke = register(fake.projection);
  const first = new FakeDocument("window-1");
  const second = new FakeDocument("window-2");
  await invoke("bots:live:subscribe", first, "bot:a");
  await invoke("bots:live:subscribe", second, "bot:a");
  fake.push("bot:a", 2);
  await invoke("bots:live:unsubscribe", first, "bot:a");
  fake.push("bot:a", 3);
  assert.deepEqual(first.received.map(({ event }) => event.seq), [2]);
  assert.deepEqual(second.received.map(({ event }) => event.seq), [2, 3]);
});

test("a Bot's chat is in front only while a focused document is subscribed to that Bot", async () => {
  const fake = fakeProjection();
  const { live, invoke } = registerWithProbe(fake.projection);
  const front = new FakeDocument("window-1");
  const behind = new FakeDocument("window-2");
  await invoke("bots:live:subscribe", front, "bot:a");
  await invoke("bots:live:subscribe", behind, "bot:b");
  assert.equal(live.shownInFront("bot:a"), false, "open but not focused");

  front.focused = true;
  assert.equal(live.shownInFront("bot:a"), true);
  assert.equal(live.shownInFront("bot:b"), false, "another Bot open in a window behind it");
  assert.equal(live.shownInFront("bot:c"), false, "a Bot nobody has open");

  await invoke("bots:live:unsubscribe", front, "bot:a");
  assert.equal(live.shownInFront("bot:a"), false, "the person left the chat");

  await invoke("bots:live:subscribe", front, "bot:a");
  front.reload();
  assert.equal(live.shownInFront("bot:a"), false, "a reloaded document no longer shows it");
});
