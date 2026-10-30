import assert from "node:assert/strict";
import test from "node:test";
import {
  noWorkspaceFolderForFirstSend,
  rehomeStrandedNoWorkspaceDrafts,
  releasedNoWorkspaceIds,
} from "./no-workspace-send";
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

function draftMover() {
  const moves: Record<string, string> = {};
  let created = 0;
  return {
    moves,
    created: () => created,
    api: {
      createNoWorkspace: async () => ({ id: `fresh-${++created}` }),
      moveDraft: (draftId: string, workspaceId: string) => {
        moves[draftId] = workspaceId;
      },
    },
  };
}

const draft = (id: string, workspaceId: string, sending = false) => ({ chat: { id, workspaceId }, sending });

test("deleting a No workspace chat moves drafts aimed at its released folder to the Chats home", async () => {
  const before = new Set(["default", "hidden-a"]);
  const after = [record("project", 1), record("default", 2, true)];
  const released = releasedNoWorkspaceIds(before, after);
  assert.deepEqual([...released], ["hidden-a"]);

  const mover = draftMover();
  const home = await rehomeStrandedNoWorkspaceDrafts(
    mover.api,
    [draft("fork-of-deleted", "hidden-a"), draft("project-draft", "project"), draft("saving", "hidden-a", true)],
    released,
    after,
  );
  assert.equal(home, "default");
  assert.deepEqual(mover.moves, { "fork-of-deleted": "default" }, "other drafts and a saving draft stay put");
  assert.equal(mover.created(), 0);
});

test("a stranded draft gets a new hidden folder when no Chats home is left", async () => {
  const after = [record("project", 1)];
  const released = releasedNoWorkspaceIds(new Set(["hidden-a"]), after);
  const mover = draftMover();
  assert.equal(await rehomeStrandedNoWorkspaceDrafts(mover.api, [draft("d", "hidden-a")], released, after), "fresh-1");
  assert.deepEqual(mover.moves, { d: "fresh-1" });
});

test("releasing a folder no draft uses makes nothing new", async () => {
  const after = [record("project", 1)];
  const mover = draftMover();
  const released = releasedNoWorkspaceIds(new Set(["hidden-a"]), after);
  assert.equal(await rehomeStrandedNoWorkspaceDrafts(mover.api, [draft("d", "project")], released, after), undefined);
  assert.equal(mover.created(), 0);
});
