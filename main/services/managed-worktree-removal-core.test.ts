import assert from "node:assert/strict";
import test from "node:test";
import {
  ManagedWorktreeRemovalError,
  removeManagedWorkspace,
} from "./managed-worktree-removal-core.js";

test("successful destructive removal crosses the boundary before metadata cleanup", async () => {
  const order: string[] = [];
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        order.push("delete");
        return { branchDeleted: true };
      },
      workspacePathExists: async () => true,
      worktreeRegistered: async () => true,
      onDestructiveBoundary: () => {
        order.push("boundary");
      },
      removeWorkspaceRecord: async () => {
        order.push("metadata");
        throw new Error("metadata failed");
      },
    }),
    (error) =>
      error instanceof ManagedWorktreeRemovalError &&
      /Git removed the managed worktree/u.test(error.message) &&
      error.errors.some((entry) => entry instanceof Error && entry.message === "metadata failed"),
  );
  assert.deepEqual(order, ["delete", "boundary", "metadata"]);
});

test("partial Git deletion preserves metadata without inferring completion from probes", async () => {
  const order: string[] = [];
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        order.push("delete");
        throw new Error("branch cleanup failed");
      },
      workspacePathExists: async () => {
        order.push("path-probe");
        return false;
      },
      worktreeRegistered: async () => {
        order.push("git-probe");
        return false;
      },
      onDestructiveBoundary: () => {
        order.push("boundary");
      },
      removeWorkspaceRecord: async () => {
        order.push("metadata");
      },
    }),
    /branch cleanup failed/u,
  );
  assert.deepEqual(order, ["delete", "boundary"]);
});

test("Git deregistration alone cannot discard metadata while deletion rejected", async () => {
  const order: string[] = [];
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("directory cleanup failed");
      },
      workspacePathExists: async () => true,
      worktreeRegistered: async () => false,
      onDestructiveBoundary: () => {
        order.push("boundary");
      },
      removeWorkspaceRecord: async () => {
        order.push("metadata");
      },
    }),
    /directory cleanup failed/u,
  );
  assert.deepEqual(order, ["boundary"]);
});

test("partial deletion never attempts metadata cleanup", async () => {
  let crossed = false;
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("branch cleanup failed");
      },
      workspacePathExists: async () => true,
      worktreeRegistered: async () => false,
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => {
        removed = true;
      },
    }),
    /branch cleanup failed/u,
  );
  assert.equal(crossed, true);
  assert.equal(removed, false);
});

test("a rejected deletion does not consult indeterminate probes or delete metadata", async () => {
  let crossed = false;
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("delete failed");
      },
      workspacePathExists: async () => true,
      worktreeRegistered: async () => {
        throw new Error("Git inspection failed");
      },
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => {
        removed = true;
      },
    }),
    /delete failed/u,
  );
  assert.equal(crossed, true);
  assert.equal(removed, false);
});

test("a missing worktree path never authorizes metadata deletion after failure", async () => {
  let crossed = false;
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("managed worktree is unavailable");
      },
      workspacePathExists: async () => false,
      worktreeRegistered: async () => {
        throw new Error("repository is unavailable");
      },
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => {
        removed = true;
      },
    }),
    /managed worktree is unavailable/u,
  );
  assert.equal(crossed, true);
  assert.equal(removed, false);
});

test("pre-delete failure keeps the workspace reversible only when both probes are intact", async () => {
  let crossed = false;
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("dirty worktree");
      },
      destructiveMutationAttempted: () => false,
      workspacePathExists: async () => true,
      worktreeRegistered: async () => true,
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => {
        removed = true;
      },
    }),
    /dirty worktree/u,
  );
  assert.equal(crossed, false);
  assert.equal(removed, false);
});

test("an explicitly pre-mutation ownership failure never discards metadata", async () => {
  let probed = false;
  let crossed = false;
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("ownership marker is unavailable");
      },
      destructiveMutationAttempted: () => false,
      workspacePathExists: async () => {
        probed = true;
        return true;
      },
      worktreeRegistered: async () => {
        probed = true;
        return false;
      },
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => {
        removed = true;
      },
    }),
    /ownership marker is unavailable/u,
  );
  assert.equal(probed, false);
  assert.equal(crossed, false);
  assert.equal(removed, false);
});

test("a pending deletion journal preserves workspace metadata at every quarantine midpoint", async () => {
  let pathProbed = false;
  let registrationProbed = false;
  let crossed = false;
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("quarantine cleanup failed");
      },
      destructiveMutationAttempted: () => true,
      deletionPending: async () => true,
      workspacePathExists: async () => {
        pathProbed = true;
        return false;
      },
      worktreeRegistered: async () => {
        registrationProbed = true;
        return false;
      },
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => {
        removed = true;
      },
    }),
    /quarantine cleanup failed/u,
  );
  assert.equal(pathProbed, false);
  assert.equal(registrationProbed, false);
  assert.equal(crossed, true);
  assert.equal(removed, false);
});

test("an unreadable deletion journal preserves workspace metadata and schedule blocking", async () => {
  let crossed = false;
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("quarantine cleanup failed");
      },
      destructiveMutationAttempted: () => true,
      deletionPending: async () => {
        throw new Error("journal read failed");
      },
      workspacePathExists: async () => false,
      worktreeRegistered: async () => false,
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => {
        removed = true;
      },
    }),
    /quarantine cleanup failed/u,
  );
  assert.equal(crossed, true);
  assert.equal(removed, false);
});

test("a moved but registered managed identity preserves ownership despite a missing old path", async () => {
  let crossed = false;
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("managed worktree moved");
      },
      workspacePathExists: async () => false,
      worktreeRegistered: async () => true,
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => {
        removed = true;
      },
    }),
    /managed worktree moved/u,
  );
  assert.equal(crossed, true);
  assert.equal(removed, false);
});

test("a registered replacement after the destructive boundary keeps schedules paused", async () => {
  let crossed = false;
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("captured checkout changed identity");
      },
      destructiveMutationAttempted: () => true,
      workspacePathExists: async () => true,
      worktreeRegistered: async () => true,
      worktreeUsable: async () => false,
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => {
        removed = true;
      },
    }),
    /captured checkout changed identity/u,
  );
  assert.equal(crossed, true);
  assert.equal(removed, false);
});

test("a destructive failure stays paused even when later probes look restored", async () => {
  let crossed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("late file preserved");
      },
      destructiveMutationAttempted: () => true,
      workspacePathExists: async () => true,
      worktreeRegistered: async () => true,
      worktreeUsable: async () => true,
      onDestructiveBoundary: () => {
        crossed = true;
      },
      removeWorkspaceRecord: async () => undefined,
    }),
    /late file preserved/u,
  );
  assert.equal(crossed, true);
});

test("stale-looking metadata remains owned when the deletion transaction rejects", async () => {
  let removed = false;
  await assert.rejects(
    removeManagedWorkspace({
      deleteWorktree: async () => {
        throw new Error("worktree already deregistered");
      },
      workspacePathExists: async () => false,
      worktreeRegistered: async () => false,
      onDestructiveBoundary: () => undefined,
      removeWorkspaceRecord: async () => {
        removed = true;
      },
      reconciledResult: () => ({ branchDeleted: false }),
    }),
    /worktree already deregistered/u,
  );
  assert.equal(removed, false);
});
