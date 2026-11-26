import assert from "node:assert/strict";
import test from "node:test";
import { guardBotBubbleOverlayHandlers, type BotBubbleOverlayAccess } from "./bot-bubbles-overlay-access.js";

type FakeEvent = { from: "overlay" | "main"; display?: "left" | "right"; trusted?: boolean };
// The overlay on the right-hand display draws bot-in; bot-elsewhere's head is on the left one.
const overlay: FakeEvent = { from: "overlay", display: "right", trusted: true };
const leftOverlay: FakeEvent = { from: "overlay", display: "left", trusted: true };
// A subframe, or a page the overlay window navigated to: not the bubble page itself.
const untrustedOverlay: FakeEvent = { from: "overlay", display: "right", trusted: false };
const main: FakeEvent = { from: "main" };

function harness() {
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  const calls: string[] = [];
  const access: BotBubbleOverlayAccess<FakeEvent> = {
    isOverlayEvent: (event) => event.from === "overlay",
    isTrustedOverlayEvent: (event) => event.from === "overlay" && event.trusted === true,
    bubbledBotIds: (event) => new Set(event.display === "left" ? ["bot-elsewhere"] : ["bot-in"]),
    approvalBotId: (waitId) => ({ "wait-in": "bot-in", "wait-out": "bot-out", "wait-elsewhere": "bot-elsewhere" })[waitId] ?? null,
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
    "bots:bubbles:state",
  ]) {
    handle(channel, (_event, ...args) => {
      calls.push(`${channel} ${JSON.stringify(args)}`);
      return "ok";
    });
  }
  handle("bots:list", async () => [{ id: "bot-in" }, { id: "bot-out" }, { id: "bot-elsewhere" }]);
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
  assert.deepEqual(await invoke("bots:list", main), [{ id: "bot-in" }, { id: "bot-out" }, { id: "bot-elsewhere" }]);
});

test("an overlay reaches only the heads on its own display", async () => {
  const { invoke, calls } = harness();
  await assert.rejects(invoke("bots:send", overlay, { botId: "bot-elsewhere", text: "hi" }), /only on its own Bots/);
  await assert.rejects(invoke("bots:live:subscribe", overlay, "bot-elsewhere"), /only on its own Bots/);
  await assert.rejects(invoke("bots:approve", overlay, { waitId: "wait-elsewhere", decision: "allow" }), /only on its own Bots/);
  assert.deepEqual(await invoke("bots:list", overlay), [{ id: "bot-in" }]);
  assert.equal(await invoke("bots:send", leftOverlay, { botId: "bot-elsewhere", text: "hi" }), "ok");
  assert.deepEqual(await invoke("bots:list", leftOverlay), [{ id: "bot-elsewhere" }]);
  assert.deepEqual(calls, ['bots:send [{"botId":"bot-elsewhere","text":"hi"}]']);
});

test("a document in an overlay window that isn't the bubble page can't read or act on any Bot", async () => {
  const { invoke, calls } = harness();
  await assert.rejects(invoke("bots:send", untrustedOverlay, { botId: "bot-in", text: "hi" }), /Invalid Bot bubble sender/);
  await assert.rejects(invoke("bots:live:subscribe", untrustedOverlay, "bot-in"), /Invalid Bot bubble sender/);
  await assert.rejects(invoke("bots:approve", untrustedOverlay, { waitId: "wait-in", decision: "allow" }), /Invalid Bot bubble sender/);
  await assert.rejects(invoke("bots:list", untrustedOverlay), /Invalid Bot bubble sender/);
  await assert.rejects(invoke("bots:bubbles:state", untrustedOverlay), /Invalid Bot bubble sender/);
  assert.equal(await invoke("bots:live:unsubscribe", untrustedOverlay, "bot-in"), "ok", "letting go of a feed stays safe");
  assert.deepEqual(calls, ['bots:live:unsubscribe ["bot-in"]']);
});
