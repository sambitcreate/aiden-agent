import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePendingManagedWorktreeDeletions } from "./managed-worktree-deletion-recovery.js";
import type { Workspace } from "./types.js";

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    folderPath: `/tmp/${id}`,
    permission: "full",
    createdAt: 1,
    updatedAt: 1,
    managedWorktree: {
      repositoryPath: `/tmp/${id}-repository`,
      worktreePath: `/tmp/${id}`,
      branch: `codex/${id}`,
      createdFromHead: "a".repeat(40),
      worktreeGitDir: `/tmp/${id}-repository/.git/worktrees/${id}`,
      ownershipToken: "00000000-0000-4000-8000-000000000000",
      worktreeDevice: 1,
      worktreeInode: 2,
    },
  };
}

test("startup recovery blocks, deletes, removes metadata, then finalizes the journal", async () => {
  const order: string[] = [];
  await reconcilePendingManagedWorktreeDeletions({
    listWorkspaces: async () => [workspace("pending"), workspace("ordinary")],
    deletionPending: async (item) => item.id === "pending",
    blockWorkspace: async (id) => {
      order.push(`block:${id}`);
    },
    deleteWorktree: async (item) => {
      order.push(`delete:${item.id}`);
    },
    removeWorkspaceRecord: async (id) => {
      order.push(`metadata:${id}`);
    },
    finalizeDeletion: async (item) => {
      order.push(`finalize:${item.id}`);
    },
    finalizeOrphanedDeletions: async () => {
      order.push("orphans");
    },
    onError: () => {
      order.push("error");
    },
  });

  assert.deepEqual(order, [
    "block:pending",
    "delete:pending",
    "metadata:pending",
    "finalize:pending",
    "orphans",
  ]);
});

test("startup recovery keeps a failed deletion blocked with metadata and journal intact", async () => {
  const order: string[] = [];
  await reconcilePendingManagedWorktreeDeletions({
    listWorkspaces: async () => [workspace("pending")],
    deletionPending: async () => true,
    blockWorkspace: async (id) => {
      order.push(`block:${id}`);
    },
    deleteWorktree: async () => {
      order.push("delete");
      throw new Error("recovery failed");
    },
    removeWorkspaceRecord: async () => {
      order.push("metadata");
    },
    finalizeDeletion: async () => {
      order.push("finalize");
    },
    finalizeOrphanedDeletions: async () => {
      order.push("orphans");
    },
    onError: (_id, error) => {
      assert.match(String(error), /recovery failed/u);
      order.push("error");
    },
  });

  assert.deepEqual(order, ["block:pending", "delete", "error", "orphans"]);
});

test("an unreadable journal blocks the workspace without attempting deletion", async () => {
  const order: string[] = [];
  await reconcilePendingManagedWorktreeDeletions({
    listWorkspaces: async () => [workspace("pending")],
    deletionPending: async () => {
      throw new Error("journal invalid");
    },
    blockWorkspace: async (id) => {
      order.push(`block:${id}`);
    },
    deleteWorktree: async () => {
      order.push("delete");
    },
    removeWorkspaceRecord: async () => {
      order.push("metadata");
    },
    finalizeDeletion: async () => {
      order.push("finalize");
    },
    finalizeOrphanedDeletions: async () => {
      order.push("orphans");
    },
    onError: (_id, error) => {
      assert.match(String(error), /journal invalid/u);
      order.push("error");
    },
  });

  assert.deepEqual(order, ["block:pending", "error", "orphans"]);
});

test("same-startup orphan sweep preserves a failed metadata removal for the next retry", async () => {
  const pending = workspace("pending");
  const token = pending.managedWorktree!.ownershipToken!;
  let records = [pending];
  let journalPresent = true;
  let metadataRemovalShouldFail = true;
  const blocked: string[] = [];
  const errors: string[] = [];
  const deletionPhases: string[] = [];

  const runStartupRecovery = () =>
    reconcilePendingManagedWorktreeDeletions({
      listWorkspaces: async () => structuredClone(records),
      deletionPending: async () => journalPresent,
      blockWorkspace: async (workspaceId) => {
        blocked.push(workspaceId);
      },
      deleteWorktree: async () => {
        assert.equal(journalPresent, true);
        deletionPhases.push("filesystem_complete");
      },
      removeWorkspaceRecord: async () => {
        if (metadataRemovalShouldFail) throw new Error("metadata persistence failed");
        records = [];
      },
      finalizeDeletion: async () => {
        journalPresent = false;
      },
      finalizeOrphanedDeletions: async (referencedOwnershipTokens) => {
        if (journalPresent && !referencedOwnershipTokens.has(token)) journalPresent = false;
      },
      onError: (_workspaceId, error) => {
        errors.push(String(error));
      },
    });

  await runStartupRecovery();
  assert.equal(journalPresent, true, "the same-startup sweep retains the retry journal");
  assert.deepEqual(records, [pending], "failed metadata persistence keeps workspace authority");
  assert.deepEqual(blocked, ["pending"], "the failed workspace remains schedule-blocked");
  assert.match(errors[0]!, /metadata persistence failed/u);

  metadataRemovalShouldFail = false;
  await runStartupRecovery();
  assert.equal(journalPresent, false, "the retry finalizes only after metadata is absent");
  assert.deepEqual(records, []);
  assert.deepEqual(blocked, ["pending", "pending"], "the next startup blocks before retrying");
  assert.deepEqual(deletionPhases, ["filesystem_complete", "filesystem_complete"]);
});
