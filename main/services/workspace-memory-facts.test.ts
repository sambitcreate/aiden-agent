import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MemoryStore } from "./memory-store.js";
import { sharedWorkspaceScopeId } from "./memory-shared.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { createWorkspaceMemoryFacts } from "./workspace-memory-facts.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-memory-facts-"));
  let clock = 1_000;
  const store = new MemoryStore({ root: () => root, now: () => clock });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspaces = new Map<string, { id: string; folderPath?: string; noWorkspace?: true }>([
    ["project", { id: "project", folderPath: "/Users/me/project" }],
    ["scratch", { id: "scratch" }],
    ["default", { id: "default", folderPath: "/data/chat-folders/home", noWorkspace: true }],
    ["chat-b", { id: "chat-b", folderPath: "/data/chat-folders/chat-b", noWorkspace: true }],
  ]);
  const facts = createWorkspaceMemoryFacts({
    getWorkspace: async (id) => workspaces.get(id),
    store,
    now: () => clock,
  });
  return {
    store,
    facts,
    advance: (ms: number) => {
      clock += ms;
    },
    projectScope: { kind: "workspace" as const, id: sharedWorkspaceScopeId("/Users/me/project") },
    scratchScope: { kind: "workspace" as const, id: persistedChatWorkspaceId("scratch") },
  };
}

test("lists the facts a chat in that workspace can recall, newest first, with who saved them", async (t) => {
  const f = await fixture(t);
  await f.store.put({
    id: "older",
    scope: f.projectScope,
    text: "The release branch is called stable.",
    provenance: { kind: "user_edit", sourceId: "settings" },
    alwaysOn: true,
  });
  f.advance(10);
  await f.store.put({
    id: "newer",
    scope: f.projectScope,
    text: "Use pnpm in this repository.",
    provenance: { kind: "model_proposal", chatId: "chat-1", turnId: "turn-1", anchorMessageId: "m-1" },
    expiresAt: 5_000,
  });
  await f.store.put({
    id: "elsewhere",
    scope: f.scratchScope,
    text: "Scratch notes stay in scratch.",
    provenance: { kind: "user_edit", sourceId: "settings" },
  });

  assert.deepEqual(await f.facts.list("project"), [
    { id: "newer", text: "Use pnpm in this repository.", alwaysOn: false, savedBy: "aiden", updatedAt: 1_010, expiresAt: 5_000 },
    { id: "older", text: "The release branch is called stable.", alwaysOn: true, savedBy: "you", updatedAt: 1_000 },
  ]);
  assert.deepEqual((await f.facts.list("scratch")).map(({ text }) => text), ["Scratch notes stay in scratch."]);
});

test("replaced and expired facts are not listed", async (t) => {
  const f = await fixture(t);
  await f.store.put({
    id: "first",
    scope: f.projectScope,
    text: "Deploys happen on Fridays.",
    provenance: { kind: "user_edit", sourceId: "settings" },
  });
  await f.store.put({
    id: "second",
    scope: f.projectScope,
    text: "Deploys happen on Tuesdays.",
    provenance: { kind: "user_edit", sourceId: "settings" },
    supersedesId: "first",
  });
  await f.store.put({
    id: "short-lived",
    scope: f.projectScope,
    text: "The staging server is down today.",
    provenance: { kind: "user_edit", sourceId: "settings" },
    expiresAt: 2_000,
  });
  assert.deepEqual((await f.facts.list("project")).map(({ id }) => id).sort(), ["second", "short-lived"]);
  f.advance(1_000);
  assert.deepEqual((await f.facts.list("project")).map(({ id }) => id), ["second"]);
});

test("deleting a fact removes it for good and stays inside the chosen workspace", async (t) => {
  const f = await fixture(t);
  await f.store.put({
    id: "keep",
    scope: f.scratchScope,
    text: "Scratch fact.",
    provenance: { kind: "user_edit", sourceId: "settings" },
  });
  await f.store.put({
    id: "forget",
    scope: f.projectScope,
    text: "Forget me.",
    provenance: { kind: "user_edit", sourceId: "settings" },
  });
  assert.equal(await f.facts.remove("project", "keep"), false);
  assert.equal(await f.facts.remove("project", "forget"), true);
  assert.deepEqual(await f.facts.list("project"), []);
  assert.equal(await f.facts.remove("project", "forget"), false);
  assert.deepEqual((await f.facts.list("scratch")).map(({ id }) => id), ["keep"]);
  assert.equal((await f.store.search(f.projectScope, "forget")).length, 0);
});

test("unknown workspaces and malformed ids are refused", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.facts.list("missing"), /no longer exists/u);
  await assert.rejects(f.facts.list("../project"), /Invalid workspace/u);
  await assert.rejects(f.facts.list(42), /Invalid workspace/u);
  await assert.rejects(f.facts.remove("project", "a b"), /Invalid memory/u);
});

test("every No workspace chat recalls the facts the folderless default workspace saved", async (t) => {
  const f = await fixture(t);
  await f.store.put({
    id: "before-folders",
    scope: { kind: "workspace", id: "default" },
    text: "Prefers metric units.",
    provenance: { kind: "user_edit", sourceId: "settings" },
    alwaysOn: true,
  });
  for (const workspaceId of ["default", "chat-b"]) {
    assert.deepEqual((await f.facts.list(workspaceId)).map((fact) => fact.text), ["Prefers metric units."]);
  }
  assert.deepEqual(await f.facts.list("project"), []);
});
