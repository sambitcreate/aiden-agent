import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DisplayImageArtifactStore,
  type RecoveredDisplayImageMessage,
} from "./display-image-artifact-store.js";
import {
  MAX_DISPLAY_IMAGES_PER_CHAT,
  MAX_DISPLAY_IMAGE_PIXELS,
  MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT,
} from "./display-image-extension.js";
import type { ChatArtifactV1 } from "../../renderer/shared/chat-artifacts.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
  "base64",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function storageRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function artifact(id: string, bytes = ONE_PIXEL_PNG): ChatArtifactV1 {
  return {
    version: 1,
    kind: "image",
    attachment: {
      id,
      name: `${id}.png`,
      mimeType: "image/png",
      kind: "image",
      size: bytes.length,
      data: bytes.toString("base64"),
    },
  };
}

test("staged image payloads survive restart and recover into ChatStore input", async () => {
  const root = await storageRoot();
  const store = new DisplayImageArtifactStore({
    root: () => root,
    now: () => 42,
  });
  await store.initialize();
  await store.stage({
    chatId: "chat-1",
    generationId: "generation-1",
    model: "test-model",
    artifact: artifact("image-1"),
    pixels: 1,
  });

  const restarted = new DisplayImageArtifactStore({
    root: () => root,
    now: () => 99,
  });
  await restarted.initialize();
  const recovered: RecoveredDisplayImageMessage[] = [];
  await restarted.recover(
    [
      {
        id: "chat-1",
        messages: [{ role: "assistant", attachments: undefined }],
      },
    ],
    async (message) => {
      recovered.push(message);
    },
  );

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.chatId, "chat-1");
  assert.equal(recovered[0]?.createdAt, 42);
  assert.equal(recovered[0]?.model, "test-model");
  assert.deepEqual(recovered[0]?.attachments, [artifact("image-1").attachment]);
  assert.deepEqual(await restarted.pending(), []);
});

test("staging is idempotent and pending usage remains chat-scoped", async () => {
  const root = await storageRoot();
  const store = new DisplayImageArtifactStore({ root: () => root });
  await store.initialize();
  const input = {
    chatId: "chat-1",
    generationId: "generation-1",
    artifact: artifact("image-1"),
    pixels: 1,
  };

  assert.equal(await store.stage(input), "inserted");
  assert.equal(await store.stage(input), "existing");
  assert.deepEqual(await store.usageByChat("chat-1"), {
    bytes: ONE_PIXEL_PNG.length,
    count: 1,
    pixels: 1,
  });
  assert.deepEqual(await store.usageByChat("chat-2"), {
    bytes: 0,
    count: 0,
    pixels: 0,
  });
});

test("startup recovery retains the only durable copy when chat storage is unresolved", async () => {
  const root = await storageRoot();
  const store = new DisplayImageArtifactStore({ root: () => root });
  await store.initialize();
  await store.stage({
    chatId: "chat-unresolved",
    generationId: "generation-1",
    artifact: artifact("image-unresolved"),
    pixels: 1,
  });
  let appended = false;

  await store.recover([], async () => {
    appended = true;
  });

  assert.equal(appended, false);
  assert.equal((await store.pending()).length, 1);
});

test("startup recovery keeps interrupted generations as separate messages", async () => {
  const root = await storageRoot();
  let now = 10;
  const store = new DisplayImageArtifactStore({
    root: () => root,
    now: () => now,
  });
  await store.initialize();
  await store.stage({
    chatId: "chat-1",
    generationId: "generation-1",
    artifact: artifact("image-1"),
    pixels: 1,
  });
  now = 20;
  await store.stage({
    chatId: "chat-1",
    generationId: "generation-2",
    artifact: artifact("image-2"),
    pixels: 1,
  });
  const recovered: RecoveredDisplayImageMessage[] = [];

  await store.recover([{ id: "chat-1", messages: [] }], async (message) => {
    recovered.push(message);
  });

  assert.equal(recovered.length, 2);
  assert.deepEqual(
    recovered.map((message) => message.attachments.map((attachment) => attachment.id)),
    [["image-1"], ["image-2"]],
  );
});

test("startup recovery accounts for persisted images before appending a stage", async () => {
  const root = await storageRoot();
  const store = new DisplayImageArtifactStore({ root: () => root });
  await store.initialize();
  await store.stage({
    chatId: "chat-1",
    generationId: "generation-1",
    artifact: artifact("pending-image"),
    pixels: 1,
  });
  const persisted = Array.from(
    { length: MAX_DISPLAY_IMAGES_PER_CHAT },
    (_, index) => artifact(`persisted-${index}`).attachment,
  );

  await assert.rejects(
    store.recover(
      [
        {
          id: "chat-1",
          messages: [{ role: "assistant", attachments: persisted }],
        },
      ],
      async () => {},
    ),
    /would exceed chat/iu,
  );
  assert.equal((await store.pending()).length, 1);
});

test("startup recovery deduplicates a payload already committed to chat history", async () => {
  const root = await storageRoot();
  const store = new DisplayImageArtifactStore({ root: () => root });
  await store.initialize();
  const staged = artifact("committed-image");
  await store.stage({
    chatId: "chat-1",
    generationId: "generation-1",
    artifact: staged,
    pixels: 1,
  });
  let appended = false;
  await store.recover(
    [
      {
        id: "chat-1",
        messages: [{ role: "assistant", attachments: [staged.attachment] }],
      },
    ],
    async () => {
      appended = true;
    },
  );
  assert.equal(appended, false);
  assert.deepEqual(await store.pending(), []);
});

test("durable staging enforces a process-wide decoded-pixel budget", async () => {
  const root = await storageRoot();
  const store = new DisplayImageArtifactStore({ root: () => root });
  await store.initialize();
  const width = 5_000;
  const height = MAX_DISPLAY_IMAGE_PIXELS / width;
  const large = Buffer.from(ONE_PIXEL_PNG);
  large.writeUInt32BE(width, 16);
  large.writeUInt32BE(height, 20);
  const accepted = Math.floor(MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT / MAX_DISPLAY_IMAGE_PIXELS);
  for (let index = 0; index < accepted; index += 1) {
    await store.stage({
      chatId: `chat-${index}`,
      generationId: `generation-${index}`,
      artifact: artifact(`image-${index}`, large),
      pixels: MAX_DISPLAY_IMAGE_PIXELS,
    });
  }
  await assert.rejects(
    store.stage({
      chatId: "chat-overflow",
      generationId: "generation-overflow",
      artifact: artifact("image-overflow", large),
      pixels: MAX_DISPLAY_IMAGE_PIXELS,
    }),
    /process-wide limit/iu,
  );
});

test("generation stages an artifact before announcing or retaining it in memory", async () => {
  const source = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "llm-client.ts"),
    "utf8",
  );
  const stage = source.indexOf("await displayImageArtifactStore.stage(");
  const retain = source.indexOf("displayedImages.push(artifact.attachment)", stage);
  const announce = source.indexOf('sendGeneration(streamId, "chat:artifact"', stage);
  assert.ok(stage >= 0 && stage < retain);
  assert.ok(retain < announce);
});

test("main blocks new sends and copies until staged artifacts are recovered", async () => {
  const handlers = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../handlers/chats.ts"),
    "utf8",
  );
  assert.match(handlers, /displayImageArtifactStore\.hasPending\(chatId\)/u);
  assert.match(handlers, /displayImageArtifactStore\.hasPending\(parsed\.chatId\)/u);
  assert.match(handlers, /Restart Aiden to recover the previous image response/iu);
  const exportHandler = handlers.slice(handlers.indexOf('ipcMain.handle("chats:export"'));
  assert.match(exportHandler, /displayImageArtifactStore\.hasPending\(chatId\)/u);
  const readHandler = handlers.slice(
    handlers.indexOf('ipcMain.handle("chats:get"'),
    handlers.indexOf('ipcMain.handle("chats:waitUntilIdle"'),
  );
  assert.ok(
    readHandler.indexOf("displayImageArtifactStore.hasPending(chatId)") <
      readHandler.indexOf("llmClient.isChatBusy(chatId)"),
  );
});

test("startup marks crash-recovered image generations as interrupted", async () => {
  const index = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../index.ts"),
    "utf8",
  );
  const recovery = index.slice(index.indexOf("displayImageArtifactStore.recover("));
  assert.match(recovery, /category: "interrupted"/u);
  assert.match(recovery, /attachments,/u);
});
