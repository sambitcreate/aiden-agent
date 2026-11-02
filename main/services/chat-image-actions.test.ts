import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { registerChatImageActionHandlers, safeImageFileStem, type ChatImageActionDeps } from "./chat-image-actions.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

async function setup(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-actions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const clipboard: Buffer[] = [];
  const revealed: string[] = [];
  const chats: Record<string, unknown> = {
    "chat-1": {
      messages: [
        { id: "m1", role: "user", content: "", attachments: [{ id: "doc", name: "notes.txt", mimeType: "text/plain", kind: "text", size: 2, text: "hi" }] },
        {
          id: "m2",
          role: "assistant",
          content: "",
          attachments: [{ id: "img", name: "../Generated image.png", mimeType: "image/png", kind: "image", size: 68, data: PNG }],
        },
      ],
    },
  };
  const deps: ChatImageActionDeps = {
    getChat: async (id) => (chats[id] as never) ?? null,
    downloadsDir: () => dir,
    writeClipboardImage: (bytes) => clipboard.push(bytes),
    showItemInFolder: (file) => revealed.push(file),
  };
  registerChatImageActionHandlers({ handle: (channel, fn) => void handlers.set(channel, fn) }, deps);
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!({}, ...args));
  return { dir, invoke, clipboard, revealed };
}

test("saving writes the stored bytes to Downloads under a fresh, safe name and never overwrites", async (t) => {
  const { dir, invoke, revealed } = await setup(t);
  await fs.writeFile(path.join(dir, "Generated image.png"), "keep me");

  const first = (await invoke("chats:saveImageToDownloads", { chatId: "chat-1", attachmentId: "img" })) as { path: string };
  const second = (await invoke("chats:saveImageToDownloads", { chatId: "chat-1", attachmentId: "img" })) as { path: string };

  assert.deepEqual([path.basename(first.path), path.basename(second.path)], ["Generated image (1).png", "Generated image (2).png"]);
  assert.equal(path.dirname(first.path), dir);
  assert.equal(await fs.readFile(path.join(dir, "Generated image.png"), "utf8"), "keep me");
  assert.deepEqual(await fs.readFile(first.path), Buffer.from(PNG, "base64"));

  await invoke("chats:showSavedImage", first.path);
  assert.deepEqual(revealed, [first.path]);
  await assert.rejects(invoke("chats:showSavedImage", path.join(dir, "Generated image.png")), /isn't available/);
});

test("only an image stored in that chat can be saved or copied", async (t) => {
  const { invoke, clipboard, dir } = await setup(t);
  for (const input of [
    { chatId: "chat-1", attachmentId: "missing" },
    { chatId: "chat-1", attachmentId: "doc" },
    { chatId: "other", attachmentId: "img" },
    { chatId: "chat-1", attachmentId: "img", path: "/etc/passwd" },
    { chatId: "chat-1" },
    "img",
  ]) {
    await assert.rejects(invoke("chats:saveImageToDownloads", input));
    await assert.rejects(invoke("chats:copyImage", input));
    await assert.rejects(invoke("chats:imageData", input));
  }
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(clipboard.length, 0);
  assert.equal(await invoke("chats:copyImage", { chatId: "chat-1", attachmentId: "img" }), true);
  assert.deepEqual(clipboard, [Buffer.from(PNG, "base64")]);
  assert.deepEqual(await invoke("chats:imageData", { chatId: "chat-1", attachmentId: "img" }), { data: PNG });
});

test("an image kept as a file is read from that file alone", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-actions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const reads: string[] = [];
  const sha256 = "c".repeat(64);
  registerChatImageActionHandlers({ handle: (channel, fn) => void handlers.set(channel, fn) }, {
    getChat: async () => ({
      messages: [{
        id: "m1",
        role: "assistant",
        content: "",
        createdAt: 1,
        attachments: [
          { id: "img", name: "Chart.png", mimeType: "image/png", kind: "image", size: 68, sha256 },
          { id: "gone", name: "Gone.png", mimeType: "image/png", kind: "image", size: 68, sha256: "d".repeat(64) },
        ],
      }],
    }),
    readImage: async (hash, size) => {
      reads.push(hash);
      return hash === sha256 && size === 68 ? Buffer.from(PNG, "base64") : undefined;
    },
    downloadsDir: () => dir,
    writeClipboardImage: () => undefined,
    showItemInFolder: () => undefined,
  });
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!({}, ...args));
  assert.deepEqual(await invoke("chats:imageData", { chatId: "chat-1", attachmentId: "img" }), { data: PNG });
  const saved = (await invoke("chats:saveImageToDownloads", { chatId: "chat-1", attachmentId: "img" })) as { path: string };
  assert.deepEqual(await fs.readFile(saved.path), Buffer.from(PNG, "base64"));
  await assert.rejects(invoke("chats:imageData", { chatId: "chat-1", attachmentId: "gone" }), /isn't saved/);
  assert.deepEqual(reads, [sha256, sha256, "d".repeat(64)]);
});

test("file names lose separators, control characters and leading dots", () => {
  assert.equal(safeImageFileStem("../../etc/passwd.png"), "etc passwd");
  assert.equal(safeImageFileStem(".hidden\u0000name.jpg"), "hidden name");
  assert.equal(safeImageFileStem("..."), "Image");
  assert.equal(safeImageFileStem("x".repeat(400)).length, 120);
});

test("bidi overrides, isolates and C1 controls cannot disguise a saved file's name", () => {
  // "photo<RLO>gnp.exe" would render in Finder as "photoexe.png".
  assert.equal(safeImageFileStem("photo‮gnp.exe"), "photo gnp");
  assert.equal(safeImageFileStem("a⁦b⁩c‏d\u0085e\u009Bf.png"), "a b c d e f");
  assert.equal(safeImageFileStem("‭‬.png"), "Image");
});

test("a saved image keeps the extension of its stored type", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-ext-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const types = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/heic": "heic",
    "image/heif": "heif",
  } as const;
  const attachments = Object.keys(types).map((mimeType, index) => ({
    id: `img-${index}`,
    // The stored name's own extension never decides the saved one.
    name: `Picture ${index}.png`,
    mimeType,
    kind: "image",
    size: 68,
    data: PNG,
  }));
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerChatImageActionHandlers(
    { handle: (channel, fn) => void handlers.set(channel, fn) },
    {
      getChat: async () => ({ messages: [{ id: "m", role: "assistant", content: "", createdAt: 1, attachments }] }) as never,
      downloadsDir: () => dir,
      writeClipboardImage: () => undefined,
      showItemInFolder: () => undefined,
    },
  );
  const saved: string[] = [];
  for (const attachment of attachments) {
    const result = (await handlers.get("chats:saveImageToDownloads")!({}, { chatId: "c", attachmentId: attachment.id })) as {
      path: string;
    };
    saved.push(path.basename(result.path));
  }
  assert.deepEqual(saved, Object.values(types).map((extension, index) => `Picture ${index}.${extension}`));
});
