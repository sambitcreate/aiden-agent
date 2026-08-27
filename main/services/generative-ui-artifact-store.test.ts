import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GenerativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";

const HTML = "<p>hello</p>";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function storageRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-html-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function artifact(id: string, title = "Chart"): ChatHtmlArtifactV1 {
  return {
    version: 1,
    kind: "html",
    id,
    title,
    mimeType: "text/html",
    size: Buffer.byteLength(HTML, "utf8"),
    mediaId: id,
  };
}

test("staging, commit, recovery, and pending gates", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("media-1");
  assert.equal(
    await store.stage({
      chatId: "chat-1",
      generationId: "gen-1",
      model: "test-model",
      artifact: item,
      html: HTML,
    }),
    "inserted",
  );
  assert.equal(await store.hasPending("chat-1"), true);
  const recovered: Array<{ chatId: string; htmlArtifacts: ChatHtmlArtifactV1[] }> = [];
  await store.recover(
    [{ id: "chat-1", messages: [] }],
    async (message) => {
      recovered.push(message);
    },
  );
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.htmlArtifacts[0]?.mediaId, "media-1");
  assert.equal(await store.hasPending("chat-1"), false);
  assert.equal(await store.htmlFor("chat-1", "media-1"), HTML);
});

test("chat HTML quotas refuse extra staged artifacts", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root });
  await store.initialize();
  for (let index = 0; index < 40; index += 1) {
    const id = `media-${index}`;
    await store.stage({
      chatId: "chat-1",
      generationId: `gen-${index}`,
      artifact: artifact(id, `Title ${index}`),
      html: HTML,
    });
  }
  await assert.rejects(
    store.stage({
      chatId: "chat-1",
      generationId: "overflow",
      artifact: artifact("overflow", "Overflow"),
      html: HTML,
    }),
    /artifact limit/iu,
  );
});

test("recovery isolates a failing chat without blocking others", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  await store.stage({
    chatId: "chat-fail",
    generationId: "gen-1",
    artifact: artifact("fail-1"),
    html: HTML,
  });
  await store.stage({
    chatId: "chat-ok",
    generationId: "gen-1",
    artifact: artifact("ok-1"),
    html: HTML,
  });
  const recovered: string[] = [];
  await assert.rejects(
    store.recover(
      [
        { id: "chat-fail", messages: [] },
        { id: "chat-ok", messages: [] },
      ],
      async (message) => {
        if (message.chatId === "chat-fail") throw new Error("append failed");
        recovered.push(message.chatId);
      },
    ),
    /append failed/u,
  );
  assert.deepEqual(recovered, ["chat-ok"]);
  assert.equal(await store.hasPending("chat-ok"), false);
  assert.equal(await store.hasPending("chat-fail"), true);
});

test("reconcilePersisted commits staged rows already on the chat", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("media-1");
  await store.stage({
    chatId: "chat-1",
    generationId: "gen-1",
    artifact: item,
    html: HTML,
  });
  await store.reconcilePersisted({
    id: "chat-1",
    messages: [{ role: "assistant", htmlArtifacts: [item] }],
  });
  assert.equal(await store.hasPending("chat-1"), false);
});
