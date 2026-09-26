import assert from "node:assert/strict";
import test from "node:test";
import type { ChatContextPressureV1 } from "../shared/context-pressure";
import { ContextPressureFeed } from "./context-pressure-feed";

function reading(contextTokens: number): ChatContextPressureV1 {
  return { contextTokens } as ChatContextPressureV1;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const published: (number | null)[] = [];
  const requests: {
    chatId: string;
    draft?: string;
    reply: ReturnType<typeof deferred<ChatContextPressureV1 | null>>;
  }[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const feed = new ContextPressureFeed<string>({
    fetch: (chatId, draft) => {
      const reply = deferred<ChatContextPressureV1 | null>();
      requests.push({ chatId, draft, reply });
      return reply.promise;
    },
    publish: (pressure) => published.push(pressure?.contextTokens ?? null),
    schedule: (run) => {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    },
    cancel: (id) => timers.delete(id as number),
  });
  const fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const run of pending) run();
  };
  return { feed, published, requests, timers, fireTimers };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("switching chats clears the old reading and drops its in-flight response", async () => {
  const h = harness();
  h.feed.showChat("a");
  void h.feed.refresh();
  h.feed.showChat("b");
  assert.deepEqual(h.published, [null, null]);
  h.requests[0].reply.resolve(reading(900));
  await settle();
  assert.deepEqual(
    h.published,
    [null, null],
    "chat a's reading must not paint chat b",
  );
  void h.feed.refresh();
  assert.equal(h.requests[1].chatId, "b");
  h.requests[1].reply.resolve(reading(100));
  await settle();
  assert.deepEqual(h.published, [null, null, 100]);
});

test("switching chats cancels a pending draft refresh from the previous chat", async () => {
  const h = harness();
  h.feed.showChat("a");
  h.feed.draftChanged("long draft for a");
  h.feed.showChat("b");
  assert.equal(h.timers.size, 0);
  h.fireTimers();
  assert.equal(h.requests.length, 0);
});

test("pushes for another chat never reach the meter", () => {
  const h = harness();
  h.feed.showChat("b");
  h.feed.setLive(true);
  h.feed.pushed("a", reading(5));
  h.feed.pushed("b", reading(7));
  assert.deepEqual(h.published, [null, 7]);
});

test("a live generation cancels the post-send draft refresh and ignores ambient reads", async () => {
  const h = harness();
  h.feed.showChat("a");
  // Typing arms a refresh; ambient read is in flight when the user sends.
  void h.feed.refresh();
  h.feed.draftChanged("");
  h.feed.setLive(true);
  assert.equal(
    h.timers.size,
    0,
    "the draft reset refresh must not fire mid-turn",
  );
  h.requests[0].reply.resolve(reading(10));
  await settle();
  // Live stream readings still land.
  h.feed.pushed("a", reading(50));
  // Ambient triggers during the turn (e.g. chat.updatedAt) are skipped.
  await h.feed.refresh();
  h.feed.draftChanged("typing while it runs");
  h.fireTimers();
  await settle();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.published, [null, 50]);
  // Once the turn settles, ambient reads resume.
  h.feed.setLive(false);
  void h.feed.refresh();
  h.requests[1].reply.resolve(reading(60));
  await settle();
  assert.deepEqual(h.published, [null, 50, 60]);
});

test("only the newest ambient request publishes and failures keep the last reading", async () => {
  const h = harness();
  h.feed.showChat("a");
  void h.feed.refresh();
  h.feed.draftChanged("draft");
  h.fireTimers();
  assert.equal(h.requests[1].draft, "draft");
  h.requests[1].reply.resolve(reading(2));
  h.requests[0].reply.resolve(reading(1));
  await settle();
  assert.deepEqual(h.published, [null, 2]);
  const failing = new ContextPressureFeed<string>({
    fetch: async () => {
      throw new Error("offline");
    },
    publish: (pressure) => h.published.push(pressure?.contextTokens ?? null),
  });
  failing.showChat("a");
  await failing.refresh();
  assert.deepEqual(h.published, [null, 2, null]);
});

test("an unsaved draft chat never requests a projection", async () => {
  const h = harness();
  h.feed.showChat(null);
  await h.feed.refresh();
  assert.equal(h.requests.length, 0);
});

test("ambient refreshes keep pricing the composer draft until it is cleared", async () => {
  const h = harness();
  h.feed.showChat("a");
  h.feed.draftChanged("half-written question");
  h.fireTimers();
  // A model switch or turn settle refreshes without a new draft event.
  void h.feed.refresh();
  assert.deepEqual(
    h.requests.map((request) => request.draft),
    ["half-written question", "half-written question"],
  );
  // Sending clears the composer; later refreshes price no draft.
  h.feed.draftChanged(undefined);
  h.fireTimers();
  void h.feed.refresh();
  assert.equal(h.requests[2].draft, undefined);
  assert.equal(h.requests[3].draft, undefined);
  // A chat switch never carries the previous chat's draft.
  h.feed.draftChanged("for chat a only");
  h.feed.showChat("b");
  void h.feed.refresh();
  assert.equal(h.requests[4].chatId, "b");
  assert.equal(h.requests[4].draft, undefined);
});

test("a push outside a live turn re-reads with the live selection instead of painting", async () => {
  const h = harness();
  h.feed.showChat("a");
  h.feed.draftChanged("draft");
  h.fireTimers();
  h.requests[0].reply.resolve(reading(10));
  await settle();
  // Manual compaction: main prices the persisted model with no draft.
  h.feed.pushed("a", reading(999));
  assert.deepEqual(
    h.published,
    [null, 10],
    "the persisted-model reading never paints",
  );
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].draft, "draft");
  h.requests[1].reply.resolve(reading(4));
  await settle();
  assert.deepEqual(h.published, [null, 10, 4]);
  h.feed.pushed("b", reading(1));
  assert.equal(
    h.requests.length,
    2,
    "another chat's push never triggers a read",
  );
});

test("a workspace scope change clears the old reading even if the re-read fails", async () => {
  const h = harness();
  h.feed.showChat("a");
  h.feed.setScope("ask:/repo");
  void h.feed.refresh();
  h.requests[0].reply.resolve(reading(70));
  await settle();
  assert.deepEqual(h.published, [null, 70]);
  // Same scope (a re-render) keeps the reading.
  h.feed.setScope("ask:/repo");
  assert.deepEqual(h.published, [null, 70]);
  // An in-flight read for the old scope must not repaint after the change.
  void h.feed.refresh();
  h.feed.setScope("full:/repo");
  assert.deepEqual(h.published, [null, 70, null]);
  h.requests[1].reply.resolve(reading(71));
  await settle();
  assert.deepEqual(h.published, [null, 70, null]);
  // The replacement read fails: the meter stays cleared, not at 70%.
  void h.feed.refresh();
  h.requests[2].reply.resolve(Promise.reject(new Error("offline")) as never);
  await settle();
  assert.deepEqual(h.published, [null, 70, null]);
  // Switching to another chat in a different workspace just repeats the clear.
  h.feed.showChat("b");
  h.feed.setScope("ask:/other");
  assert.deepEqual(h.published, [null, 70, null, null, null]);
});

test("a scope change still clears after switching between chats in the same workspace", async () => {
  const h = harness();
  h.feed.showChat("a");
  h.feed.setScope("ask:/repo");
  // ChatPane only re-reports the scope when it changes, so switching to a
  // sibling chat (or a draft chat saving its first message) sends no setScope.
  h.feed.showChat(null);
  h.feed.showChat("b");
  void h.feed.refresh();
  h.requests[0].reply.resolve(reading(80));
  await settle();
  assert.deepEqual(h.published, [null, null, null, 80]);
  h.feed.setScope("full:/repo");
  assert.deepEqual(
    h.published,
    [null, null, null, 80, null],
    "the first permission change after the switch must clear chat b's reading",
  );
});
