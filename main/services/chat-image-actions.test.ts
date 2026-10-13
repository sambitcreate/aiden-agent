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
  }
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(clipboard.length, 0);
  assert.equal(await invoke("chats:copyImage", { chatId: "chat-1", attachmentId: "img" }), true);
  assert.deepEqual(clipboard, [Buffer.from(PNG, "base64")]);
});

test("file names lose separators, control characters and leading dots", () => {
  assert.equal(safeImageFileStem("../../etc/passwd.png"), "etc passwd");
  assert.equal(safeImageFileStem(".hidden\u0000name.jpg"), "hidden name");
  assert.equal(safeImageFileStem("..."), "Image");
  assert.equal(safeImageFileStem("x".repeat(400)).length, 120);
});
