import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { DesignRunRequest } from "../../../renderer/shared/design/types.js";
import { startDesignStudio } from "./startup-core.js";
import { DesignProjectStore, type DesignChatPort } from "./store.js";

const EXPLORE: DesignRunRequest = { op: "explore", count: 2, creativeRange: "balanced", aspects: [] };

async function tempRoot(t: TestContext): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-startup-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return path.join(parent, "design-projects");
}

function recordingChats() {
  const owners = new Map<string, string>();
  let failRemoves = 0;
  const port: DesignChatPort = {
    exists: async (chatId) => owners.has(chatId),
    ownedChatIds: async (projectId) => [...owners].filter(([, owner]) => owner === projectId).map(([id]) => id),
    create: async (chatId, projectId) => {
      owners.set(chatId, projectId);
    },
    remove: async (chatId) => {
      if (failRemoves > 0) {
        failRemoves -= 1;
        throw new Error("chat deletion interrupted");
      }
      owners.delete(chatId);
    },
  };
  return {
    port,
    owners,
    failNextRemove: () => {
      failRemoves += 1;
    },
  };
}

test("with the flag off, startup creates no directory, reads no manifest and writes no chat", async (t) => {
  const root = await tempRoot(t);
  const chats = recordingChats();
  const store = new DesignProjectStore({ root: async () => root, chats: chats.port });
  const started = await startDesignStudio({
    enabled: false,
    store,
    onError: (error) => assert.fail(String(error)),
  });
  assert.equal(started, false);
  await assert.rejects(fs.stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual(store.list(), []);
  assert.equal(chats.owners.size, 0);
});

test("with the flag on, startup marks interrupted runs and finishes an interrupted deletion", async (t) => {
  const root = await tempRoot(t);
  const chats = recordingChats();
  let counter = 0;
  const newId = () => `id-${(counter += 1)}`;
  const before = new DesignProjectStore({ root: async () => root, chats: chats.port, newId });
  await before.initialize();
  const running = await before.create({ title: "Running" });
  await before.beginRun(running.id, { runId: "run-1", turnId: "turn-1", request: EXPLORE });
  const doomed = await before.create({ title: "Doomed" });
  chats.failNextRemove();
  await assert.rejects(before.delete(doomed.id, doomed.revision), /interrupted/u);

  const after = new DesignProjectStore({ root: async () => root, chats: chats.port, newId });
  const started = await startDesignStudio({
    enabled: true,
    store: after,
    onError: (error) => assert.fail(String(error)),
  });
  assert.equal(started, true);
  assert.equal(after.get(running.id)?.runs["run-1"]?.status, "interrupted");
  assert.equal(after.get(doomed.id), undefined);
  assert.equal(chats.owners.has(doomed.chatId), false);
  await assert.rejects(fs.stat(path.join(root, doomed.id)), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("a store that cannot open is reported and the app keeps starting", async () => {
  const errors: unknown[] = [];
  const started = await startDesignStudio({
    enabled: true,
    store: {
      initialize: async () => {
        throw new Error("disk unavailable");
      },
      resumeDeletions: async () => assert.fail("must not resume deletions on a closed store"),
    },
    onError: (error) => errors.push(error),
  });
  assert.equal(started, false);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /disk unavailable/u);
});
