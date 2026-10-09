import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { createChatStore } from "./chat-store-core.js";
import { VISUAL_SNAPSHOT_ID_PREFIX } from "../../renderer/shared/visual-snapshots.js";
import { displayedAssistantImageUsage } from "./display-image-extension.js";
import type { Attachment } from "./types.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_SIZE = Buffer.from(PNG, "base64").length;
const HTML_MEDIA = `html_${"1".repeat(43)}`;

function snapshotId(digit: string): string {
  return `${VISUAL_SNAPSHOT_ID_PREFIX}${digit.repeat(64)}`;
}

function png(id: string, name = "Board.png"): Attachment {
  return { id, name, mimeType: "image/png", kind: "image", size: PNG_SIZE, data: PNG };
}

async function chatWithVisuals(t: TestContext, extraAttachments: Attachment[] = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-snapshots-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Snapshots", workspaceId: "w", providerId: "p", model: "m" });
  await store.appendMessage(chat.id, { role: "user", content: "Draw it" });
  const withAssistant = await store.appendMessage(chat.id, {
    role: "assistant",
    content: "Here",
    ...(extraAttachments.length ? { attachments: extraAttachments } : {}),
    htmlArtifacts: [{ version: 1, kind: "html", id: "a-1", title: "Chart", mimeType: "text/html", size: 1, mediaId: HTML_MEDIA }],
    uiVisuals: [{
      version: 1, kind: "ui", id: "ui-1", title: "Board", catalogVersion: 1,
      tree: { t: "Visual", k: "0" }, fallbackText: "Board",
    }],
  });
  const [user, assistant] = withAssistant.messages;
  return { store, directory, chatId: chat.id, userId: user!.id, assistantId: assistant!.id };
}

test("snapshots attach as reserved images and a newer capture replaces the older one", async (t) => {
  const { store, directory, chatId, assistantId } = await chatWithVisuals(t);
  assert.equal(await store.addVisualSnapshots(chatId, assistantId, [
    { visualId: "ui-1", attachment: png(snapshotId("a")) },
    { visualId: HTML_MEDIA, attachment: png(snapshotId("b"), "Chart.png") },
  ]), true);
  assert.equal(await store.addVisualSnapshots(chatId, assistantId, [{ visualId: "ui-1", attachment: png(snapshotId("c")) }]), true);
  const message = (await createChatStore(async () => directory).get(chatId))?.messages[1];
  assert.deepEqual(message?.attachments?.map((attachment) => attachment.id).sort(), [snapshotId("b"), snapshotId("c")]);
  assert.deepEqual(message?.visualSnapshots, [
    { visualId: HTML_MEDIA, attachmentId: snapshotId("b") },
    { visualId: "ui-1", attachmentId: snapshotId("c") },
  ]);
  // Snapshots never count against the display_image budget.
  assert.deepEqual(displayedAssistantImageUsage([message!]), { bytes: 0, count: 0, pixels: 0 });
});

test("snapshots are refused for unknown visuals, user messages, and unreserved ids", async (t) => {
  const { store, chatId, assistantId, userId } = await chatWithVisuals(t);
  assert.equal(await store.addVisualSnapshots(chatId, assistantId, [{ visualId: "ui-ghost", attachment: png(snapshotId("a")) }]), false);
  assert.equal(await store.addVisualSnapshots(chatId, userId, [{ visualId: "ui-1", attachment: png(snapshotId("a")) }]), false);
  assert.equal(await store.addVisualSnapshots(chatId, assistantId, [{ visualId: "ui-1", attachment: png("plain-id") }]), false);
  assert.equal(await store.addVisualSnapshots("missing", assistantId, [{ visualId: "ui-1", attachment: png(snapshotId("a")) }]), false);
});

test("a message already holding twenty attachments gets no snapshot", async (t) => {
  const full = Array.from({ length: 20 }, (_, index) => png(`image-${index}`, `${index}.png`));
  const { store, chatId, assistantId } = await chatWithVisuals(t, full);
  assert.equal(await store.addVisualSnapshots(chatId, assistantId, [{ visualId: "ui-1", attachment: png(snapshotId("a")) }]), false);
});

test("copies keep each snapshot pointing at the copied visual", async (t) => {
  const { store, chatId, assistantId } = await chatWithVisuals(t);
  await store.addVisualSnapshots(chatId, assistantId, [
    { visualId: "ui-1", attachment: png(snapshotId("a")) },
    { visualId: HTML_MEDIA, attachment: png(snapshotId("b")) },
  ]);
  const clone = await store.copyVisibleHistory({ sourceChatId: chatId });
  const copied = clone.messages[1];
  const copiedMedia = copied?.htmlArtifacts?.[0]?.mediaId;
  assert.ok(copiedMedia && copiedMedia !== HTML_MEDIA);
  assert.deepEqual(copied?.visualSnapshots, [
    { visualId: "ui-1", attachmentId: snapshotId("a") },
    { visualId: copiedMedia, attachmentId: snapshotId("b") },
  ]);
  assert.deepEqual(copied?.attachments?.map((attachment) => attachment.id).sort(), [snapshotId("a"), snapshotId("b")]);
});
