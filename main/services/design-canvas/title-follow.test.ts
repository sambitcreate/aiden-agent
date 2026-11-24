import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { addChatPage } from "../../../renderer/shared/design-canvas/chat-pages.js";
import { renamePage } from "../../../renderer/shared/design-canvas/pages.js";
import type { DesignCanvas } from "../../../renderer/shared/design-canvas/schema.js";
import { DesignCanvasStore, DesignChatCanvases, type DesignCanvasUpdated } from "./store.js";
import { createDesignTitleFollow } from "./title-follow.js";

async function setup(t: TestContext, options: { seed?: (doc: DesignCanvas) => DesignCanvas } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-title-follow-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "design-canvases");
  const store = new DesignCanvasStore({ root: () => root });
  const workspaces = new Set(["ws-1"]);
  const canvases = new DesignChatCanvases({
    store,
    workspaceIdOf: async () => "ws-1",
    workspaceExists: async (workspaceId) => workspaces.has(workspaceId),
  });
  if (options.seed) {
    await store.update("ws-1", (doc) => options.seed!(doc));
  }
  const titles = new Map<string, string>();
  const broadcasts: DesignCanvasUpdated[] = [];
  const errors: unknown[] = [];
  const follow = createDesignTitleFollow({
    canvases,
    titleOf: async (chatId) => titles.get(chatId),
    broadcast: (update) => broadcasts.push(update),
    onError: (error) => errors.push(error),
  });
  return { root, store, workspaces, titles, broadcasts, errors, follow };
}

const withChatPage = (doc: DesignCanvas) => addChatPage(doc, "chat-b", "New chat", "page-b", "page-1");

test("a chat's rename renames the page made for it and tells open canvases", async (t) => {
  const { store, titles, broadcasts, follow } = await setup(t, { seed: withChatPage });
  titles.set("chat-b", "Pricing table");
  await follow.follow("chat-b");
  const doc = await store.get("ws-1");
  assert.deepEqual(
    doc.pages.map((page) => page.name),
    ["Page 1", "Pricing table"],
  );
  assert.equal(doc.pages[1]!.namedFor, "chat-b");
  assert.deepEqual(broadcasts, [{ workspaceId: "ws-1", chatId: "chat-b", revision: doc.revision }]);
});

test("a page the person renamed no longer follows", async (t) => {
  const { store, titles, broadcasts, follow } = await setup(t, {
    seed: (doc) => renamePage(withChatPage(doc), "page-b", "Mine"),
  });
  const before = (await store.get("ws-1")).revision;
  titles.set("chat-b", "Pricing table");
  await follow.follow("chat-b");
  const doc = await store.get("ws-1");
  assert.equal(doc.pages[1]!.name, "Mine");
  assert.equal(doc.revision, before);
  assert.deepEqual(broadcasts, []);
});

test("a rename of a chat with no page made for it writes nothing", async (t) => {
  const { store, titles, broadcasts, follow } = await setup(t, { seed: withChatPage });
  const before = (await store.get("ws-1")).revision;
  titles.set("chat-a", "Northwind landing");
  await follow.follow("chat-a");
  assert.equal((await store.get("ws-1")).revision, before);
  assert.deepEqual(broadcasts, []);
});

test("a title another page already has gets a number", async (t) => {
  const { store, titles, follow } = await setup(t, { seed: withChatPage });
  titles.set("chat-b", "page 1");
  await follow.follow("chat-b");
  assert.deepEqual(
    (await store.get("ws-1")).pages.map((page) => page.name),
    ["Page 1", "page 1 2"],
  );
});

test("two quick renames and an entry running at once end on the newest title", async (t) => {
  const { store, titles } = await setup(t, { seed: withChatPage });
  const written: string[] = [];
  const original = store.update.bind(store);
  store.update = (async (workspaceId, mutate, options) => {
    const doc = await original(workspaceId, mutate, options);
    written.push(doc.pages[1]!.name);
    return doc;
  }) as typeof store.update;

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  const follower = createDesignTitleFollow({
    canvases: new DesignChatCanvases({ store, workspaceIdOf: async () => "ws-1" }),
    titleOf: async (chatId) => {
      const title = titles.get(chatId);
      // The first run reads its title, then is slow to get going.
      if (++reads === 1) await held;
      return title;
    },
    broadcast: () => undefined,
  });

  titles.set("chat-b", "First title");
  const first = follower.follow("chat-b");
  titles.set("chat-b", "Second title");
  const second = follower.follow("chat-b");
  titles.set("chat-b", "Newest title");
  const third = follower.follow("chat-b");
  release();
  await Promise.all([first, second, third]);

  assert.equal((await store.get("ws-1")).pages[1]!.name, "Newest title");
  // The two calls queued behind the first ran as one, reading the newest title.
  assert.deepEqual(written, ["First title", "Newest title"]);
  assert.equal(reads, 2);
});

test("a follow after the workspace record was removed writes nothing and logs nothing", async (t) => {
  const { store, workspaces, titles, broadcasts, errors, follow } = await setup(t, { seed: withChatPage });
  // The record goes first; the canvas file is still there until cleanup runs.
  workspaces.delete("ws-1");
  const before = await store.get("ws-1");
  titles.set("chat-b", "Pricing table");
  await follow.follow("chat-b");
  assert.deepEqual(await store.get("ws-1"), before);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(errors, [], "a chat whose workspace has no record has no canvas to follow");
});

test("a follow of a chat that is gone writes nothing", async (t) => {
  const { store, broadcasts, errors, follow } = await setup(t, { seed: withChatPage });
  const before = (await store.get("ws-1")).revision;
  await follow.follow("chat-b");
  assert.equal((await store.get("ws-1")).revision, before);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(errors, []);
});
