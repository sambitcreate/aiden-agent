import assert from "node:assert/strict";
import test from "node:test";
import {
  createVisualSnapshotQueue,
  snapshotAttachment,
  visualSnapshotAttachmentId,
  visualSnapshotImages,
  type VisualSnapshotJob,
} from "./visual-snapshot-core.js";
import { isVisualSnapshotAttachmentId } from "../../renderer/shared/visual-snapshots.js";
import { MAX_ATTACHMENT_INLINE_BYTES } from "../../renderer/shared/attachment-contract.js";
import { compileAum } from "../../renderer/shared/aiden-ui/compile.js";
import type { ChatUiVisualV1 } from "../../renderer/shared/aiden-ui/types.js";
import type { Attachment } from "./types.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function visualReferencing(markup: string): ChatUiVisualV1 {
  const compiled = compileAum(markup);
  assert.ok(compiled.tree);
  return {
    version: 1,
    kind: "ui",
    id: "ui-1",
    title: "Chart",
    catalogVersion: 1,
    tree: compiled.tree,
    ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}),
    fallbackText: compiled.fallbackText,
  };
}

function image(id: string, overrides: Partial<Attachment> = {}): Attachment {
  return { id, name: `${id}.png`, mimeType: "image/png", kind: "image", size: PNG.length, data: PNG.toString("base64"), ...overrides };
}

const MESSAGE_IMAGES: Attachment[] = [
  image("photo-1"),
  image("photo-2"),
  image("photo-4"),
  { id: "notes", name: "notes.txt", mimeType: "text/plain", kind: "text", size: 4, text: "text" },
  image("vector", { mimeType: "image/svg+xml" }),
  image("empty", { data: undefined }),
  image("huge", { size: MAX_ATTACHMENT_INLINE_BYTES + 1 }),
  image(visualSnapshotAttachmentId("chat-1", "m-1", "ui-1")),
];

test("a literal image reference draws only that message image, in message order", () => {
  const visual = visualReferencing(
    `<Visual><Image attachment="photo-4" alt="A" /><Image attachment="photo-1" alt="B" />` +
      `<Image attachment="notes" alt="C" /><Image attachment="vector" alt="D" />` +
      `<Image attachment="empty" alt="E" /><Image attachment="huge" alt="F" /></Visual>`,
  );
  assert.deepEqual(
    visualSnapshotImages(visual, MESSAGE_IMAGES).map((attachment) => attachment.id),
    ["photo-1", "photo-4"],
  );
  assert.deepEqual(visualSnapshotImages(visual, undefined), []);
});

test("a snapshot never includes snapshot pictures, even when the visual names one", () => {
  const snapshotId = visualSnapshotAttachmentId("chat-1", "m-1", "ui-1");
  const visual = visualReferencing(`<Visual><Image attachment="${snapshotId}" alt="G" /></Visual>`);
  assert.deepEqual(visualSnapshotImages(visual, MESSAGE_IMAGES), []);
});

test("a computed image reference draws every eligible message image, since its id is only known on the desktop", () => {
  // Concatenation and an Each-scoped id both need evaluation, so the capture carries every eligible image.
  const visual = visualReferencing(
    `<Visual><Data name="ids">["photo-4"]</Data>` +
      `<Image attachment={"photo-" + 1} alt="A" />` +
      `<Each in={$ids}><Image attachment={$item} alt="B" /></Each></Visual>`,
  );
  assert.deepEqual(
    visualSnapshotImages(visual, MESSAGE_IMAGES).map((attachment) => attachment.id),
    ["photo-1", "photo-2", "photo-4"],
  );
});

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
