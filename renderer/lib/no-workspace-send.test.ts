import assert from "node:assert/strict";
import test from "node:test";
import { noWorkspaceFolderForFirstSend } from "./no-workspace-send";
import { noWorkspaceHome, workspaceChoices } from "./no-workspace";
import type { Workspace } from "./types";

function api(chatsByWorkspace: Record<string, string[]>) {
  let created = 0;
  return {
    created: () => created,
    listChats: async (workspaceId: string) => (chatsByWorkspace[workspaceId] ?? []).map((id) => ({ id })),
    createNoWorkspace: async () => ({ id: `fresh-${++created}` }),
  };
}

test("a No workspace draft keeps an unused hidden folder and never makes another", async () => {
  const fake = api({});
  assert.equal(await noWorkspaceFolderForFirstSend(fake, "hidden-1"), undefined);
  assert.equal(fake.created(), 0);
});

test("a draft in a hidden folder that already holds a chat is saved in a fresh folder", async () => {
  const fake = api({ default: ["older-chat"] });
  assert.equal(await noWorkspaceFolderForFirstSend(fake, "default"), "fresh-1");
  assert.equal(await noWorkspaceFolderForFirstSend(fake, "default"), "fresh-2", "every send gets its own");
});

const record = (id: string, createdAt: number, noWorkspace?: true): Workspace => ({
  id,
  name: noWorkspace ? "No workspace" : id,
  permission: "ask",
  createdAt,
  updatedAt: createdAt,
  ...(noWorkspace ? { noWorkspace } : {}),
});

test("the Chats group is represented by the default home, else the oldest hidden record", () => {
  const project = record("project", 1);
  assert.equal(noWorkspaceHome([project]), undefined);
  assert.equal(noWorkspaceHome([project, record("b", 9, true), record("a", 5, true)])?.id, "a");
  assert.equal(noWorkspaceHome([record("a", 5, true), record("default", 7, true)])?.id, "default");
  assert.deepEqual(workspaceChoices([project, record("a", 5, true)]).map((entry) => entry.id), ["project"]);
});
