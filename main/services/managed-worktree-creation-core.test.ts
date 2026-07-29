import assert from "node:assert/strict";
import test from "node:test";
import {
  commitManagedWorktreeCreation,
  ManagedWorktreeCreationError,
} from "./managed-worktree-creation-core.js";

test("a failed post-save metadata cleanup preserves the managed checkout", async () => {
  const state = {
    checkoutExists: true,
    recordExists: false,
    rollbackCalls: 0,
  };

  await assert.rejects(
    commitManagedWorktreeCreation({
      validateBeforeSave: async () => undefined,
      saveWorkspace: async () => {
        state.recordExists = true;
        return { id: "managed-1" };
      },
      validateAfterSave: () => {
        throw new Error("source invalidated");
      },
      removeWorkspaceRecord: async () => {
        throw new Error("metadata unavailable");
      },
      rollbackWorktree: async () => {
        state.rollbackCalls += 1;
        state.checkoutExists = false;
      },
    }),
    (error) =>
      error instanceof ManagedWorktreeCreationError &&
      /worktree was preserved/u.test(error.message) &&
      error.errors.some(
        (entry) => entry instanceof Error && entry.message === "source invalidated",
      ) &&
      error.errors.some(
        (entry) => entry instanceof Error && entry.message === "metadata unavailable",
      ),
  );

  assert.equal(state.recordExists, true);
  assert.equal(state.checkoutExists, true);
  assert.equal(state.rollbackCalls, 0);
});

test("a cleaned post-save record permits managed worktree rollback", async () => {
  const order: string[] = [];

  await assert.rejects(
    commitManagedWorktreeCreation({
      validateBeforeSave: async () => undefined,
      saveWorkspace: async () => {
        order.push("save");
        return { id: "managed-1" };
      },
      validateAfterSave: () => {
        throw new Error("source invalidated");
      },
      removeWorkspaceRecord: async () => {
        order.push("remove-record");
      },
      rollbackWorktree: async () => {
        order.push("rollback-worktree");
      },
    }),
    /source invalidated/u,
  );

  assert.deepEqual(order, ["save", "remove-record", "rollback-worktree"]);
});

test("pre-save and persistence failures roll back the already-created worktree", async () => {
  for (const failedStage of ["validation", "save"] as const) {
    let rollbackCalls = 0;
    await assert.rejects(
      commitManagedWorktreeCreation({
        validateBeforeSave: async () => {
          if (failedStage === "validation") throw new Error("validation failed");
        },
        saveWorkspace: async () => {
          throw new Error("save failed");
        },
        validateAfterSave: () => undefined,
        removeWorkspaceRecord: async () => undefined,
        rollbackWorktree: async () => {
          rollbackCalls += 1;
        },
      }),
      new RegExp(`${failedStage} failed`, "u"),
    );
    assert.equal(rollbackCalls, 1);
  }
});

test("successful managed workspace persistence does not roll Git back", async () => {
  let rollbackCalls = 0;
  const saved = await commitManagedWorktreeCreation({
    validateBeforeSave: async () => undefined,
    saveWorkspace: async () => ({ id: "managed-1" }),
    validateAfterSave: () => undefined,
    removeWorkspaceRecord: async () => undefined,
    rollbackWorktree: async () => {
      rollbackCalls += 1;
    },
  });
  assert.deepEqual(saved, { id: "managed-1" });
  assert.equal(rollbackCalls, 0);
});
