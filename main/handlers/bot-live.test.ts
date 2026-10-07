import assert from "node:assert/strict";
import test from "node:test";
import type { BotLiveEvent, BotLiveSnapshot } from "../../renderer/shared/bot-live.js";
import type { BotLiveProjection, BotLiveSink } from "../services/bot-runtime/live-projection.js";
import { registerBotLiveHandlers, type BotLiveOwner } from "./bot-live.js";

class FakeDocument implements BotLiveOwner {
  readonly received: Array<{ channel: string; event: BotLiveEvent }> = [];
  private listeners = new Set<() => void>();
  private destroyed = false;
  constructor(readonly key: string) {}
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
      const snapshot: BotLiveSnapshot = { botId, epoch: "e1", seq: id, entries: [], partial: null, state: { kind: "idle" } };
      return { snapshot, unsubscribe: () => sinks.delete(id) };
    },
    notifyState: () => undefined,
    refresh: async () => undefined,
    summary: async (botId) => ({ botId, preview: "hi", updatedAt: 1, state: { kind: "idle" } }),
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
  const handlers = new Map<string, (event: FakeDocument, ...args: unknown[]) => unknown>();
  registerBotLiveHandlers<FakeDocument>({
    handle: (channel, handler) => handlers.set(channel, handler),
    owner: (event) => event,
    projection: () => projection,
    parseBotId: (value) => {
      if (typeof value !== "string" || !value) throw new Error("Invalid bot id.");
      return value;
    },
  });
  return (channel: string, document: FakeDocument, ...args: unknown[]) => handlers.get(channel)!(document, ...args);
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
  });
});
