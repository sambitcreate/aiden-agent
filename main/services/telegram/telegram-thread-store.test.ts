import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createTelegramThreadStore } from "./telegram-thread-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("thread targets persist, reconcile by workspace, and stay profile-scoped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-telegram-threads-"));
  roots.push(root);
  const store = createTelegramThreadStore({ root: () => root, profile: "work" });
  await store.upsert({ threadId: 10, chatId: 7, name: "One", workspaceId: "one", createdAt: 1 });
  await store.upsert({ threadId: 11, chatId: 7, name: "Two", workspaceId: "two", createdAt: 2 });
  assert.equal((await store.find(10))?.workspaceId, "one");
  await store.retainWorkspaces(new Set(["two"]), 7);
  assert.deepEqual((await store.list()).map(({ workspaceId }) => workspaceId), ["two"]);
  const disk = JSON.parse(await readFile(path.join(root, "telegram-threads-work.json"), "utf8"));
  assert.equal(disk.targets[0].threadId, 11);
  await store.clear();
  assert.deepEqual(await store.list(), []);
});
