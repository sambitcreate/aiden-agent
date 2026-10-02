import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatMessageQueue,
  chatMessageQueue,
  canSteerQueuedMessage,
  deliverQueuedMessage,
  steerQueuedMessage,
  withCommittedRunInput,
  type QueuedChatMessage,
} from "./chat-message-queue";

test("committed steer shows once in the open chat, even if a reload already has it", () => {
  const chat = {
    id: "chat-1",
    messages: [{ id: "m1", role: "user" as const, content: "Start", createdAt: 1 }],
  };
  const committed = { messageId: "m2", text: "Prefer bullet points", createdAt: 2 };
  const shown = withCommittedRunInput(chat, committed);
  assert.deepEqual(
    shown.messages.map((item) => [item.id, item.role, item.content]),
    [
      ["m1", "user", "Start"],
      ["m2", "user", "Prefer bullet points"],
    ],
  );
  assert.equal(chat.messages.length, 1, "the cached chat is not mutated");
  assert.equal(withCommittedRunInput(shown, committed).messages.length, 2);
});

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

test("FIFO, priority, deleting and keyboard reorder preserve stable identities", () => {
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

test("redirect replacement is atomic and Stop clears queued work", () => {
  const queue = new ChatMessageQueue();
  queue.add(message("old"));
  assert.throws(() => queue.replaceWith({ ...message("invalid"), text: "" }), /Add a message/u);
  assert.deepEqual(queue.getSnapshot().messages.map((item) => item.id), ["old"]);
  queue.replaceWith(message("replacement"));
  assert.deepEqual(queue.getSnapshot().messages.map((item) => item.id), ["replacement"]);
  queue.discard();
  assert.equal(queue.getSnapshot().messages.length, 0);
  assert.equal(queue.claim(), undefined);
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

async function drain(queue: ChatMessageQueue) {
  const input = delivery(queue);
  for (let index = 0; index < 5; index++) await deliverQueuedMessage(input);
  return input;
}

test("messages queued during compaction deliver in order only after it completes", async () => {
  const queue = new ChatMessageQueue();
  queue.holdForCompaction();
  ["one", "two", "three"].forEach((id) => queue.add(message(id)));
  const held = await drain(queue);
  assert.deepEqual(held.sent, [], "nothing is sent while compaction runs");
  assert.equal(queue.getSnapshot().messages.length, 3);

  assert.equal(queue.releaseCompactionHold({ compacted: true }), false);
  const released = await drain(queue);
  assert.deepEqual(released.sent, ["one", "two", "three"]);
  assert.equal(queue.getSnapshot().paused, false);
});

test("a compaction that was unnecessary or never admitted releases the queue unpaused", async () => {
  for (const reason of ["already_compact", "busy"]) {
    const queue = new ChatMessageQueue();
    queue.holdForCompaction();
    queue.add(message("one"));
    assert.equal(queue.releaseCompactionHold({ compacted: false, reason }), false);
    assert.deepEqual((await drain(queue)).sent, ["one"], reason);
  }
});

test("failed, cancelled or errored compaction keeps queued messages paused until resumed", async () => {
  for (const outcome of [
    { compacted: false as const, reason: "compaction_failed" },
    { compacted: false as const, reason: "cancelled" },
    { compacted: false as const, reason: "provider_unavailable" },
    undefined,
  ]) {
    const queue = new ChatMessageQueue();
    queue.holdForCompaction();
    queue.add(message("one"));
    queue.add(message("two"));
    assert.equal(queue.releaseCompactionHold(outcome), true);
    assert.deepEqual((await drain(queue)).sent, [], "paused queue does not replay");
    assert.deepEqual(
      queue.getSnapshot().messages.map((item) => item.id),
      ["one", "two"],
    );
    queue.resume();
    assert.deepEqual((await drain(queue)).sent, ["one", "two"]);
  }
});

test("releasing a failed compaction with an empty queue does not pause later sends", () => {
  const queue = new ChatMessageQueue();
  queue.holdForCompaction();
  assert.equal(
    queue.releaseCompactionHold({ compacted: false, reason: "compaction_failed" }),
    false,
  );
  queue.add(message("later"));
  assert.equal(queue.claim()?.id, "later");
});

test("a delivery waiting for idle defers when compaction takes the chat", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  const idle = deferred<boolean>();
  const input = { ...delivery(queue), waitUntilIdle: () => idle.promise };
  const pending = deliverQueuedMessage(input);
  queue.holdForCompaction();
  idle.resolve(true);
  await pending;
  assert.deepEqual(input.sent, []);
  assert.equal(queue.getSnapshot().sendingId, undefined);
  assert.equal(queue.getSnapshot().paused, false);
  queue.releaseCompactionHold({ compacted: true });
  assert.deepEqual((await drain(queue)).sent, ["one"]);
});

function ids(queue: ChatMessageQueue) {
  return queue.getSnapshot().messages.map((item) => item.id);
}

test("steering a later queued message sends only its text and leaves the rest in order", async () => {
  const queue = new ChatMessageQueue();
  ["one", "two", "three"].forEach((id) => queue.add(message(id)));
  const admitted: string[] = [];
  const outcome = await steerQueuedMessage({
    queue,
    id: "two",
    admit: async (text) => {
      admitted.push(text);
      // The row is held while admission is in flight, so auto-delivery waits.
      assert.equal(queue.claim(), undefined);
      return { admitted: true, queue: "steer", committed: true, messageId: "m-1" };
    },
  });
  assert.deepEqual(outcome, { kind: "admitted" });
  assert.deepEqual(admitted, ["message two"]);
  assert.deepEqual(ids(queue), ["one", "three"]);
  assert.equal(queue.getSnapshot().paused, false);
  assert.equal(queue.claim()?.id, "one");
});

test("an explicit steer works while the queue is paused and keeps it paused", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  queue.pause();
  const outcome = await steerQueuedMessage({
    queue,
    id: "one",
    admit: async () => ({ admitted: true, queue: "steer", committed: true, messageId: "m" }),
  });
  assert.equal(outcome.kind, "admitted");
  assert.deepEqual(ids(queue), []);
  assert.equal(queue.getSnapshot().paused, true);
});

test("a steer committed as history after the run ended is removed, never resent as a turn", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  const outcome = await steerQueuedMessage({
    queue,
    id: "one",
    admit: async () => ({
      admitted: false,
      reason: "run_not_active",
      committed: true,
      messageId: "m",
    }),
  });
  assert.deepEqual(outcome, { kind: "committed", reason: "run_not_active" });
  assert.deepEqual(ids(queue), []);
  assert.deepEqual((await drain(queue)).sent, []);
});

test("an uncommitted steer rejection keeps the message queued for the normal follow-up", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  const outcome = await steerQueuedMessage({
    queue,
    id: "one",
    admit: async () => ({ admitted: false, reason: "capacity", committed: false }),
  });
  assert.deepEqual(outcome, { kind: "rejected", reason: "capacity" });
  assert.equal(queue.getSnapshot().paused, false);
  assert.deepEqual((await drain(queue)).sent, ["one"]);
});

test("an unknown steer outcome keeps the message but stops auto-delivery", async () => {
  const queue = new ChatMessageQueue();
  queue.add(message("one"));
  const error = new Error("outcome requires reconciliation");
  const outcome = await steerQueuedMessage({
    queue,
    id: "one",
    admit: async () => {
      throw error;
    },
  });
  assert.deepEqual(outcome, { kind: "unknown", error });
  assert.deepEqual(ids(queue), ["one"]);
  assert.equal(queue.getSnapshot().paused, true);
  assert.deepEqual((await drain(queue)).sent, []);
});

test("messages a run cannot take as guidance are never offered to admission", async () => {
  const queue = new ChatMessageQueue();
  const attachment = {
    id: "file",
    name: "notes.txt",
    kind: "text" as const,
    mimeType: "text/plain",
    size: 4,
    text: "note",
  };
  const unsteerable: QueuedChatMessage[] = [
    { id: "file", text: "see file", attachments: [attachment] },
    { id: "visual", text: "draw it", attachments: [], options: { visualize: true } },
    {
      id: "skill",
      text: "run it",
      attachments: [],
      skillInvocation: { name: "s" } as unknown as QueuedChatMessage["skillInvocation"],
    },
    { id: "blank", text: "   ", attachments: [attachment] },
    { id: "huge", text: "x".repeat(200_001), attachments: [] },
  ];
  unsteerable.forEach((item) => queue.add(item));
  queue.add(message("editing"));
  queue.edit("editing");
  let calls = 0;
  for (const id of [...unsteerable.map((item) => item.id), "editing", "missing"]) {
    const outcome = await steerQueuedMessage({
      queue,
      id,
      admit: async () => {
        calls++;
        return { admitted: true, committed: true };
      },
    });
    assert.deepEqual(outcome, { kind: "unavailable" }, id);
  }
  assert.equal(calls, 0);
  assert.equal(queue.getSnapshot().messages.length, unsteerable.length + 1);
  assert.equal(canSteerQueuedMessage(message("plain")), true);
});
