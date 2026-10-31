import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createChatAttachmentRequestHandler, parseChatImageUrl } from "./chat-attachment-request-handler.js";
import { CHAT_IMAGES_DIRECTORY, createChatImageStore, imageSha256 } from "./chat-image-store.js";
import { createChatStore } from "./chat-store-core.js";
import type { Attachment } from "./types.js";
import { parseAttachments, withReadableImages } from "./attachment-contract.js";
import { projectAidenChatExport } from "./chat-export.js";
import { chatForRenderer } from "./visible-chat-projection.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG, "base64");
const DAY = 24 * 60 * 60 * 1000;

async function tempDir(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-images-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function image(id: string, data = PNG): Attachment {
  return { id, name: `${id}.png`, mimeType: "image/png", kind: "image", size: Buffer.from(data, "base64").length, data };
}

async function imageFiles(directory: string): Promise<string[]> {
  const root = path.join(directory, CHAT_IMAGES_DIRECTORY);
  const names: string[] = [];
  for (const shard of (await fs.readdir(root).catch(() => [])).filter((name) => /^[0-9a-f]{2}$/u.test(name))) {
    for (const name of await fs.readdir(path.join(root, shard))) names.push(name);
  }
  return names.sort();
}

async function ageImageFiles(directory: string, ms: number): Promise<void> {
  const root = path.join(directory, CHAT_IMAGES_DIRECTORY);
  const then = new Date(Date.now() - ms);
  for (const shard of (await fs.readdir(root)).filter((name) => /^[0-9a-f]{2}$/u.test(name))) {
    for (const name of await fs.readdir(path.join(root, shard))) {
      await fs.utimes(path.join(root, shard, name), then, then);
    }
  }
}

async function chatWithImage(directory: string) {
  const store = createChatStore(async () => directory);
  const chat = await store.create({});
  await store.appendMessage(chat.id, { role: "user", content: "Look", attachments: [image("photo")] });
  return { store, chatId: chat.id };
}

test("an image is stored once by its hash and read back only at its recorded size", async (t) => {
  const directory = await tempDir(t);
  const images = createChatImageStore(async () => directory);
  const sha = await images.put(PNG_BYTES);
  assert.equal(sha, imageSha256(PNG_BYTES));
  assert.equal(await images.put(PNG_BYTES), sha);
  assert.deepEqual(await imageFiles(directory), [sha]);
  assert.deepEqual(await images.read(sha, PNG_BYTES.length), PNG_BYTES);
  assert.equal(await images.read(sha, PNG_BYTES.length + 1), undefined);
  assert.equal(await images.read("0".repeat(64), 10), undefined);
  await assert.rejects(images.read("../escape", 10), /Invalid image hash/);

  // A damaged file under the hash is replaced by the next put of the real bytes.
  await fs.writeFile(await images.path(sha), "torn");
  assert.equal(await images.read(sha, PNG_BYTES.length), undefined);
  await images.put(PNG_BYTES);
  assert.deepEqual(await images.read(sha, PNG_BYTES.length), PNG_BYTES);
});

test("sweeping keeps referenced, recent and protected images and removes the rest", async (t) => {
  const directory = await tempDir(t);
  const images = createChatImageStore(async () => directory);
  const kept = await images.put(Buffer.from("kept"));
  const unused = await images.put(Buffer.from("unused"));
  const guarded = await images.put(Buffer.from("guarded"));
  await ageImageFiles(directory, 2 * DAY);
  const recent = await images.put(Buffer.from("recent"));
  const staging = path.join(directory, CHAT_IMAGES_DIRECTORY, unused.slice(0, 2), `.${unused}.00000000-0000-4000-8000-000000000000.tmp`);
  await fs.writeFile(staging, "partial");
  const old = new Date(Date.now() - 2 * DAY);
  await fs.utimes(staging, old, old);

  const result = await images.sweep(new Set([kept]), { graceMs: DAY, isProtected: (sha) => sha === guarded });

  assert.equal(result.removed, 1);
  assert.deepEqual(await imageFiles(directory), [kept, guarded, recent].sort());
});

test("a saved chat keeps image references on disk and still returns the bytes to the app", async (t) => {
  const directory = await tempDir(t);
  const { store, chatId } = await chatWithImage(directory);
  const sha = imageSha256(PNG_BYTES);

  const onDisk = await fs.readFile(path.join(directory, `${chatId}.json`), "utf8");
  assert.ok(!onDisk.includes(PNG), "the chat file carries no image bytes");
  assert.deepEqual(await imageFiles(directory), [sha]);

  // The app gets the image exactly as a new message carries it, so every
  // exact-shape check (model turns, exports, the CLI server) still accepts it.
  const loaded = (await store.get(chatId))!.messages[0]!.attachments!;
  assert.deepEqual(loaded, [image("photo")]);
  assert.deepEqual(parseAttachments(loaded), [image("photo")]);

  const reference = (await store.getWithImageReferences(chatId))!.messages[0]!.attachments![0]!;
  assert.equal(reference.data, undefined);
  assert.equal(reference.sha256, sha);
  assert.deepEqual([reference.width, reference.height], [1, 1]);

  // A chat read with its bytes still reaches the window as a link.
  const projected = chatForRenderer((await store.get(chatId))!)!.messages[0]!.attachments![0]!;
  assert.equal(projected.data, undefined);
  assert.equal(projected.url, `aiden-attachment://image/${encodeURIComponent(chatId)}/${sha}`);
  assert.deepEqual([projected.width, projected.height], [1, 1]);
});

test("an exported chat carries its images inline and leaves out one whose file is gone", async (t) => {
  const directory = await tempDir(t);
  const { store, chatId } = await chatWithImage(directory);
  await store.appendMessage(chatId, { role: "user", content: "Second", attachments: [image("lost", Buffer.from("lost").toString("base64"))] });
  await fs.rm(path.join(directory, CHAT_IMAGES_DIRECTORY, imageSha256(Buffer.from("lost")).slice(0, 2)), { recursive: true });

  const exported = projectAidenChatExport((await store.get(chatId))!);
  assert.deepEqual(exported.chat.messages.map((message) => message.attachments), [[image("photo")], undefined]);
});

test("an older chat with inline images moves them out the next time it is saved", async (t) => {
  const directory = await tempDir(t);
  const { store, chatId } = await chatWithImage(directory);
  const file = path.join(directory, `${chatId}.json`);
  // Rewrite the chat the way earlier versions stored it: bytes inline, no hash.
  const legacy = JSON.parse(await fs.readFile(file, "utf8"));
  legacy.messages[0].attachments = [image("photo")];
  await fs.writeFile(file, JSON.stringify(legacy));
  await fs.rm(path.join(directory, CHAT_IMAGES_DIRECTORY), { recursive: true });

  const reopened = createChatStore(async () => directory);
  assert.equal((await reopened.get(chatId))!.messages[0]!.attachments![0]!.data, PNG);
  assert.ok((await fs.readFile(file, "utf8")).includes(PNG), "reading alone does not rewrite the chat");

  await reopened.rename(chatId, "Renamed");
  assert.ok(!(await fs.readFile(file, "utf8")).includes(PNG));
  assert.deepEqual(await imageFiles(directory), [imageSha256(PNG_BYTES)]);
  assert.equal((await store.get(chatId))!.messages[0]!.attachments![0]!.data, PNG);
});

test("a copied chat shares its source's image file", async (t) => {
  const directory = await tempDir(t);
  const { store, chatId } = await chatWithImage(directory);
  await store.appendMessage(chatId, { role: "assistant", content: "Nice." });
  const copy = await store.copyVisibleHistory({ sourceChatId: chatId });

  assert.deepEqual(await imageFiles(directory), [imageSha256(PNG_BYTES)]);
  assert.equal(copy.messages[0]!.attachments![0]!.data, PNG);
  assert.equal((await store.get(copy.id))!.messages[0]!.attachments![0]!.data, PNG);
});

test("a chat whose image file is missing still loads, with that image's bytes absent", async (t) => {
  const directory = await tempDir(t);
  const { chatId } = await chatWithImage(directory);
  await fs.rm(path.join(directory, CHAT_IMAGES_DIRECTORY), { recursive: true });

  let reports = 0;
  const reopened = createChatStore(async () => directory, undefined, { onImageUnavailable: () => { reports += 1; } });
  const message = (await reopened.get(chatId))!.messages[0]!;
  assert.equal(message.content, "Look");
  assert.equal(message.attachments?.length, 1);
  assert.equal(message.attachments![0]!.data, undefined);
  // Exact-shape consumers skip the unreadable image instead of refusing the message.
  assert.deepEqual(withReadableImages(message.attachments), []);
  await reopened.get(chatId);
  assert.equal(reports, 1, "reported once per missing file");
});

test("images of a deleted chat are swept while images another chat still uses stay", async (t) => {
  const directory = await tempDir(t);
  const { store, chatId } = await chatWithImage(directory);
  const other = await store.create({});
  const otherBytes = Buffer.from(PNG_BYTES);
  otherBytes[otherBytes.length - 1] ^= 1; // a different file, still the right size for the record
  await store.appendMessage(other.id, {
    role: "user",
    content: "Keep",
    attachments: [image("photo"), image("second", otherBytes.toString("base64"))],
  });
  await store.appendMessage(chatId, { role: "user", content: "Only here", attachments: [image("third", Buffer.from("only-here").toString("base64"))] });
  await store.remove(other.id);
  await ageImageFiles(directory, 2 * DAY);

  // This process wrote those images within the day, so they are kept.
  assert.equal((await store.sweepUnusedImages()).removed, 0);

  // After a restart, the sweep the deletion asked for removes only the image
  // no remaining chat names.
  const restarted = createChatStore(async () => directory);
  assert.equal((await restarted.sweepUnusedImages({ onlyWhenNeeded: true })).removed, 1);
  assert.deepEqual(
    await imageFiles(directory),
    [imageSha256(PNG_BYTES), imageSha256(Buffer.from("only-here"))].sort(),
  );
  const messages = (await restarted.get(chatId))!.messages;
  assert.equal(messages[messages.length - 1]!.attachments![0]!.data, Buffer.from("only-here").toString("base64"));

  // Nothing was deleted since, so the next start reads no chats at all.
  await store.appendMessage(chatId, { role: "user", content: "Orphan", attachments: [image("orphan", Buffer.from("orphan").toString("base64"))] });
  await store.clearMessages(chatId);
  await ageImageFiles(directory, 2 * DAY);
  const quiet = createChatStore(async () => directory);
  assert.equal((await quiet.sweepUnusedImages({ onlyWhenNeeded: true })).removed, 3);
  assert.equal((await quiet.sweepUnusedImages({ onlyWhenNeeded: true })).removed, 0);
});

test("storing bytes that are already on disk renews them, so a sweep keeps them", async (t) => {
  const directory = await tempDir(t);
  const images = createChatImageStore(async () => directory);
  const sha = await images.put(PNG_BYTES);
  await ageImageFiles(directory, 2 * DAY);
  await images.put(PNG_BYTES);
  assert.deepEqual(await images.sweep(new Set(), { graceMs: DAY }), { removed: 0, deferred: 1 });
  assert.deepEqual(await imageFiles(directory), [sha]);
});

test("the window's image link serves the stored bytes and revalidates by hash", async (t) => {
  const directory = await tempDir(t);
  const { store, chatId } = await chatWithImage(directory);
  const handler = createChatAttachmentRequestHandler(store);

  const projected = chatForRenderer((await store.getWithImageReferences(chatId))!)!;
  const attachment = projected.messages[0]!.attachments![0]!;
  assert.equal(attachment.data, undefined, "the window receives a link instead of the bytes");
  const url = attachment.url!;
  assert.deepEqual(parseChatImageUrl(url), { chatId, sha256: imageSha256(PNG_BYTES) });

  const response = await handler(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("etag"), `"${imageSha256(PNG_BYTES)}"`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_BYTES);

  const revalidated = await handler(new Request(url, { headers: { "if-none-match": response.headers.get("etag")! } }));
  assert.equal(revalidated.status, 304);
  assert.equal((await revalidated.arrayBuffer()).byteLength, 0);

  const head = await handler(new Request(url, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(PNG_BYTES.length));
});

test("an image link only works for an image the chat still lists", async (t) => {
  const directory = await tempDir(t);
  const { store, chatId } = await chatWithImage(directory);
  const other = await store.create({});
  const handler = createChatAttachmentRequestHandler(store);
  const sha = imageSha256(PNG_BYTES);
  const base = "aiden-attachment://image";

  const statuses = await Promise.all(
    [
      `${base}/${other.id}/${sha}`,
      `${base}/${chatId}/${"0".repeat(64)}`,
      `${base}/missing-chat/${sha}`,
      `${base}/${chatId}/${sha}?x=1`,
      `${base}/${chatId}/..%2F${sha}`,
      `aiden-attachment://other/${chatId}/${sha}`,
    ].map(async (url) => (await handler(new Request(url))).status),
  );
  assert.deepEqual(statuses, [404, 404, 404, 404, 404, 404]);
  assert.equal((await handler(new Request(`${base}/${chatId}/${sha}`, { method: "POST" }))).status, 405);
});
