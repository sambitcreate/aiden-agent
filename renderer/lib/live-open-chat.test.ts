import assert from "node:assert/strict";
import test from "node:test";
import { LiveOpenChatStore, type LiveOpenChatSnapshot } from "./live-open-chat";

const chat = (chatId: string, overrides: Partial<LiveOpenChatSnapshot> = {}): LiveOpenChatSnapshot => ({
  chatId,
  title: `Chat ${chatId}`,
  workspaceId: null,
  busy: false,
  streamId: null,
  ...overrides,
});

test("the newest pane is the open chat, and closing it falls back to the pane still mounted", () => {
  const store = new LiveOpenChatStore();
  const older = Symbol("older");
  const newer = Symbol("newer");
  store.publish(older, chat("a"));
  store.publish(newer, chat("b"));
  assert.equal(store.get()?.chatId, "b");

  // The older pane keeps updating behind the newer one without taking over.
  store.publish(older, chat("a", { busy: true }));
  assert.equal(store.get()?.chatId, "b");

  store.clear(newer);
  assert.deepEqual(store.get(), chat("a", { busy: true }), "the older pane's latest state shows");
  store.clear(older);
  assert.equal(store.get(), null);
});

test("listeners hear a change only when the open chat really changes", () => {
  const store = new LiveOpenChatStore();
  let changes = 0;
  store.subscribe(() => (changes += 1));
  const pane = Symbol("pane");
  store.publish(pane, chat("a"));
  store.publish(pane, chat("a"));
  assert.equal(changes, 1);
  store.publish(pane, chat("a", { title: "Renamed" }));
  assert.equal(changes, 2);
  store.clear(Symbol("never mounted"));
  assert.equal(changes, 2);
  store.clear(pane);
  assert.equal(changes, 3);
});
