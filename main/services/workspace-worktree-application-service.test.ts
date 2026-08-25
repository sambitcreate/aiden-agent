import assert from "node:assert/strict";
import test from "node:test";
import type { Workspace } from "./types.js";
import { createWorkspaceWorktreeApplicationService } from "./workspace-worktree-application-service.js";

const owner = {
  isDestroyed: () => false,
  onInvalidated: () => () => undefined,
};

test("shared managed-worktree workflow preserves creation rollback gates and destructive deletion ordering", async () => {
  const events: string[] = [];
  const source: Workspace = {
    id: "workspace-source",
    name: "Source",
    folderPath: "/canonical/source",
    permission: "ask",
    createdAt: 1,
    updatedAt: 2,
  };
  let managed: Workspace | undefined;
  const signal = new AbortController().signal;
  const service = createWorkspaceWorktreeApplicationService({
    environment: {
      resolve: async (id) => id === source.id
        ? { folderPath: source.folderPath!, workspace: source }
        : managed
          ? { folderPath: managed.folderPath!, workspace: managed }
          : undefined,
      run: async (_owner, id, operation) => {
        assert.equal(id, source.id);
        return operation({ folderPath: source.folderPath!, workspace: source }, signal);
      },
      runRecord: async (_owner, id, operation) => {
        assert.equal(id, managed?.id);
        return operation(managed!, signal);
      },
    },
    ensureWorktreeRoot: async () => "/aiden/worktrees",
    createWorktree: async (folderPath, root, branch) => {
      events.push(`create:${folderPath}:${root}:${branch}`);
      return {
        path: "/aiden/worktrees/mobile",
        workspacePath: "/aiden/worktrees/mobile",
        repositoryPath: "/canonical/source",
        worktreeGitDir: "/canonical/source/.git/worktrees/mobile",
        ownershipToken: "a".repeat(64),
        worktreeDevice: 1,
        worktreeInode: 2,
        createdFromHead: "b".repeat(40),
        head: "b".repeat(40),
        branch,
        bare: false,
        detached: false,
        current: false,
      };
    },
    rollbackWorktree: async () => { events.push("rollback"); },
    deleteManagedWorktree: async () => {
      events.push("delete-git");
      return { branchDeleted: true };
    },
    managedWorktreeDeletionPending: async () => false,
    managedWorktreeRegistered: async () => false,
    managedWorktreeUsable: async () => false,
    finalizeManagedWorktreeDeletion: async () => { events.push("finalize"); },
    workspacePathExists: async () => false,
    saveWorkspace: async (workspace) => {
      events.push("save");
      managed = workspace;
      return workspace;
    },
    removeWorkspace: async (id) => {
      events.push(`remove:${id}`);
      managed = undefined;
    },
    beginWorkspaceMutation: () => {
      events.push("begin-mutation");
      return () => { events.push("finish-mutation"); };
    },
    workspaceIsChanging: () => false,
    cancelWorkspaceOperations: async () => { events.push("cancel-operations"); },
    closeWorkspaceTerminals: () => { events.push("close-terminals"); },
    cancelWorkspaceGeneration: async () => { events.push("cancel-generation"); },
    cancelWorkspaceSchedules: async () => { events.push("cancel-schedules"); },
    resumeWorkspaceSchedules: async () => { events.push("resume-schedules"); },
    createWorkspaceId: () => "workspace-managed",
    now: () => 3,
    notifyChanged: () => { events.push("notify"); },
    logError: () => undefined,
  });

  const created = await service.create(owner, source.id, "feature/mobile", "Mobile Workspace");
  assert.equal(created.id, "workspace-managed");
  assert.equal(created.name, "Mobile Workspace");
  assert.equal(created.permission, source.permission);
  assert.deepEqual(events, [
    "create:/canonical/source:/aiden/worktrees:feature/mobile",
    "save",
    "notify",
  ]);

  events.length = 0;
  const removed = await service.remove(owner, created.id, (workspace) => {
    events.push(`validate:${workspace.id}`);
  });
  assert.equal(removed.branchDeleted, true);
  assert.deepEqual(events, [
    "validate:workspace-managed",
    "begin-mutation",
    "cancel-operations",
    "close-terminals",
    "cancel-generation",
    "cancel-schedules",
    "delete-git",
    "remove:workspace-managed",
    "finalize",
    "notify",
    "finish-mutation",
  ]);
});
