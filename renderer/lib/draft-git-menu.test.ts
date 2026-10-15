import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchChipState,
  draftWorkInOptions,
  draftWorktreeHint,
  worktreeBaseNote,
  worktreeProgressText,
} from "./draft-git-menu";
import type { Workspace } from "./types";

const REPO: Workspace = {
  id: "repo",
  name: "app",
  folderPath: "/projects/app",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};

function worktree(id: string, repositoryPath: string, branch: string, updatedAt: number): Workspace {
  return {
    id,
    name: branch,
    folderPath: `/worktrees/${id}`,
    permission: "full",
    managedWorktree: { repositoryPath, worktreePath: `/worktrees/${id}`, branch, createdFromHead: "abc" },
    createdAt: 1,
    updatedAt,
  };
}

test("Work in lists only this repository's managed worktrees, most recently used first", () => {
  const other: Workspace = { ...REPO, id: "other", folderPath: "/projects/other" };
  const workspaces = [
    REPO,
    other,
    worktree("a", "/projects/app", "aiden/a", 10),
    worktree("b", "/projects/app", "aiden/b", 30),
    worktree("c", "/projects/other", "aiden/c", 50),
  ];
  const options = draftWorkInOptions(workspaces, "repo");
  assert.equal(options.source?.id, "repo");
  assert.equal(options.selectedWorktreeId, undefined);
  assert.deepEqual(
    options.worktrees.map((entry) => entry.branch),
    ["aiden/b", "aiden/a"],
  );
  assert.deepEqual(draftWorkInOptions([REPO], "repo").worktrees, [], "no worktrees, no rows");
});

test("a workspace in a subfolder of the repository still finds the repository's worktrees", () => {
  const subfolder: Workspace = { ...REPO, id: "sub", folderPath: "/projects/app/packages/web" };
  const lookalike: Workspace = { ...REPO, id: "look", folderPath: "/projects/app-old" };
  const workspaces = [subfolder, lookalike, worktree("a", "/projects/app", "aiden/a", 1)];
  assert.deepEqual(draftWorkInOptions(workspaces, "sub").worktrees.map((entry) => entry.workspaceId), ["a"]);
  assert.deepEqual(draftWorkInOptions(workspaces, "look").worktrees, [], "a sibling folder is not the repository");
});

test("a draft in a managed worktree selects it, with its registered repository as the checkout", () => {
  const workspaces = [REPO, worktree("a", "/projects/app", "aiden/a", 10), worktree("b", "/projects/app", "aiden/b", 5)];
  const options = draftWorkInOptions(workspaces, "a");
  assert.equal(options.source?.id, "repo");
  assert.equal(options.selectedWorktreeId, "a");
  assert.deepEqual(options.worktrees.map((entry) => entry.workspaceId), ["a", "b"]);

  const orphan = draftWorkInOptions([worktree("a", "/projects/gone", "aiden/a", 1)], "a");
  assert.equal(orphan.source, undefined, "no registered repository to go back to");
});

test("a folder-less or unknown workspace has no Work in choices", () => {
  assert.deepEqual(draftWorkInOptions([{ ...REPO, folderPath: undefined }], "repo"), { worktrees: [] });
  assert.deepEqual(draftWorkInOptions([REPO], "missing"), { worktrees: [] });
});

test("the branch chip reads the checkout, a new worktree, or an existing worktree", () => {
  assert.deepEqual(branchChipState({ branch: "main", uncommitted: 0 }), {
    kind: "checkout",
    label: "main",
    ariaLabel: undefined,
    changes: 0,
  });
  assert.deepEqual(branchChipState({ branch: "main", uncommitted: 1 }), {
    kind: "checkout",
    label: "main",
    ariaLabel: "main, 1 uncommitted change",
    changes: 1,
  });
  // A new worktree starts clean: this checkout's changes are not its changes.
  assert.deepEqual(
    branchChipState({ branch: "main", uncommitted: 4, draftGitMode: "worktree", baseRef: "develop" }),
    {
      kind: "new-worktree",
      label: "New worktree · from develop",
      ariaLabel: "Branch: new worktree from develop",
      changes: 0,
    },
  );
  assert.equal(
    branchChipState({ branch: "main", uncommitted: 0, draftGitMode: "worktree" }).label,
    "New worktree",
    "the base is not known yet",
  );
  assert.deepEqual(branchChipState({ branch: "aiden/fix", uncommitted: 2, managedWorktree: true }), {
    kind: "worktree",
    label: "aiden/fix",
    ariaLabel: "aiden/fix, worktree, 2 uncommitted changes",
    changes: 2,
  });
});

test("the headline hint and the progress row describe the worktree being created", () => {
  assert.equal(draftWorktreeHint("main"), "A new worktree from main will be created when you send");
  const request = { baseRef: "main", fromOrigin: true };
  assert.equal(worktreeProgressText({}, request), "Fetching origin…");
  assert.equal(worktreeProgressText({}, { ...request, fromOrigin: false }), "Creating worktree from main…");
  assert.equal(worktreeProgressText({ phase: "fetching", startPoint: "origin/main" }, request), "Fetching origin…");
  assert.equal(
    worktreeProgressText({ phase: "creating", branch: "aiden/fix-login", startPoint: "origin/main" }, request),
    "Creating worktree aiden/fix-login from origin/main…",
  );
  assert.equal(
    worktreeProgressText({ phase: "ready", branch: "aiden/fix-login", startPoint: "origin/main" }, request),
    "Worktree aiden/fix-login ready",
  );
});

test("a quiet note appears only when From origin found no upstream", () => {
  assert.equal(
    worktreeBaseNote({ baseSource: "no-upstream", baseRef: "main" }),
    "No upstream for main; started from local main",
  );
  assert.equal(worktreeBaseNote({ baseSource: "fetched", baseRef: "main" }), undefined);
  assert.equal(worktreeBaseNote({ baseSource: "local", baseRef: "main" }), undefined);
});
