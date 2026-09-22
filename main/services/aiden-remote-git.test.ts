import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { AidenRemoteGitService } from "./aiden-remote-git.js";
import { AidenRemoteWorkspaceOwnerRegistry } from "./aiden-remote-workspace-owners.js";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCompare,
  gitComparisonDiff,
  gitCreateBranch,
  gitDiff,
  gitPush,
  gitPushCapability,
  gitReview,
  gitWorktrees,
} from "./git.js";
import type { Workspace } from "./types.js";
import { createWorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import { workspaceRevision } from "./aiden-remote-workspaces.js";
import { WorkspaceMutationGate } from "./workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "./workspace-operation-registry.js";

const runFile = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runFile("/usr/bin/git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

test("remote Git keeps paths and snapshot internals on the Mac and safely completes reviewed mutations", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-git-"));
  const repository = path.join(temporary, "repository");
  const bare = path.join(temporary, "remote.git");
  await fs.mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.email", "aiden@example.test");
  await git(repository, "config", "user.name", "Aiden Test");
  await fs.writeFile(path.join(repository, "App.swift"), "let value = 1\n", "utf8");
  await git(repository, "add", "App.swift");
  await git(repository, "commit", "-m", "Initial");
  await runFile("/usr/bin/git", ["init", "--bare", bare], { encoding: "utf8" });
  await git(repository, "remote", "add", "origin", bare);
  await git(repository, "push", "-u", "origin", "main");

  const workspace: Workspace = {
    id: "workspace-1",
    name: "Project",
    folderPath: repository,
    permission: "ask",
    createdAt: 1,
    updatedAt: 2,
  };
  const application = createWorkspaceEnvironmentApplicationService({
    configStore: { getWorkspace: async (id) => id === workspace.id ? workspace : undefined },
    workspaceMutationGate: new WorkspaceMutationGate(),
    workspaceOperationRegistry: new WorkspaceOperationRegistry(),
    assertManagedWorktreeAdmission: async () => undefined,
    realpath: fs.realpath,
    stat: fs.stat,
  });
  const managedWorkspace: Workspace = {
    id: "workspace-managed",
    name: "Mobile Worktree",
    folderPath: path.join(temporary, "managed"),
    permission: "ask",
    managedWorktree: {
      repositoryPath: repository,
      worktreePath: path.join(temporary, "managed"),
      branch: "feature/worktree",
      worktreeGitDir: path.join(repository, ".git", "worktrees", "managed"),
      ownershipToken: "a".repeat(64),
      worktreeDevice: 1,
      worktreeInode: 2,
      createdFromHead: "b".repeat(40),
    },
    createdAt: 3,
    updatedAt: 4,
  };
  let createWorktreeCount = 0;
  let deleteWorktreeCount = 0;
  const service = new AidenRemoteGitService({
    application,
    owners: new AidenRemoteWorkspaceOwnerRegistry(),
    git: {
      review: gitReview,
      diff: gitDiff,
      branches: gitBranches,
      checkout: gitCheckout,
      createBranch: gitCreateBranch,
      commit: gitCommit,
      pushCapability: gitPushCapability,
      push: gitPush,
      compare: gitCompare,
      comparisonDiff: gitComparisonDiff,
      worktrees: gitWorktrees,
    },
    worktrees: {
      create: async (_owner, sourceId, branch, name) => {
        assert.equal(sourceId, workspace.id);
        assert.equal(branch, "feature/worktree");
        assert.equal(name, "Mobile Worktree");
        createWorktreeCount += 1;
        return managedWorkspace;
      },
      remove: async (_owner, id, validate) => {
        assert.equal(id, managedWorkspace.id);
        validate?.(managedWorkspace);
        deleteWorktreeCount += 1;
        return { branchDeleted: true };
      },
    },
    listWorkspaces: async () => [workspace],
    persistIdempotency: async () => undefined,
  });

  try {
    await fs.writeFile(path.join(repository, "App.swift"), "let value = 2\n", "utf8");
    const review = await service.review("device-1", workspace.id);
    assert.equal(review.status, "snapshot");
    assert.equal(review.result?.kind, "review");
    if (review.result?.kind !== "review" || !review.snapshotId) throw new Error("missing review");
    const changed = review.result.files.find((file) => file.displayPath === "App.swift");
    assert.ok(changed);
    assert.match(changed.id, /^file_[A-Za-z0-9_-]{43}$/u);
    assert.equal(JSON.stringify(review).includes(repository), false);

    const diff = await service.diff("device-1", workspace.id, {
      snapshotId: review.snapshotId,
      fileId: changed.id,
    });
    assert.equal(diff.result?.kind, "diff");
    if (diff.result?.kind !== "diff") throw new Error("missing diff");
    assert.match(diff.result.diff, /value = 2/u);
    assert.equal(diff.result.diff.includes(repository), false);

    await assert.rejects(
      () => service.diff("device-2", workspace.id, {
        snapshotId: review.snapshotId,
        fileId: changed.id,
      }),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "handle_wrong_device",
    );
    await assert.rejects(
      () => service.commit("device-1", workspace.id, "commit-key-remote-0001", {
        snapshotId: review.snapshotId,
        message: "Update value",
        scope: "all-reviewed",
        confirmedForeground: false,
      }),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "permission_confirmation_required",
    );

    const commitInput = {
      snapshotId: review.snapshotId,
      message: "Update value",
      scope: "all-reviewed",
      confirmedForeground: true,
    };
    const committed = await service.commit(
      "device-1",
      workspace.id,
      "commit-key-remote-0002",
      commitInput,
    );
    const replayed = await service.commit(
      "device-1",
      workspace.id,
      "commit-key-remote-0002",
      commitInput,
    );
    assert.deepEqual(replayed, committed);
    assert.equal(await git(repository, "rev-list", "--count", "HEAD"), "2");

    const branchSnapshot = await service.branches("device-1", workspace.id);
    assert.ok(branchSnapshot.snapshotId);
    const created = await service.createBranch(
      "device-1",
      workspace.id,
      "branch-key-remote-0001",
      { name: "feature/mobile", startPoint: "main", confirmedForeground: true },
    );
    assert.equal(created.status, "succeeded");
    assert.equal(await git(repository, "branch", "--show-current"), "feature/mobile");
    await assert.rejects(
      () => service.checkout(
        "device-1",
        workspace.id,
        "checkout-key-remote-1",
        { branch: "main", snapshotId: branchSnapshot.snapshotId, confirmedForeground: true },
      ),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "operation_stale",
    );
    const freshBranches = await service.branches("device-1", workspace.id);
    await service.checkout(
      "device-1",
      workspace.id,
      "checkout-key-remote-2",
      { branch: "main", snapshotId: freshBranches.snapshotId, confirmedForeground: true },
    );
    assert.equal(await git(repository, "branch", "--show-current"), "main");

    const pushCapability = await service.pushCapability("device-1", workspace.id);
    assert.equal(pushCapability.result?.kind, "push-capability");
    if (pushCapability.result?.kind !== "push-capability" || !pushCapability.snapshotId) {
      throw new Error("missing push capability");
    }
    assert.equal(pushCapability.result.allowed, true);
    const pushed = await service.push(
      "device-1",
      workspace.id,
      "push-key-remote-000001",
      {
        snapshotId: pushCapability.snapshotId,
        remote: pushCapability.result.remote,
        branch: pushCapability.result.branch,
        confirmedForeground: true,
      },
    );
    assert.equal(pushed.status, "succeeded");
    assert.equal(await git(repository, "rev-parse", "HEAD"), await git(repository, "rev-parse", "origin/main"));

    await assert.rejects(
      () => service.createWorktree("device-1", workspace.id, "worktree-key-remote-0001", {
        branch: "feature/worktree",
        name: "Mobile Worktree",
        confirmedForeground: false,
      }),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "permission_confirmation_required",
    );
    const createInput = {
      branch: "feature/worktree",
      name: "Mobile Worktree",
      confirmedForeground: true,
    };
    const worktreeCreated = await service.createWorktree(
      "device-1",
      workspace.id,
      "worktree-key-remote-0002",
      createInput,
    );
    const worktreeReplay = await service.createWorktree(
      "device-1",
      workspace.id,
      "worktree-key-remote-0002",
      createInput,
    );
    assert.deepEqual(worktreeReplay, worktreeCreated);
    assert.equal(createWorktreeCount, 1);

    await assert.rejects(
      () => service.deleteManagedWorktree(
        "device-1",
        managedWorkspace.id,
        "rev_wrong",
        "worktree-delete-key-0001",
        { confirmedForeground: true },
      ),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "revision_conflict",
    );
    const deleted = await service.deleteManagedWorktree(
      "device-1",
      managedWorkspace.id,
      workspaceRevision(managedWorkspace),
      "worktree-delete-key-0002",
      { confirmedForeground: true },
    );
    assert.equal(deleted.result?.kind, "mutation");
    assert.equal(deleteWorktreeCount, 1);

    const worktrees = await service.worktrees("device-1", workspace.id);
    assert.equal(worktrees.result?.kind, "worktrees");
    if (worktrees.result?.kind !== "worktrees") throw new Error("missing worktrees");
    assert.deepEqual(worktrees.result.worktrees.map((entry) => entry.id), [workspace.id]);
    assert.equal(JSON.stringify(worktrees).includes(repository), false);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
