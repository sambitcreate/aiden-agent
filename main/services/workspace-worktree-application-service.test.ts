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
    ensureSnapshotRoot: async () => "/aiden/worktree-snapshots",
    checkoutBytes: async () => 1_024,
    checkCreateCapacity: async () => undefined,
    checkSnapshotCapacity: async () => undefined,
    provisionIncludedFiles: async () => [],
    repositoryPaths: async (folderPath) => ({
      topLevel: folderPath,
      commonDir: `${folderPath}/.git`,
    }),
    dirtyState: async () => ({
      head: "b".repeat(40),
      uncommitted: 0,
      ignored: 0,
      ignoredPaths: [],
    }),
    captureWorktreeSnapshot: async () => {
      throw new Error("unexpected snapshot");
    },
    snapshotRefCommit: async () => undefined,
    restoreManagedCheckout: async () => {
      throw new Error("unexpected restore");
    },
    applyWorktreeSnapshot: async () => undefined,
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


test("dirty removal snapshots before deletion and passes the lifecycle to git", async (t) => {
  const { mkdtemp, mkdir, readFile, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const base = await mkdtemp(nodePath.join(os.tmpdir(), "aiden-svc-test-"));
  t.after(() => import("node:fs/promises").then((fs) => fs.rm(base, { force: true, recursive: true })));
  const worktreePath = nodePath.join(base, "managed");
  const repositoryPath = nodePath.join(base, "repository");
  const snapshotRoot = nodePath.join(base, "snapshots");
  await mkdir(nodePath.join(repositoryPath, ".git", "worktrees", "managed"), { recursive: true });
  await mkdir(worktreePath);
  await mkdir(snapshotRoot);
  await writeFile(nodePath.join(worktreePath, ".env"), "SECRET=1\n");

  const events: string[] = [];
  let dirty = { head: "b".repeat(40), uncommitted: 1, ignored: 1, ignoredPaths: [".env"] };
  let lifecycleSeen: unknown;
  const managed: Workspace = {
    id: "workspace-managed",
    name: "Managed",
    folderPath: worktreePath,
    permission: "ask",
    createdAt: 3,
    updatedAt: 3,
    managedWorktree: {
      repositoryPath,
      worktreePath,
      worktreeGitDir: nodePath.join(repositoryPath, ".git", "worktrees", "managed"),
      branch: "codex/managed",
      ownershipToken: "a".repeat(64),
      worktreeDevice: 1,
      worktreeInode: 2,
      createdFromHead: "b".repeat(40),
      provisionedFiles: [".env"],
    },
  };
  const signal = new AbortController().signal;
  const service = createWorkspaceWorktreeApplicationService({
    environment: {
      resolve: async () => ({ folderPath: worktreePath, workspace: managed }),
      run: async () => {
        throw new Error("source lookup unused");
      },
      runRecord: async (_owner, id, operation) => {
        assert.equal(id, managed.id);
        return operation(managed, signal);
      },
    },
    ensureWorktreeRoot: async () => nodePath.join(base, "worktrees"),
    ensureSnapshotRoot: async () => snapshotRoot,
    checkoutBytes: async () => 0,
    checkCreateCapacity: async () => undefined,
    checkSnapshotCapacity: async () => undefined,
    provisionIncludedFiles: async () => [],
    repositoryPaths: async (folderPath) => ({
      topLevel: folderPath,
      commonDir: `${folderPath}/.git`,
    }),
    dirtyState: async () => dirty,
    captureWorktreeSnapshot: async (_repo, _wt, snapshotId) => {
      events.push("capture");
      return {
        ref: `refs/aiden/snapshots/${snapshotId}`,
        commit: "c".repeat(40),
        tree: "d".repeat(40),
        head: "b".repeat(40),
      };
    },
    snapshotRefCommit: async () => undefined,
    restoreManagedCheckout: async () => {
      throw new Error("unexpected restore");
    },
    applyWorktreeSnapshot: async () => undefined,
    createWorktree: async () => {
      throw new Error("unexpected create");
    },
    rollbackWorktree: async () => undefined,
    deleteManagedWorktree: async (_managed, _signal, lifecycle) => {
      lifecycleSeen = lifecycle;
      events.push("delete-git");
      return { branchDeleted: true };
    },
    managedWorktreeDeletionPending: async () => false,
    managedWorktreeRegistered: async () => false,
    managedWorktreeUsable: async () => false,
    finalizeManagedWorktreeDeletion: async () => {
      events.push("finalize");
    },
    workspacePathExists: async () => true,
    saveWorkspace: async (workspace) => workspace,
    removeWorkspace: async () => {
      events.push("remove");
    },
    beginWorkspaceMutation: () => () => undefined,
    workspaceIsChanging: () => false,
    cancelWorkspaceOperations: async () => undefined,
    closeWorkspaceTerminals: () => undefined,
    cancelWorkspaceGeneration: async () => undefined,
    cancelWorkspaceSchedules: async () => undefined,
    resumeWorkspaceSchedules: async () => undefined,
    createWorkspaceId: () => "workspace-restored",
    now: () => 4,
    notifyChanged: () => undefined,
    logError: () => undefined,
  });

  const removed = await service.remove(owner, managed.id);
  assert.equal(removed.branchDeleted, true);
  assert.deepEqual(events, ["capture", "delete-git", "remove", "finalize"]);

  const lifecycle = lifecycleSeen as {
    snapshot: { id: string; ref: string; tree: string };
    provisionedIgnored: readonly string[];
  };
  const snapshotId = lifecycle.snapshot.id;
  assert.equal(
    lifecycle.snapshot.ref,
    `refs/aiden/snapshots/${snapshotId}`,
  );
  assert.equal(lifecycle.snapshot.tree, "d".repeat(40));
  assert.deepEqual(lifecycle.provisionedIgnored, [".env"]);

  // The durable manifest was written before deletion ran.
  const manifest = JSON.parse(
    await readFile(nodePath.join(snapshotRoot, snapshotId, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.state, "ready");
  assert.equal(manifest.workspaceId, managed.id);
  assert.deepEqual(
    manifest.provisionedFiles.map((file: { relativePath: string }) => file.relativePath),
    [".env"],
  );

  // An unknown ignored file blocks safe removal before any snapshot work.
  dirty = { head: "b".repeat(40), uncommitted: 0, ignored: 1, ignoredPaths: ["unknown.env"] };
  lifecycleSeen = undefined;
  await assert.rejects(
    service.remove(owner, managed.id),
    /ignored files Aiden did not provision/u,
  );
  assert.equal(lifecycleSeen, undefined);

  // Force still snapshots when it can.
  dirty = { head: "b".repeat(40), uncommitted: 1, ignored: 1, ignoredPaths: ["unknown.env"] };
  await service.remove(owner, managed.id, undefined, { force: true });
  const forced = lifecycleSeen as { force?: boolean; snapshot?: unknown } | undefined;
  assert.equal(forced?.force, true);
  assert.ok(forced?.snapshot);
});
