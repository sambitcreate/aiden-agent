import assert from "node:assert/strict";
import test from "node:test";
import { continueInWorkspaceChoices, newChatWorkspaceChoices } from "./new-chat-workspaces";
import type { Workspace } from "./types";

function workspace(id: string, name: string, createdAt: number, extra: Partial<Workspace> = {}): Workspace {
  return { id, name, folderPath: `/Users/me/${name}`, permission: "ask", createdAt, updatedAt: createdAt, ...extra };
}

const site = workspace("site", "site", 100);
const api = workspace("api", "api", 200);
const fresh = workspace("fresh", "fresh", 5_000);
const worktree = workspace("api-wt", "api", 300, {
  managedWorktree: {
    repositoryPath: "/Users/me/api",
    worktreePath: "/Users/me/.aiden/worktrees/api-fix",
    branch: "aiden/fix",
    createdFromHead: "abc123",
  },
});

test("workspaces are ordered by their latest chat, with chatless ones by when they were added", () => {
  const choices = newChatWorkspaceChoices(
    [site, api, fresh],
    [
      { workspaceId: "site", updatedAt: 1_000 },
      { workspaceId: "api", updatedAt: 9_000 },
      { workspaceId: "site", updatedAt: 3_000 },
      { updatedAt: 99_999 },
    ],
    undefined,
  );
  assert.deepEqual(
    choices.map(({ workspace, lastActivityAt }) => [workspace.id, lastActivityAt]),
    [["api", 9_000], ["fresh", 5_000], ["site", 3_000]],
  );
});

test("managed worktrees are left out and only the current workspace is marked", () => {
  const choices = newChatWorkspaceChoices(
    [site, api, worktree],
    [{ workspaceId: "api-wt", updatedAt: 50_000 }],
    "site",
  );
  assert.deepEqual(
    choices.map(({ workspace, current }) => [workspace.id, current]),
    [["api", false], ["site", true]],
  );
});

test("equal activity falls back to name order so the list is stable", () => {
  const alpha = workspace("b", "alpha", 10);
  const beta = workspace("a", "beta", 10);
  assert.deepEqual(
    newChatWorkspaceChoices([beta, alpha], [], undefined).map(({ workspace }) => workspace.name),
    ["alpha", "beta"],
  );
});

test("a chat whose folder is gone can continue in No workspace or any other workspace, never its own", () => {
  const hiddenHome = workspace("hidden-1", "hidden", 10, { noWorkspace: true });
  const hiddenLater = workspace("hidden-2", "hidden", 20, { noWorkspace: true });
  const assistant = workspace("assistant", "Assistant", 1);
  const choices = continueInWorkspaceChoices([site, api, fresh, worktree, hiddenLater, hiddenHome, assistant], "site");
  assert.deepEqual(choices, [
    { workspaceId: "hidden-1", name: "No workspace", noWorkspace: true },
    { workspaceId: "api", name: "api" },
    { workspaceId: "fresh", name: "fresh" },
  ]);
});

test("a deleted worktree's main checkout is offered first, and a No workspace chat is not offered No workspace again", () => {
  const home = workspace("default", "default", 10, { noWorkspace: true });
  assert.deepEqual(
    continueInWorkspaceChoices([site, api, fresh, worktree, home], "api-wt", "site").map(({ workspaceId }) => workspaceId),
    ["default", "site", "api", "fresh"],
  );
  assert.deepEqual(
    continueInWorkspaceChoices([site, home], "default").map(({ workspaceId }) => workspaceId),
    ["site"],
  );
  assert.deepEqual(continueInWorkspaceChoices([site], "site"), []);
});
