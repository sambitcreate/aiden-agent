import assert from "node:assert/strict";
import test from "node:test";
import { guardBotBubbleOverlayHandlers, type BotBubbleOverlayAccess } from "./bot-bubbles-overlay-access.js";

type FakeEvent = { from: "overlay" | "main" };
const overlay: FakeEvent = { from: "overlay" };
const main: FakeEvent = { from: "main" };

function harness() {
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  const calls: string[] = [];
  const access: BotBubbleOverlayAccess<FakeEvent> = {
    isOverlayEvent: (event) => event.from === "overlay",
    bubbledBotIds: () => new Set(["bot-in"]),
    approvalBotId: (waitId) => ({ "wait-in": "bot-in", "wait-out": "bot-out" })[waitId] ?? null,
  };
  const handle = guardBotBubbleOverlayHandlers<FakeEvent>((channel, handler) => handlers.set(channel, handler), access);
  for (const channel of [
    "bots:send",
    "bots:stop",
    "bots:live:subscribe",
    "bots:approve",
    "bots:answerQuestion",
    "bots:bubbles:open",
    "bots:bubbles:bringBack",
    "bots:delete",
    "bots:live:unsubscribe",
    "bots:bubbles:forgetRecent",
  ]) {
    handle(channel, (_event, ...args) => {
      calls.push(`${channel} ${JSON.stringify(args)}`);
      return "ok";
    });
  }
  handle("bots:list", async () => [{ id: "bot-in" }, { id: "bot-out" }]);
  const invoke = (channel: string, event: FakeEvent, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!(event, ...args));
  return { invoke, calls };
}

test("an overlay may act on a bubbled Bot", async () => {
  const { invoke, calls } = harness();
  assert.equal(await invoke("bots:send", overlay, { botId: "bot-in", text: "hi" }), "ok");
  assert.equal(await invoke("bots:stop", overlay, "bot-in"), "ok");
  assert.equal(await invoke("bots:live:subscribe", overlay, "bot-in"), "ok");
  assert.equal(await invoke("bots:approve", overlay, { waitId: "wait-in", decision: "allow" }), "ok");
  assert.equal(await invoke("bots:bubbles:open", overlay, { botId: null }), "ok", "tucking the chat away names no Bot");
  // A conditional tuck may arrive after its head was closed elsewhere; it can only ever tuck, so it still passes.
  assert.equal(await invoke("bots:bubbles:open", overlay, { botId: null, ifOpen: "bot-in" }), "ok");
  assert.equal(await invoke("bots:bubbles:open", overlay, { botId: null, ifOpen: "bot-out" }), "ok");
  assert.equal(calls.length, 7);
});

test("an approval nobody waits on any more reaches the handler, which decides nothing", async () => {
  const { invoke, calls } = harness();
  assert.equal(await invoke("bots:approve", overlay, { waitId: "nothing-waits", decision: "allow" }), "ok");
  assert.deepEqual(calls, ['bots:approve [{"waitId":"nothing-waits","decision":"allow"}]']);
});

test("an overlay can't reach a Bot that isn't bubbled", async () => {
  const { invoke, calls } = harness();
  const refused: Array<[string, unknown]> = [
    ["bots:send", { botId: "bot-out", text: "hi" }],
    ["bots:stop", "bot-out"],
    ["bots:live:subscribe", "bot-out"],
    ["bots:answerQuestion", { botId: "bot-out", waitId: "w", answer: {} }],
    ["bots:approve", { waitId: "wait-out", decision: "allow" }],
    ["bots:bubbles:open", { botId: "bot-out" }],
    ["bots:bubbles:open", { botId: "bot-out", ifOpen: "bot-in" }],
    ["bots:bubbles:bringBack", { botId: "bot-out" }],
    ["bots:send", "not an object"],
  ];
  for (const [channel, payload] of refused) {
    await assert.rejects(invoke(channel, overlay, payload), /only on its own Bots/, `${channel} ${JSON.stringify(payload)}`);
  }
  assert.deepEqual(calls, []);
});

test("an overlay can let go of a closed head's live feed but can't use channels meant for the main window", async () => {
  const { invoke, calls } = harness();
  assert.equal(await invoke("bots:live:unsubscribe", overlay, "bot-out"), "ok", "a head that just closed still unsubscribes");
  await assert.rejects(invoke("bots:delete", overlay, "bot-in"), /can't do that/);
  await assert.rejects(invoke("bots:bubbles:forgetRecent", overlay, { botId: "bot-out" }), /can't do that/);
  assert.deepEqual(calls, ['bots:live:unsubscribe ["bot-out"]']);
});

test("the main window is unaffected and other channels pass through", async () => {
  const { invoke, calls } = harness();
  assert.equal(await invoke("bots:send", main, { botId: "bot-out", text: "hi" }), "ok");
  assert.equal(await invoke("bots:approve", main, { waitId: "wait-out", decision: "deny" }), "ok");
  assert.equal(await invoke("bots:delete", main, "bot-out"), "ok");
  assert.equal(calls.length, 3);
});

test("an overlay's Bot list holds only bubbled Bots", async () => {
  const { invoke } = harness();
  assert.deepEqual(await invoke("bots:list", overlay), [{ id: "bot-in" }]);
  assert.deepEqual(await invoke("bots:list", main), [{ id: "bot-in" }, { id: "bot-out" }]);
});
