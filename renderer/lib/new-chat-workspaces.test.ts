import assert from "node:assert/strict";
import test from "node:test";
import { newChatWorkspaceChoices } from "./new-chat-workspaces";
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
