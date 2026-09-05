import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatMessageQueue,
  chatMessageQueue,
  deliverQueuedMessage,
  type QueuedChatMessage,
} from "./chat-message-queue";

function message(id: string): QueuedChatMessage {
  return { id, text: `message ${id}`, attachments: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function delivery(queue: ChatMessageQueue) {
  const sent: string[] = [];
  const errors: unknown[] = [];
  return {
    queue,
    sent,
    errors,
    isCurrent: () => true,
    waitUntilIdle: async () => true,
    send: async (item: QueuedChatMessage) => {
      sent.push(item.id);
    },
    isUnknownAppend: () => false,
    onError: (error: unknown) => {
      errors.push(error);
    },
  };
}

test("queue snapshots retain attachments, skills and visualization independently of the composer", () => {
  const queue = new ChatMessageQueue();
  const item = {
    ...message("one"),
    attachments: [
      {
        id: "file",
        name: "notes.txt",
        kind: "text" as const,
        mimeType: "text/plain",
        size: 4,
        text: "note",
      },
    ],
    options: { visualize: true },
  };
  queue.add(item);
  item.attachments[0].text = "changed";
  assert.equal(queue.getSnapshot().messages[0].attachments[0].text, "note");
  assert.equal(queue.getSnapshot().messages[0].options?.visualize, true);
  assert.equal(chatMessageQueue("chat-one"), chatMessageQueue("chat-one"));
  assert.notEqual(chatMessageQueue("chat-one"), chatMessageQueue("chat-two"));
});

test("FIFO, steering priority, deleting and keyboard reorder preserve stable identities", () => {
  const queue = new ChatMessageQueue();
  ["one", "two", "three"].forEach((id) => queue.add(message(id)));
  queue.move("three", 0);
  queue.remove("two");
  assert.deepEqual(
    queue.getSnapshot().messages.map((item) => item.id),
    ["three", "one"],
  );
  assert.equal(queue.claim()?.id, "three");
  assert.equal(queue.claim(), undefined);
  queue.move("one", 0);
  queue.remove("three");
  assert.equal(queue.edit("one"), false);
  assert.equal(queue.getSnapshot().messages[0].id, "three");
  queue.settle("wrong-id", "sent");
  assert.equal(queue.getSnapshot().sendingId, "three");
  queue.settle("three", "sent");
  assert.equal(queue.claim()?.id, "one");
});

test("editing pauses dispatch; cancel preserves the original and save preserves queue position", () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  queue.add(message("two"));
  assert.equal(queue.edit("two"), true);
  assert.equal(queue.claim(), undefined);
  queue.closeEditor();
  assert.equal(queue.getSnapshot().messages[1].text, "message two");
  queue.edit("two");
  queue.update({ ...message("two"), text: "edited" });
  assert.equal(queue.getSnapshot().messages[1].text, "edited");
  assert.equal(queue.claim()?.id, "one");
});

test("blank and oversized edits leave the editor and original message intact", () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  queue.edit("one");
  assert.throws(() => queue.update({ ...message("one"), text: " " }), /Add a message/u);
  assert.throws(
    () => queue.update({ ...message("one"), text: "x".repeat(1024 * 1024 + 1) }),
    /1 MB/u,
  );
  assert.equal(queue.getSnapshot().editingId, "one");
  assert.equal(queue.getSnapshot().messages[0].text, "message one");
});

test("queue capacity failures never consume another draft", () => {
  const queue = new ChatMessageQueue();
  for (let index = 0; index < 20; index++) queue.add(message(String(index)));
  assert.throws(() => queue.add(message("overflow")), /queue is full/u);
  queue.add(message("0"));
  assert.equal(queue.getSnapshot().messages.length, 20);
});

test("main persistence barrier and synchronous claim prevent early or duplicate sends", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  const idle = deferred<boolean>();
  const input = { ...delivery(queue), waitUntilIdle: () => idle.promise };
  const first = deliverQueuedMessage(input);
  await deliverQueuedMessage(input);
  assert.deepEqual(input.sent, []);
  idle.resolve(true);
  await first;
  assert.deepEqual(input.sent, ["one"]);
  assert.equal(queue.getSnapshot().messages.length, 0);
});

test("route/readiness changes defer unsent messages without sending to the next chat", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  const input = { ...delivery(queue), isCurrent: () => false };
  await deliverQueuedMessage(input);
  assert.deepEqual(input.sent, []);
  assert.equal(queue.getSnapshot().messages.length, 1);
  assert.equal(queue.getSnapshot().sendingId, undefined);
});

test("stop during the saving barrier pauses delivery and explicit resume continues once", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  const idle = deferred<boolean>();
  const input = { ...delivery(queue), waitUntilIdle: () => idle.promise };
  const pending = deliverQueuedMessage(input);
  queue.pause();
  idle.resolve(true);
  await pending;
  await deliverQueuedMessage(input);
  assert.deepEqual(input.sent, []);
  queue.resume();
  await deliverQueuedMessage(input);
  assert.deepEqual(input.sent, ["one"]);
});

test("definite failures preserve the message and pause all later messages", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  queue.add(message("two"));
  const input = {
    ...delivery(queue),
    send: async () => {
      throw new Error("save failed");
    },
  };
  await deliverQueuedMessage(input);
  assert.equal(input.errors.length, 1);
  assert.equal(queue.getSnapshot().paused, true);
  assert.equal(queue.getSnapshot().messages.length, 2);
  assert.equal(queue.claim(), undefined);
});

test("uncertain append outcomes are removed from the queue and never replayed", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  queue.add(message("two"));
  const input = {
    ...delivery(queue),
    isUnknownAppend: () => true,
    send: async () => {
      throw new Error("unknown save outcome");
    },
  };
  await deliverQueuedMessage(input);
  assert.deepEqual(
    queue.getSnapshot().messages.map((item) => item.id),
    ["two"],
  );
  assert.equal(queue.getSnapshot().paused, true);
});

test("a persistence timeout pauses without appending or dropping the queued message", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  const input = { ...delivery(queue), waitUntilIdle: async () => false };
  await deliverQueuedMessage(input);
  assert.deepEqual(input.sent, []);
  assert.equal(input.errors.length, 1);
  assert.equal(queue.getSnapshot().messages.length, 1);
  assert.equal(queue.getSnapshot().paused, true);
});

test("deleting a chat while waiting for persistence invalidates its claimed message", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  const idle = deferred<boolean>();
  const input = { ...delivery(queue), waitUntilIdle: () => idle.promise };
  const pending = deliverQueuedMessage(input);
  queue.discard();
  idle.resolve(true);
  await pending;
  assert.deepEqual(input.sent, []);
  assert.deepEqual(queue.getSnapshot().messages, []);
});
