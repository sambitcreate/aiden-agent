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
  void h.feed.refresh("draft");
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
