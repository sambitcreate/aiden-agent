import { MAX_PROVISIONED_BYTES } from "./managed-worktree-provisioner.js";
import { WorktreeCapacityUnavailableError, WORKTREE_GIT_METADATA_BYTES } from "./managed-worktree-capacity.js";
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
  const createAdmissions: Array<[string, number]> = [];
  const allocations: Array<[string, string, number]> = [];
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
    checkCreateCapacity: async (root, bytes) => { createAdmissions.push([root, bytes]); },
    checkWorktreeAllocation: async (root, common, bytes) => { allocations.push([root, common, bytes]); },
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
    expandIgnoredPaths: async (_repo, _worktree, ignoredPaths) => ignoredPaths.slice(),
    snapshotContentBytes: async () => 0,
    captureWorktreeSnapshot: async () => {
      throw new Error("unexpected snapshot");
    },
    snapshotRefCommit: async () => undefined,
    deleteSnapshotRef: async () => true,
    restoreManagedCheckout: async () => {
      throw new Error("unexpected restore");
    },
    resumeManagedCheckout: async () => {
      throw new Error("unexpected resume");
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
  assert.deepEqual(allocations, [["/aiden/worktrees", "/canonical/source/.git", 1024 + MAX_PROVISIONED_BYTES]]);
  assert.deepEqual(createAdmissions, [["/aiden/worktrees/mobile", MAX_PROVISIONED_BYTES]]);
});


test("dirty removal snapshots before deletion, admits Git objects on the object store volume, and lets force skip the advisory ignored scan", async (t) => {
  const { mkdtemp, mkdir, readdir, readFile, stat, writeFile } = await import("node:fs/promises");
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
  const worktreeIdentity = await stat(worktreePath);

  const events: string[] = [];
  const capacityPaths: string[] = [];
  const deletedRefs: Array<{ snapshotId: string; expectedCommit: string }> = [];
  let expandedCalls = 0;
  let failExpansion = false;
  let failClock = false;
  let failRefDelete = false;
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
      worktreeDevice: worktreeIdentity.dev,
      worktreeInode: worktreeIdentity.ino,
      createdFromHead: "b".repeat(40),
      provisionedFiles: [".env"],
    },
  };
  const restoreAdmissions: Array<[string, number]> = [];
  const estimateCalls: Array<string | undefined> = [];
  const signal = new AbortController().signal;
  const service = createWorkspaceWorktreeApplicationService({
    environment: {
      resolve: async () => ({ folderPath: worktreePath, workspace: managed }),
      run: async (_owner, _id, operation) => operation({
        folderPath: repositoryPath,
        workspace: { ...managed, folderPath: repositoryPath, managedWorktree: undefined },
      }, signal),
      runRecord: async (_owner, id, operation) => {
        assert.equal(id, managed.id);
        return operation(managed, signal);
      },
    },
    ensureWorktreeRoot: async () => nodePath.join(base, "worktrees"),
    ensureSnapshotRoot: async () => snapshotRoot,
    checkoutBytes: async (_root, commit) => {
      estimateCalls.push(commit);
      return commit === "b".repeat(40) ? 100 : 200;
    },
    checkCreateCapacity: async (root, bytes) => { restoreAdmissions.push([root, bytes]); },
    checkWorktreeAllocation: async (root, common, bytes) => {
      restoreAdmissions.push([root, bytes], [common, WORKTREE_GIT_METADATA_BYTES]);
      throw new WorktreeCapacityUnavailableError();
    },
    checkSnapshotCapacity: async (dir) => {
      capacityPaths.push(dir);
      return undefined;
    },
    provisionIncludedFiles: async () => [],
    repositoryPaths: async (folderPath) => ({
      topLevel: folderPath,
      commonDir: `${folderPath}/.git`,
    }),
    dirtyState: async () => dirty,
    expandIgnoredPaths: async (_repo, _worktree, ignoredPaths) => {
      expandedCalls += 1;
      // Mirrors a large ignored tree exceeding Git's bounded output buffer.
      if (failExpansion) throw new Error("git output limit exceeded");
      return ignoredPaths.slice();
    },
    snapshotContentBytes: async () => 0,
    captureWorktreeSnapshot: async (_repo, _wt, snapshotId) => {
      events.push("capture");
      return {
        ref: `refs/aiden/snapshots/${snapshotId}`,
        commit: "c".repeat(40),
        tree: "d".repeat(40),
        head: "b".repeat(40),
      };
    },
    snapshotRefCommit: async () => "c".repeat(40),
    deleteSnapshotRef: async (_repositoryPath, snapshotId, expectedCommit) => {
      deletedRefs.push({ snapshotId, expectedCommit });
      return !failRefDelete;
    },
    restoreManagedCheckout: async () => {
      throw new Error("unexpected restore");
    },
    resumeManagedCheckout: async () => {
      throw new Error("unexpected resume");
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
    // Fault injection: the removal path reads the clock exactly once, for the
    // snapshot manifest's `createdAt`, so failing that read fails manifest
    // publication after the synthetic ref and private blobs already exist.
    now: () => {
      if (failClock) throw new Error("clock unavailable");
      return 4;
    },
    notifyChanged: () => undefined,
    logError: () => undefined,
  });

  const removed = await service.remove(owner, managed.id);
  assert.equal(removed.branchDeleted, true);
  assert.deepEqual(events, ["capture", "delete-git", "remove", "finalize"]);
  // The safe path classifies ignored records before deleting.
  assert.equal(expandedCalls, 1);
  // Git objects are written through the repository's common directory, so the
  // object-byte share is admitted against that filesystem, not the checkout's.
  assert.ok(capacityPaths.includes(`${repositoryPath}/.git`));
  assert.ok(!capacityPaths.includes(repositoryPath));

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

  // Restore budgets both captured trees and the private payload on their own
  // volumes before any journal/checkout write. A denial preserves recovery.
  await assert.rejects(service.restore(owner, "source", snapshotId), WorktreeCapacityUnavailableError);
  assert.deepEqual(restoreAdmissions, [
    [nodePath.join(base, "worktrees"), 300 + manifest.provisionedFiles[0].size],
    [`${repositoryPath}/.git`, WORKTREE_GIT_METADATA_BYTES],
  ]);
  assert.equal(JSON.parse(await readFile(nodePath.join(snapshotRoot, snapshotId, "manifest.json"), "utf8")).state, "ready");
  await assert.rejects(readFile(nodePath.join(snapshotRoot, snapshotId, "restore.json")), { code: "ENOENT" });

  // A crash after applying the Git tree only needs private payload capacity.
  // Even though the fake Git volume always refuses admission, this retry reaches
  // ownership validation without querying its capacity or re-estimating trees.
  restoreAdmissions.length = 0;
  estimateCalls.length = 0;
  await writeFile(nodePath.join(snapshotRoot, snapshotId, "restore.json"), JSON.stringify({
    version: 1, phase: "snapshot_applied", snapshotId, workspaceId: "restored",
    worktreePath, worktreeGitDir: managed.managedWorktree!.worktreeGitDir,
    ownershipToken: managed.managedWorktree!.ownershipToken,
    worktreeDevice: worktreeIdentity.dev, worktreeInode: worktreeIdentity.ino,
  }));
  await assert.rejects(service.restore(owner, "source", snapshotId), /partially restored managed worktree could not be verified/);
  assert.deepEqual(restoreAdmissions, [[nodePath.dirname(worktreePath), manifest.provisionedFiles[0].size]]);
  assert.deepEqual(estimateCalls, []);

  // An unknown ignored file blocks safe removal before any snapshot work.
  dirty = { head: "b".repeat(40), uncommitted: 0, ignored: 1, ignoredPaths: ["unknown.env"] };
  lifecycleSeen = undefined;
  await assert.rejects(
    service.remove(owner, managed.id),
    /ignored files Aiden did not provision/u,
  );
  assert.equal(lifecycleSeen, undefined);

  // Force still snapshots when it can, and it must not run the advisory
  // ignored-path expansion at all: a confirmed destructive removal cannot be
  // blocked by a scan whose failure mode is an output-limit error.
  dirty = { head: "b".repeat(40), uncommitted: 1, ignored: 1, ignoredPaths: ["unknown.env"] };
  const expansionsBeforeForce = expandedCalls;
  failExpansion = true;
  await service.remove(owner, managed.id, undefined, { force: true });
  assert.equal(expandedCalls, expansionsBeforeForce);
  const forced = lifecycleSeen as { force?: boolean; snapshot?: unknown } | undefined;
  assert.equal(forced?.force, true);
  assert.ok(forced?.snapshot);

  // A snapshot that cannot publish its manifest must not leave the synthetic ref
  // or its private blobs behind.
  dirty = { head: "b".repeat(40), uncommitted: 1, ignored: 1, ignoredPaths: [".env"] };
  failExpansion = false;
  deletedRefs.length = 0;
  const snapshotsBefore = new Set(await readdir(snapshotRoot));
  failClock = true;
  await assert.rejects(service.remove(owner, managed.id), /clock unavailable/u);
  assert.equal(deletedRefs.length, 1);
  assert.equal(deletedRefs[0]?.expectedCommit, "c".repeat(40));
  assert.deepEqual(
    (await readdir(snapshotRoot)).filter((entry) => !snapshotsBefore.has(entry)),
    [],
  );

  // A failed CAS rollback preserves the private directory and stops even a
  // forced deletion, so an orphaned ref cannot be mistaken for a clean retry.
  const deletionsBefore = events.filter((event) => event === "delete-git").length;
  failRefDelete = true;
  await assert.rejects(
    service.remove(owner, managed.id, undefined, { force: true }),
    /left artifacts requiring review/u,
  );
  assert.equal(events.filter((event) => event === "delete-git").length, deletionsBefore);
  assert.equal((await readdir(snapshotRoot)).length, snapshotsBefore.size + 1);
});

test("snapshot transfers canonicalize aliased identity paths without accepting replacement roots", async (t) => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { transferManagedWorktreeFile, ManagedWorktreeFileIoError } = await import("./managed-worktree-file-io.js");
  const base = await fs.mkdtemp(path.join("/tmp", "aiden-transfer-alias-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const original = path.join(base, "original");
  const alias = path.join(base, "alias");
  const snapshot = path.join(base, "snapshot");
  await fs.mkdir(original);
  await fs.mkdir(snapshot);
  await fs.symlink(original, alias);
  await fs.writeFile(path.join(original, ".env"), "SECRET=1\n");
  const metadata = await fs.stat(original, { bigint: true });
  const identity = { path: original, device: String(metadata.dev), inode: String(metadata.ino) };
  const copied = await transferManagedWorktreeFile({
    operation: "copy", sourceRoot: alias, sourceIdentity: identity, sourceRelativePath: ".env",
    destinationRoot: snapshot, destinationRelativePath: "blob", byteLimit: 1024, mode: 0o600,
  });
  assert.equal(await fs.readFile(path.join(snapshot, "blob"), "utf8"), "SECRET=1\n");
  await transferManagedWorktreeFile({
    operation: "restore", sourceRoot: snapshot, sourceRelativePath: "blob",
    destinationRoot: alias, destinationIdentity: identity, destinationRelativePath: "restored.env",
    byteLimit: copied.size, digest: copied.digest, mode: 0o600,
  });
  assert.equal(await fs.readFile(path.join(original, "restored.env"), "utf8"), "SECRET=1\n");
  // An arbitrary alias to the SAME inode must fail in the wrapper too.
  const ancestor = path.join(base, "ancestor");
  await fs.symlink(base, ancestor);
  for (const unsafePath of [alias, path.join(ancestor, "original")]) {
    await assert.rejects(transferManagedWorktreeFile({
      operation: "copy", sourceRoot: unsafePath, sourceIdentity: { ...identity, path: unsafePath }, sourceRelativePath: ".env",
      destinationRoot: snapshot, destinationRelativePath: "unsafe", byteLimit: 1024, mode: 0o600,
    }), (error: unknown) => error instanceof ManagedWorktreeFileIoError && error.code === "unsafe_source");
    await assert.rejects(transferManagedWorktreeFile({
      operation: "restore", sourceRoot: snapshot, sourceRelativePath: "blob",
      destinationRoot: unsafePath, destinationIdentity: { ...identity, path: unsafePath }, destinationRelativePath: "unsafe.env",
      byteLimit: copied.size, digest: copied.digest, mode: 0o600,
    }), (error: unknown) => error instanceof ManagedWorktreeFileIoError && error.code === "unsafe_destination");
  }
  await fs.rename(original, path.join(base, "held"));
  await fs.mkdir(original);
  await fs.writeFile(path.join(original, ".env"), "OUTSIDE=1\n");
  await assert.rejects(transferManagedWorktreeFile({
    operation: "copy", sourceRoot: alias, sourceIdentity: identity, sourceRelativePath: ".env",
    destinationRoot: snapshot, destinationRelativePath: "outside", byteLimit: 1024, mode: 0o600,
  }), (error: unknown) => error instanceof ManagedWorktreeFileIoError && error.code === "unsafe_source");
  await assert.rejects(transferManagedWorktreeFile({
    operation: "restore", sourceRoot: snapshot, sourceRelativePath: "blob",
    destinationRoot: alias, destinationIdentity: identity, destinationRelativePath: "outside.env",
    byteLimit: copied.size, digest: copied.digest, mode: 0o600,
  }), (error: unknown) => error instanceof ManagedWorktreeFileIoError && error.code === "unsafe_destination");
  assert.deepEqual(await fs.readdir(original), [".env"]);
  assert.deepEqual(await fs.readdir(snapshot), ["blob"]);
  await fs.rm(original, { recursive: true });
  await assert.rejects(transferManagedWorktreeFile({
    operation: "copy", sourceRoot: alias, sourceIdentity: identity, sourceRelativePath: ".env",
    destinationRoot: snapshot, destinationRelativePath: "missing", byteLimit: 1024, mode: 0o600,
  }), (error: unknown) => error instanceof ManagedWorktreeFileIoError && error.code === "unsafe_source");
  await assert.rejects(transferManagedWorktreeFile({
    operation: "restore", sourceRoot: snapshot, sourceRelativePath: "blob",
    destinationRoot: alias, destinationIdentity: identity, destinationRelativePath: "missing.env",
    byteLimit: copied.size, digest: copied.digest, mode: 0o600,
  }), (error: unknown) => error instanceof ManagedWorktreeFileIoError && error.code === "unsafe_destination");
});
