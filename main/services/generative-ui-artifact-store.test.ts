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

test("prepared chat copies recover to committed artifacts after chat installation", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("media-1");
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-1",
    artifact: item,
    html: HTML,
  });
  await store.commit("source-chat", [item.mediaId]);

  const [copy] = await store.prepareSelectedCopy(
    "source-chat",
    "target-chat",
    [item.mediaId],
  );
  assert.ok(copy);
  assert.equal(await store.hasPending("target-chat"), true);

  const restarted = new GenerativeUiArtifactStore({ root: () => root });
  await restarted.initialize();
  await restarted.recover(
    [{ id: "target-chat", messages: [{ role: "assistant", htmlArtifacts: [copy] }] }],
    async () => assert.fail("A prepared copy already referenced by chat must not append a message."),
  );

  assert.equal(await restarted.hasPending("target-chat"), false);
  assert.equal(await restarted.htmlFor("target-chat", copy.mediaId), HTML);
});

test("prepared chat copies are discarded when chat installation never happened", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("media-1");
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-1",
    artifact: item,
    html: HTML,
  });
  await store.commit("source-chat", [item.mediaId]);
  const [copy] = await store.prepareSelectedCopy(
    "source-chat",
    "target-chat",
    [item.mediaId],
  );
  assert.ok(copy);

  const restarted = new GenerativeUiArtifactStore({ root: () => root });
  await restarted.initialize();
  await restarted.recover([], async () => assert.fail("An orphaned copy must not be recovered."));

  assert.equal(await restarted.hasPending("target-chat"), false);
  assert.equal(await restarted.htmlFor("target-chat", copy.mediaId), undefined);
  assert.equal(await restarted.htmlFor("source-chat", item.mediaId), HTML);
});

test("preparing a copy fails atomically when any source artifact is missing", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root });
  await store.initialize();
  const item = artifact("media-1");
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-1",
    artifact: item,
    html: HTML,
  });
  await store.commit("source-chat", [item.mediaId]);

  await assert.rejects(
    store.prepareSelectedCopy("source-chat", "target-chat", [item.mediaId, "missing"]),
    /could not be copied/iu,
  );
  assert.equal(await store.hasPending("target-chat"), false);
});

test("unreadable durable HTML storage remains in place and blocks mutations", async () => {
  const root = await storageRoot();
  const file = path.join(root, "generative-ui-artifacts.json");
  await fs.writeFile(file, "{", "utf8");
  const store = new GenerativeUiArtifactStore({ root: () => root });

  await store.initialize();

  assert.deepEqual(store.availability(), {
    available: false,
    reason: "Generative UI artifact staging is unreadable.",
  });
  assert.equal(await fs.readFile(file, "utf8"), "{");
  assert.equal(await store.hasPending("chat-1"), true);
  await assert.rejects(
    store.stage({
      chatId: "chat-1",
      generationId: "generation-1",
      artifact: artifact("media-1"),
      html: HTML,
    }),
    /unreadable/iu,
  );
  assert.equal(await fs.readFile(file, "utf8"), "{");
});

test("unsupported durable HTML storage is never replaced with an empty database", async () => {
  const root = await storageRoot();
  const file = path.join(root, "generative-ui-artifacts.json");
  const unsupported = JSON.stringify({ version: 99, revision: 0, records: [] });
  await fs.writeFile(file, unsupported, "utf8");
  const store = new GenerativeUiArtifactStore({ root: () => root });

  await store.initialize();

  assert.deepEqual(store.availability(), {
    available: false,
    reason: "Generative UI artifact staging has an unsupported shape.",
  });
  assert.equal(await fs.readFile(file, "utf8"), unsupported);
  await assert.rejects(store.htmlFor("chat-1", "media-1"), /unsupported shape/iu);
});
