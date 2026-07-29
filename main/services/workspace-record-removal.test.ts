import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkspaceRecordRemovalAllowed } from "./workspace-record-removal.js";
import type { Workspace } from "./types.js";

const managedWorkspace: Workspace = {
  id: "workspace-managed",
  name: "Managed",
  folderPath: "/tmp/aiden-managed",
  permission: "full",
  managedWorktree: {
    repositoryPath: "/tmp/repository",
    worktreePath: "/tmp/aiden-managed",
    branch: "codex/managed",
    worktreeGitDir: "/tmp/repository/.git/worktrees/managed",
    ownershipToken: "00000000-0000-4000-8000-000000000000",
    worktreeDevice: 1,
    worktreeInode: 2,
    createdFromHead: "a".repeat(40),
  },
  createdAt: 1,
  updatedAt: 1,
};

test("generic workspace removal cannot orphan managed-worktree recovery metadata", () => {
  assert.throws(
    () => assertWorkspaceRecordRemovalAllowed(managedWorkspace),
    /must be deleted with Delete worktree/u,
  );
});

test("ordinary and already-absent workspace records remain removable", () => {
  assert.doesNotThrow(() =>
    assertWorkspaceRecordRemovalAllowed({
      ...managedWorkspace,
      id: "workspace-folder",
      managedWorktree: undefined,
    }),
  );
  assert.doesNotThrow(() => assertWorkspaceRecordRemovalAllowed(null));
});
