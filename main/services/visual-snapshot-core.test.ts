import assert from "node:assert/strict";
import test from "node:test";
import {
  createVisualSnapshotQueue,
  snapshotAttachment,
  visualSnapshotAttachmentId,
  type VisualSnapshotJob,
} from "./visual-snapshot-core.js";
import { isVisualSnapshotAttachmentId } from "../../renderer/shared/visual-snapshots.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function job(chatId: string, visualIds: string[]): VisualSnapshotJob {
  return { chatId, messageId: "m-1", visuals: visualIds.map((visualId) => ({ kind: "html", visualId, title: visualId })) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("attachment ids are reserved and stable per chat, message, and visual", () => {
  const id = visualSnapshotAttachmentId("chat", "m-1", "ui-1");
  assert.equal(isVisualSnapshotAttachmentId(id), true);
  assert.equal(visualSnapshotAttachmentId("chat", "m-1", "ui-1"), id);
  assert.notEqual(visualSnapshotAttachmentId("chat", "m-1", "ui-2"), id);
  const attachment = snapshotAttachment("chat", "m-1", { visualId: "ui-1", title: "Q3 / revenue", bytes: PNG, mimeType: "image/png" });
  assert.equal(attachment.id, id);
  assert.equal(attachment.name, "Q3 revenue.png");
  assert.equal(attachment.size, PNG.length);
  assert.equal(attachment.kind, "image");
});

test("jobs run one capture at a time, in order, and store only successes", async () => {
  const order: string[] = [];
  const stored: { chatId: string; ids: string[] }[] = [];
  let active = 0;
  const queue = createVisualSnapshotQueue({
    capture: async (visual) => {
      active += 1;
      assert.equal(active, 1, "never two captures at once");
      order.push(visual.visualId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return visual.visualId === "bad" ? null : { bytes: PNG, mimeType: "image/png" };
    },
    store: async (chatId, _messageId, snapshots) => {
      stored.push({ chatId, ids: snapshots.map((snapshot) => snapshot.visualId) });
    },
  });
  queue.enqueue(job("a", ["a1", "bad", "a2"]));
  queue.enqueue(job("b", ["b1"]));
  await queue.idle();
  assert.deepEqual(order, ["a1", "bad", "a2", "b1"]);
  assert.deepEqual(stored, [{ chatId: "a", ids: ["a1", "a2"] }, { chatId: "b", ids: ["b1"] }]);
});

test("a capture that never finishes is abandoned after the timeout and the queue moves on", async () => {
  const aborted: string[] = [];
  const stored: string[] = [];
  const queue = createVisualSnapshotQueue({
    timeoutMs: 20,
    capture: (visual, signal) =>
      visual.visualId === "hang"
        ? new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted.push(visual.visualId);
              reject(new Error("aborted"));
            });
          })
        : Promise.resolve({ bytes: PNG, mimeType: "image/png" as const }),
    store: async (_chatId, _messageId, snapshots) => {
      stored.push(...snapshots.map((snapshot) => snapshot.visualId));
    },
  });
  queue.enqueue(job("a", ["hang", "ok"]));
  await queue.idle();
  assert.deepEqual(aborted, ["hang"]);
  assert.deepEqual(stored, ["ok"]);
});

test("cancelling a chat drops its queued jobs and never stores an in-flight one", async () => {
  const gate = deferred();
  const stored: string[] = [];
  const queue = createVisualSnapshotQueue({
    capture: async (visual) => {
      if (visual.visualId === "a1") await gate.promise;
      return { bytes: PNG, mimeType: "image/png" };
    },
    store: async (chatId) => {
      stored.push(chatId);
    },
  });
  queue.enqueue(job("a", ["a1"]));
  queue.enqueue(job("a", ["a2"]));
  queue.enqueue(job("b", ["b1"]));
  queue.cancelChat("a");
  gate.resolve();
  await queue.idle();
  assert.deepEqual(stored, ["b"]);
});

test("a disposed queue refuses new work", async () => {
  let captures = 0;
  const queue = createVisualSnapshotQueue({
    capture: async () => {
      captures += 1;
      return { bytes: PNG, mimeType: "image/png" };
    },
    store: async () => undefined,
  });
  queue.dispose();
  queue.enqueue(job("a", ["a1"]));
  await queue.idle();
  assert.equal(captures, 0);
});
