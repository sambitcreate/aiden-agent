import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { assertManagedWorktreeAdmission } from "./managed-worktree-admission.js";
import type { Workspace } from "./types.js";

async function fixture(t: test.TestContext): Promise<{
  workspace: Workspace;
  worktreePath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-worktree-admission-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = path.join(root, "repository");
  const worktreePath = path.join(root, "worktree");
  const workspacePath = path.join(worktreePath, "packages", "app");
  const worktreeGitDir = path.join(repositoryPath, ".git", "worktrees", "app");
  await fs.mkdir(repositoryPath, { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(worktreeGitDir, { recursive: true });
  const checkoutIdentity = await fs.lstat(worktreePath);
  return {
    worktreePath,
    workspace: {
      id: "workspace-1",
      name: "Managed",
      folderPath: workspacePath,
      permission: "full",
      managedWorktree: {
        repositoryPath,
        worktreePath,
        branch: "codex/managed",
        worktreeGitDir,
        ownershipToken: "00000000-0000-4000-8000-000000000000",
        worktreeDevice: checkoutIdentity.dev,
        worktreeInode: checkoutIdentity.ino,
        createdFromHead: "a".repeat(40),
      },
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

test("admits only the exact marked registration and nested workspace scope", async (t) => {
  const { workspace } = await fixture(t);
  let calls = 0;
  let pendingCalls = 0;
  await assertManagedWorktreeAdmission(
    workspace,
    async (...args) => {
      calls += 1;
      assert.deepEqual(args, [
        workspace.managedWorktree?.repositoryPath,
        workspace.managedWorktree?.worktreePath,
        workspace.managedWorktree?.branch,
        workspace.managedWorktree?.worktreeGitDir,
        workspace.managedWorktree?.ownershipToken,
        workspace.managedWorktree?.worktreeDevice,
        workspace.managedWorktree?.worktreeInode,
      ]);
      return true;
    },
    async (...args) => {
      pendingCalls += 1;
      assert.deepEqual(args, [
        workspace.managedWorktree?.worktreePath,
        workspace.managedWorktree?.worktreeGitDir,
        workspace.managedWorktree?.ownershipToken,
      ]);
      return false;
    },
  );
  assert.equal(calls, 1);
  assert.equal(pendingCalls, 1);
});

test("a durable deletion intent closes managed-worktree authority before usability checks", async (t) => {
  const { workspace } = await fixture(t);
  let usabilityChecks = 0;
  await assert.rejects(
    assertManagedWorktreeAdmission(
      workspace,
      async () => {
        usabilityChecks += 1;
        return true;
      },
      async () => true,
    ),
    /no longer available/u,
  );
  assert.equal(usabilityChecks, 0);
});

test("fails closed for markerless, unregistered, escaped, and symlink-replaced workspaces", async (t) => {
  const { workspace, worktreePath } = await fixture(t);
  const verifier = async () => true;

  await assert.rejects(
    assertManagedWorktreeAdmission(
      {
        ...workspace,
        managedWorktree: { ...workspace.managedWorktree!, ownershipToken: undefined },
      },
      verifier,
    ),
    /no longer available/u,
  );
  await assert.rejects(
    assertManagedWorktreeAdmission(workspace, async () => false),
    /no longer available/u,
  );
  await assert.rejects(
    assertManagedWorktreeAdmission(
      { ...workspace, folderPath: path.dirname(worktreePath) },
      verifier,
    ),
    /no longer available/u,
  );

  const outside = path.join(path.dirname(worktreePath), "replacement");
  await fs.mkdir(outside);
  const linked = path.join(worktreePath, "linked");
  await fs.symlink(outside, linked);
  await assert.rejects(
    assertManagedWorktreeAdmission({ ...workspace, folderPath: linked }, verifier),
    /no longer available/u,
  );
});
