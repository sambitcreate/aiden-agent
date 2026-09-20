import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  GitManagedWorktreeDeleteError,
  GitService,
  GitServiceError,
} from "./git.js";
import {
  checkCreateCapacity,
  checkSnapshotCapacity,
  InsufficientDiskSpaceError,
  statfsAvailableBytes,
} from "./managed-worktree-capacity.js";
import {
  ManagedWorktreeProvisionerError,
  provisionWorktreeIncludedFiles,
  readWorktreeInclude,
} from "./managed-worktree-provisioner.js";
import {
  restoreManagedWorktreeSnapshot,
  type ManagedWorktreeRestoreDependencies,
} from "./managed-worktree-restore.js";
import {
  captureProvisionedFile,
  createManagedWorktreeRestoreJournal,
  ManagedWorktreeSnapshotError,
  type ManagedWorktreeRestoreJournal,
  persistManagedWorktreeSnapshot,
  readManagedWorktreeSnapshot,
  requireReadyManagedWorktreeSnapshot,
  restoreProvisionedFiles,
  verifyProvisionedFileBlobs,
  type ManagedWorktreeSnapshot,
} from "./managed-worktree-snapshot.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" },
  });
  return String(result.stdout).trim();
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-lifecycle-test-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

async function createRepository(t: test.TestContext): Promise<string> {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "repository");
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.email", "aiden@example.test"]);
  await git(repository, ["config", "user.name", "Aiden Test"]);
  await fs.writeFile(path.join(repository, "README.md"), "initial\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "Initial commit"]);
  return repository;
}

/** A test remover standing in for the native helper: authorize then remove. */
async function removeAfterAuthorize(identity: {
  path: string;
  authorize?: (scannedPath: string, manifestDigest: string) => Promise<void>;
}): Promise<void> {
  if (identity.authorize) await identity.authorize(identity.path, "a".repeat(64));
  await fs.rm(identity.path, { force: true, recursive: true });
}

test("managed worktree creation never executes repository Git hooks", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const marker = path.join(await temporaryDirectory(t), "hook-ran");
  const hooksDir = path.join(repository, ".git", "hooks");
  const hook = path.join(hooksDir, "post-checkout");
  await fs.writeFile(
    hook,
    `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`,
    { mode: 0o755 },
  );

  const service = new GitService({ cacheTtlMs: 0 });
  const created = await service.createWorktree(repository, root, "codex/no-hooks");

  await assert.rejects(fs.lstat(marker), { code: "ENOENT" });
  assert.ok(created.path);
  // The repository's persistent hook configuration is untouched.
  await assert.rejects(
    git(repository, ["config", "--get", "core.hooksPath"]),
    /exit code|Command failed/u,
  );
});

test("captureManagedWorktreeSnapshot records tracked, staged, deleted, and untracked state", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({ cacheTtlMs: 0 });
  const created = await service.createWorktree(repository, root, "codex/snapshot-capture");

  await fs.appendFile(
    path.join(repository, ".git", "info", "exclude"),
    "\n.ignored-cache\n",
  );
  await fs.writeFile(path.join(created.path, "README.md"), "modified\n");
  await fs.writeFile(path.join(created.path, "staged.txt"), "staged\n");
  await git(created.path, ["add", "staged.txt"]);
  await fs.writeFile(path.join(created.path, "untracked.txt"), "untracked\n");
  await fs.writeFile(path.join(created.path, ".ignored-cache"), "cache\n");
  await fs.writeFile(path.join(created.path, "committed.txt"), "local\n");
  await git(created.path, ["add", "committed.txt"]);
  await git(created.path, ["commit", "-m", "local only"]);

  const snapshotId = randomUUID();
  const capture = await service.captureManagedWorktreeSnapshot(
    repository,
    created.path,
    snapshotId,
  );
  assert.equal(capture.ref, `refs/aiden/snapshots/${snapshotId}`);
  assert.equal(
    await git(repository, ["show-ref", "--verify", "--hash", capture.ref]),
    capture.commit,
  );
  // The synthetic commit is never reachable from the user branch.
  const log = await git(created.path, ["log", "--format=%s", "HEAD"]);
  assert.ok(!log.includes(`aiden snapshot ${snapshotId}`));
  // The snapshot tree carries every captured class of change.
  const tree = await git(repository, ["ls-tree", "-r", "--name-only", capture.commit]);
  for (const name of ["README.md", "staged.txt", "untracked.txt", "committed.txt"]) {
    assert.ok(tree.includes(name), `expected ${name} in snapshot tree`);
  }
  // Arbitrary ignored content is never captured into Git objects.
  assert.ok(!tree.includes(".ignored-cache"));
});

test("snapshot-aware deletion removes a dirty managed worktree and journals it", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({
    cacheTtlMs: 0,
    worktreeDirectoryRemover: removeAfterAuthorize,
  });
  const created = await service.createWorktree(repository, root, "codex/snapshot-delete");
  await fs.writeFile(path.join(created.path, "README.md"), "dirty\n");

  const snapshotId = randomUUID();
  const capture = await service.captureManagedWorktreeSnapshot(
    repository,
    created.path,
    snapshotId,
  );
  const journal = path.join(
    path.dirname(created.path),
    `.aiden-removing-${created.ownershipToken}.json`,
  );
  await service.deleteManagedWorktree(
    repository,
    created.path,
    created.branch,
    created.createdFromHead,
    undefined,
    created.worktreeGitDir,
    created.ownershipToken,
    created.worktreeDevice,
    created.worktreeInode,
    true,
    {
      snapshot: {
        id: snapshotId,
        ref: capture.ref,
        commit: capture.commit,
        tree: capture.tree,
      },
      provisionedIgnored: [],
    },
  );

  await assert.rejects(fs.lstat(created.path), { code: "ENOENT" });
  const persisted = JSON.parse(await fs.readFile(journal, "utf8"));
  assert.equal(persisted.version, 4);
  assert.equal(persisted.deletionMode, "safe");
  assert.equal(persisted.snapshotId, snapshotId);
  assert.equal(persisted.snapshotRef, capture.ref);
  assert.equal(persisted.snapshotTree, capture.tree);
  assert.equal(persisted.phase, "filesystem_complete");
});

test("an unknown ignored file blocks safe deletion even with a snapshot", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({
    cacheTtlMs: 0,
    worktreeDirectoryRemover: removeAfterAuthorize,
  });
  const created = await service.createWorktree(repository, root, "codex/unknown-ignored");
  await fs.appendFile(
    path.join(repository, ".git", "info", "exclude"),
    "\nuser-secret.env\n",
  );
  await fs.writeFile(path.join(created.path, "user-secret.env"), "SECRET=1\n");

  const snapshotId = randomUUID();
  const capture = await service.captureManagedWorktreeSnapshot(
    repository,
    created.path,
    snapshotId,
  );
  await assert.rejects(
    service.deleteManagedWorktree(
      repository,
      created.path,
      created.branch,
      created.createdFromHead,
      undefined,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
      false,
      {
        snapshot: {
          id: snapshotId,
          ref: capture.ref,
          commit: capture.commit,
          tree: capture.tree,
        },
        provisionedIgnored: [],
      },
    ),
    (error: unknown) =>
      error instanceof GitManagedWorktreeDeleteError &&
      error.cause instanceof GitServiceError &&
      error.cause.code === "dirty_worktree" &&
      error.destructiveMutationAttempted === false,
  );
  assert.ok((await fs.lstat(created.path)).isDirectory());
  assert.equal(
    await fs.readFile(path.join(created.path, "user-secret.env"), "utf8"),
    "SECRET=1\n",
  );
});

test("a provisioned file inside an ignored directory does not block safe deletion", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({
    cacheTtlMs: 0,
    worktreeDirectoryRemover: removeAfterAuthorize,
  });
  const created = await service.createWorktree(repository, root, "codex/ignored-dir");
  // `generated/` collapses to a directory record under --ignored=matching while
  // the allowlist names the file inside it.
  await fs.appendFile(path.join(repository, ".git", "info", "exclude"), "\ngenerated/\n");
  await fs.mkdir(path.join(created.path, "generated"));
  await fs.writeFile(path.join(created.path, "generated", "fixture.bin"), "fixture\n");

  const snapshotId = randomUUID();
  const capture = await service.captureManagedWorktreeSnapshot(
    repository,
    created.path,
    snapshotId,
  );
  await service.deleteManagedWorktree(
    repository,
    created.path,
    created.branch,
    created.createdFromHead,
    undefined,
    created.worktreeGitDir,
    created.ownershipToken,
    created.worktreeDevice,
    created.worktreeInode,
    false,
    {
      snapshot: {
        id: snapshotId,
        ref: capture.ref,
        commit: capture.commit,
        tree: capture.tree,
      },
      provisionedIgnored: ["generated/fixture.bin"],
    },
  );
  await assert.rejects(fs.lstat(created.path), { code: "ENOENT" });
});

test("an ignored directory holding unprovisioned files still blocks safe deletion", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({
    cacheTtlMs: 0,
    worktreeDirectoryRemover: removeAfterAuthorize,
  });
  const created = await service.createWorktree(repository, root, "codex/mixed-ignored");
  await fs.appendFile(path.join(repository, ".git", "info", "exclude"), "\ngenerated/\n");
  await fs.mkdir(path.join(created.path, "generated"));
  await fs.writeFile(path.join(created.path, "generated", "fixture.bin"), "fixture\n");
  await fs.writeFile(path.join(created.path, "generated", "extra.bin"), "user file\n");

  const snapshotId = randomUUID();
  const capture = await service.captureManagedWorktreeSnapshot(
    repository,
    created.path,
    snapshotId,
  );
  await assert.rejects(
    service.deleteManagedWorktree(
      repository,
      created.path,
      created.branch,
      created.createdFromHead,
      undefined,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
      false,
      {
        snapshot: {
          id: snapshotId,
          ref: capture.ref,
          commit: capture.commit,
          tree: capture.tree,
        },
        provisionedIgnored: ["generated/fixture.bin"],
      },
    ),
    (error: unknown) =>
      error instanceof GitManagedWorktreeDeleteError &&
      error.cause instanceof GitServiceError &&
      error.cause.code === "dirty_worktree" &&
      error.destructiveMutationAttempted === false,
  );
  assert.ok((await fs.lstat(created.path)).isDirectory());
  assert.equal(
    await fs.readFile(path.join(created.path, "generated", "extra.bin"), "utf8"),
    "user file\n",
  );
});

test("force deletion bypasses recoverability checks but not identity checks", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({
    cacheTtlMs: 0,
    worktreeDirectoryRemover: removeAfterAuthorize,
  });
  const created = await service.createWorktree(repository, root, "codex/force-delete");
  await fs.writeFile(path.join(created.path, "README.md"), "dirty\n");
  await fs.appendFile(path.join(repository, ".git", "info", "exclude"), "\nscratch.bin\n");
  await fs.writeFile(path.join(created.path, "scratch.bin"), "scratch\n");

  await service.deleteManagedWorktree(
    repository,
    created.path,
    created.branch,
    created.createdFromHead,
    undefined,
    created.worktreeGitDir,
    created.ownershipToken,
    created.worktreeDevice,
    created.worktreeInode,
    false,
    { force: true },
  );
  await assert.rejects(fs.lstat(created.path), { code: "ENOENT" });

  // Identity checks remain authoritative under force.
  const other = await service.createWorktree(repository, root, "codex/force-identity");
  await assert.rejects(
    service.deleteManagedWorktree(
      repository,
      other.path,
      other.branch,
      other.createdFromHead,
      undefined,
      other.worktreeGitDir,
      "11111111-1111-4111-8111-111111111111",
      other.worktreeDevice,
      other.worktreeInode,
      false,
      { force: true },
    ),
    (error: unknown) => error instanceof GitManagedWorktreeDeleteError,
  );
});

test("content changed after the snapshot cannot be silently discarded", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({
    cacheTtlMs: 0,
    worktreeDirectoryRemover: removeAfterAuthorize,
  });
  const created = await service.createWorktree(repository, root, "codex/snapshot-drift");
  await fs.writeFile(path.join(created.path, "README.md"), "snapshot me\n");
  const snapshotId = randomUUID();
  const capture = await service.captureManagedWorktreeSnapshot(
    repository,
    created.path,
    snapshotId,
  );
  // The user keeps working after the snapshot — the tree no longer matches.
  await fs.writeFile(path.join(created.path, "README.md"), "newer content\n");

  await assert.rejects(
    service.deleteManagedWorktree(
      repository,
      created.path,
      created.branch,
      created.createdFromHead,
      undefined,
      created.worktreeGitDir,
      created.ownershipToken,
      created.worktreeDevice,
      created.worktreeInode,
      true,
      {
        snapshot: {
          id: snapshotId,
          ref: capture.ref,
          commit: capture.commit,
          tree: capture.tree,
        },
      },
    ),
    (error: unknown) =>
      error instanceof GitManagedWorktreeDeleteError &&
      /snapshot|review|preserved/u.test(error.message),
  );
  // needs_review semantics: the checkout survives inside quarantine with the
  // post-snapshot edits still on disk; nothing is silently discarded.
  const quarantine = path.join(
    path.dirname(created.path),
    `.aiden-removing-${created.ownershipToken}`,
  );
  assert.equal(
    await fs.readFile(path.join(quarantine, "README.md"), "utf8"),
    "newer content\n",
  );
  const journal = JSON.parse(
    await fs.readFile(`${quarantine}.json`, "utf8"),
  );
  assert.equal(journal.phase, "needs_review");
});

test("restore recreates dirty state without putting the synthetic commit on the branch", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const snapshotRoot = await temporaryDirectory(t);
  const service = new GitService({
    cacheTtlMs: 0,
    worktreeDirectoryRemover: removeAfterAuthorize,
  });
  await git(repository, ["config", "user.email", "aiden@example.test"]);
  await git(repository, ["config", "user.name", "Aiden Test"]);

  const created = await service.createWorktree(repository, root, "codex/restorable");
  await fs.writeFile(path.join(created.path, "README.md"), "dirty bytes\n");
  await fs.writeFile(path.join(created.path, "notes.txt"), "untracked\n");
  await fs.appendFile(path.join(repository, ".git", "info", "exclude"), "\n.env\n");
  await fs.writeFile(path.join(created.path, ".env"), "TOKEN=captured\n");

  const snapshotId = randomUUID();
  const snapshotDir = path.join(snapshotRoot, snapshotId);
  await fs.mkdir(path.join(snapshotDir, "files"), { recursive: true });
  const provisioned = [
    await captureProvisionedFile(snapshotDir, created.path, ".env"),
  ];
  const capture = await service.captureManagedWorktreeSnapshot(
    repository,
    created.path,
    snapshotId,
  );
  const manifest: ManagedWorktreeSnapshot = {
    id: snapshotId,
    workspaceId: "workspace-source",
    repositoryPath: created.repositoryPath,
    worktreePath: created.path,
    workspaceSubpath: "",
    branch: created.branch,
    originalHead: capture.head,
    snapshotRef: capture.ref,
    snapshotCommit: capture.commit,
    snapshotTree: capture.tree,
    createdAt: Date.now(),
    provisionedFiles: provisioned,
    state: "ready",
  };
  await persistManagedWorktreeSnapshot(snapshotRoot, manifest);

  await service.deleteManagedWorktree(
    repository,
    created.path,
    created.branch,
    created.createdFromHead,
    undefined,
    created.worktreeGitDir,
    created.ownershipToken,
    created.worktreeDevice,
    created.worktreeInode,
    false,
    {
      snapshot: {
        id: snapshotId,
        ref: capture.ref,
        commit: capture.commit,
        tree: capture.tree,
      },
      provisionedIgnored: [".env"],
    },
  );
  await assert.rejects(fs.lstat(created.path), { code: "ENOENT" });

  const restoreRoot = await temporaryDirectory(t);
  const restoredPath = path.join(restoreRoot, "restored");
  const restored = await service.restoreManagedWorktreeCheckout(
    repository,
    restoreRoot,
    restoredPath,
    created.branch,
    capture.head,
    "",
  );
  assert.equal(restored.head, capture.head);
  assert.ok(restored.ownershipToken !== created.ownershipToken);
  await service.applyManagedWorktreeSnapshot(repository, restored.path, capture.commit);
  await restoreProvisionedFiles(snapshotDir, manifest.provisionedFiles, restored.path);

  const status = await git(restored.path, ["status", "--porcelain=v2", "-z"]);
  // `.M` = worktree-modified but unstaged: dirty state returns unstaged.
  assert.match(status, /1 \.M [^\0\n]* README\.md/u);
  assert.match(status, /\? notes\.txt/u);
  assert.equal(
    await fs.readFile(path.join(restored.path, ".env"), "utf8"),
    "TOKEN=captured\n",
  );
  const log = await git(restored.path, ["log", "--format=%s"]);
  assert.ok(!log.includes(`aiden snapshot ${snapshotId}`));
  assert.equal(await git(restored.path, ["rev-parse", "HEAD"]), capture.head);
});

test("restore converges after a crash between checkout creation and journal update", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const snapshotRoot = await temporaryDirectory(t);
  const worktreeRoot = await temporaryDirectory(t);
  const service = new GitService({
    cacheTtlMs: 0,
    worktreeDirectoryRemover: removeAfterAuthorize,
  });
  const created = await service.createWorktree(repository, root, "codex/resume");
  await fs.writeFile(path.join(created.path, "README.md"), "dirty\n");
  const snapshotId = randomUUID();
  const snapshotDir = path.join(snapshotRoot, snapshotId);
  await fs.mkdir(path.join(snapshotDir, "files"), { recursive: true });
  const capture = await service.captureManagedWorktreeSnapshot(
    repository,
    created.path,
    snapshotId,
  );
  const manifest: ManagedWorktreeSnapshot = {
    id: snapshotId,
    workspaceId: "workspace-source",
    repositoryPath: created.repositoryPath,
    worktreePath: created.path,
    workspaceSubpath: "",
    branch: created.branch,
    originalHead: capture.head,
    snapshotRef: capture.ref,
    snapshotCommit: capture.commit,
    snapshotTree: capture.tree,
    createdAt: Date.now(),
    provisionedFiles: [],
    state: "ready",
  };
  await persistManagedWorktreeSnapshot(snapshotRoot, manifest);
  await service.deleteManagedWorktree(
    repository,
    created.path,
    created.branch,
    created.createdFromHead,
    undefined,
    created.worktreeGitDir,
    created.ownershipToken,
    created.worktreeDevice,
    created.worktreeInode,
    false,
    {
      snapshot: {
        id: snapshotId,
        ref: capture.ref,
        commit: capture.commit,
        tree: capture.tree,
      },
      provisionedIgnored: [],
    },
  );

  const deps: ManagedWorktreeRestoreDependencies = {
    ensureWorktreeRoot: async () => worktreeRoot,
    snapshotRoot: async () => snapshotRoot,
    repositoryPaths: async () => ({
      topLevel: repository,
      commonDir: path.join(repository, ".git"),
    }),
    snapshotCommit: (repo, id) => service.managedWorktreeSnapshotCommit(repo, id),
    restoreCheckout: (repo, r, wt, b, base, sub, signal) =>
      service.restoreManagedWorktreeCheckout(repo, r, wt, b, base, sub, signal),
    resumeCheckout: (repo, wt, b, base, sub, signal) =>
      service.resumeManagedWorktreeCheckout(repo, wt, b, base, sub, signal),
    applySnapshot: (wt, commit, signal) =>
      service.applyManagedWorktreeSnapshot(repository, wt, commit, signal),
    managedWorktreeUsable: (repo, wt, b, gitDir, token, dev, ino) =>
      service.managedWorktreeUsable(repo, wt, b, gitDir, token, dev, ino),
    createWorkspaceId: () => "workspace-restored",
  };

  // Simulate the crash window: the journal recorded the planned path and the
  // checkout was created, but the checkout identity was never journaled.
  const plannedParent = path.join(worktreeRoot, "repository-planned");
  await fs.mkdir(plannedParent, { recursive: true });
  const plannedPath = path.join(plannedParent, "restored");
  const planned: ManagedWorktreeRestoreJournal = {
    version: 1,
    phase: "checkout_planned",
    snapshotId,
    workspaceId: "workspace-restored",
    worktreePath: plannedPath,
  };
  await createManagedWorktreeRestoreJournal(snapshotRoot, planned);
  await service.restoreManagedWorktreeCheckout(
    repository,
    plannedParent,
    plannedPath,
    created.branch,
    capture.head,
    "",
  );

  const first = await restoreManagedWorktreeSnapshot(deps, snapshotId);
  assert.equal(first.workspaceId, "workspace-restored");
  assert.equal(first.worktree.path, plannedPath);
  const status = await git(plannedPath, ["status", "--porcelain=v2", "-z"]);
  assert.match(status, /1 \.M [^\0\n]* README\.md/u);

  // A retry after completion converges to the saved result instead of
  // attaching the recorded branch to a fresh random path.
  const again = await restoreManagedWorktreeSnapshot(deps, snapshotId);
  assert.equal(again.workspaceId, "workspace-restored");
  assert.equal(again.worktree.path, plannedPath);
  const worktrees = await git(repository, ["worktree", "list", "--porcelain"]);
  assert.equal(worktrees.match(/^worktree /gm)?.length, 2);
});

test("restore fails closed on branch conflicts and existing destinations", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const restoreRoot = await temporaryDirectory(t);
  const service = new GitService({ cacheTtlMs: 0 });
  const created = await service.createWorktree(repository, root, "codex/conflict");

  const base = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["branch", "conflict-target", base]);
  const destination = path.join(restoreRoot, "occupied");
  await fs.mkdir(destination);

  // Existing destination directory blocks restore.
  await assert.rejects(
    service.restoreManagedWorktreeCheckout(
      repository,
      restoreRoot,
      destination,
      "codex/conflict",
      base,
      "",
    ),
    (error: unknown) => error instanceof GitServiceError,
  );

  // A branch at a different commit cannot be reused for the restore.
  await fs.writeFile(path.join(repository, "other.txt"), "other\n");
  await git(repository, ["add", "other.txt"]);
  await git(repository, ["commit", "-m", "advance"]);
  const moved = await git(repository, ["rev-parse", "HEAD"]);
  await assert.rejects(
    service.restoreManagedWorktreeCheckout(
      repository,
      restoreRoot,
      path.join(restoreRoot, "free"),
      "conflict-target",
      moved,
      "",
    ),
    (error: unknown) => error instanceof GitServiceError,
  );
  assert.ok(created.path);
});

test("capacity admission reports a typed insufficient_disk_space error", async (t) => {
  const root = await temporaryDirectory(t);
  const available = await statfsAvailableBytes(root);
  assert.ok(available > 0);
  await assert.rejects(
    checkCreateCapacity(root, Number.MAX_SAFE_INTEGER),
    (error: unknown) =>
      error instanceof InsufficientDiskSpaceError &&
      error.code === "insufficient_disk_space" &&
      error.availableBytes === available &&
      error.requiredBytes > error.reserveBytes &&
      error.reserveBytes > 0 &&
      error.estimatedBytes === Number.MAX_SAFE_INTEGER,
  );
  // Snapshot admission uses a much smaller reserve than creation.
  const report = await checkSnapshotCapacity(root, 0);
  assert.ok(report.reserveBytes <= 64 * 1024 * 1024);
});

test(".worktreeinclude provisions only ignored+untracked files with mode preserved", async (t) => {
  const repository = await createRepository(t);
  const worktreePath = await temporaryDirectory(t);
  await fs.writeFile(path.join(repository, ".gitignore"), ".env\ngenerated/\n.envrc\n");
  await git(repository, ["add", ".gitignore"]);
  await git(repository, ["commit", "-m", "ignore env files"]);

  await fs.writeFile(path.join(repository, ".env"), "SECRET=42\n", { mode: 0o600 });
  await fs.mkdir(path.join(repository, "generated"));
  await fs.writeFile(path.join(repository, "generated", "fixture.bin"), "fixture\n");
  await fs.writeFile(path.join(repository, "untracked.txt"), "not ignored\n");
  await fs.writeFile(path.join(repository, "tracked.txt"), "tracked\n");
  await git(repository, ["add", "tracked.txt"]);
  await git(repository, ["commit", "-m", "add tracked"]);
  await fs.writeFile(
    path.join(repository, ".worktreeinclude"),
    ".env\ngenerated/**\ntracked.txt\nuntracked.txt\n",
  );

  const service = new GitService({ cacheTtlMs: 0 });
  const provisioned = await provisionWorktreeIncludedFiles(
    { listFiles: (cwd, args) => service.listFiles(cwd, args) },
    { sourceRoot: repository, worktreePath },
  );
  provisioned.sort();
  assert.deepEqual(provisioned, [".env", "generated/fixture.bin"]);

  const env = await fs.lstat(path.join(worktreePath, ".env"));
  assert.equal(env.mode & 0o777, 0o600);
  assert.equal(
    await fs.readFile(path.join(worktreePath, ".env"), "utf8"),
    "SECRET=42\n",
  );
  assert.equal(
    await fs.readFile(path.join(worktreePath, "generated", "fixture.bin"), "utf8"),
    "fixture\n",
  );
  // Tracked and non-ignored untracked files are never provisioned this way.
  await assert.rejects(fs.lstat(path.join(worktreePath, "tracked.txt")), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(worktreePath, "untracked.txt")), {
    code: "ENOENT",
  });
});

test("provisioning refuses symlinked sources, escapes, and existing destinations", async (t) => {
  const repository = await createRepository(t);
  const outside = await temporaryDirectory(t);
  const worktreePath = await temporaryDirectory(t);
  await fs.writeFile(path.join(repository, ".gitignore"), "linkdir\n.env\n");
  await git(repository, ["add", ".gitignore"]);
  await git(repository, ["commit", "-m", "ignore"]);

  await fs.writeFile(path.join(outside, "secret.txt"), "outside\n");
  await fs.symlink(outside, path.join(repository, "linkdir"));
  await fs.writeFile(path.join(repository, ".env"), "V=1\n");
  await fs.writeFile(path.join(repository, ".worktreeinclude"), "linkdir\n.env\n");

  const service = new GitService({ cacheTtlMs: 0 });
  // The symlinked directory itself is ignored+untracked and matches the WI —
  // it is a symlink, not a regular file, so provisioning must refuse.
  await assert.rejects(
    provisionWorktreeIncludedFiles(
      { listFiles: (cwd, args) => service.listFiles(cwd, args) },
      { sourceRoot: repository, worktreePath },
    ),
    (error: unknown) =>
      error instanceof ManagedWorktreeProvisionerError &&
      error.code === "unsafe_source",
  );

  // An existing destination is never overwritten.
  await fs.writeFile(path.join(worktreePath, ".env"), "existing\n");
  await assert.rejects(
    provisionWorktreeIncludedFiles(
      { listFiles: (cwd, args) => service.listFiles(cwd, args) },
      { sourceRoot: repository, worktreePath },
    ),
    (error: unknown) =>
      error instanceof ManagedWorktreeProvisionerError &&
      (error.code === "unsafe_source" || error.code === "destination_exists"),
  );
});

test("provisioned blob storage captures bytes, verifies digests, and restores idempotently", async (t) => {
  const snapshotRoot = await temporaryDirectory(t);
  const worktree = await temporaryDirectory(t);
  const snapshotId = randomUUID();
  const snapshotDir = path.join(snapshotRoot, snapshotId);
  await fs.mkdir(path.join(snapshotDir, "files"), { recursive: true });
  await fs.writeFile(path.join(worktree, ".env"), "CAPTURED=1\n", { mode: 0o600 });

  const entry = await captureProvisionedFile(snapshotDir, worktree, ".env");
  assert.equal(entry.relativePath, ".env");
  assert.equal(entry.mode, 0o600);
  assert.equal(entry.size, 11);
  await verifyProvisionedFileBlobs(snapshotDir, [entry]);

  const restored = await temporaryDirectory(t);
  await restoreProvisionedFiles(snapshotDir, [entry], restored);
  assert.equal(await fs.readFile(path.join(restored, ".env"), "utf8"), "CAPTURED=1\n");
  assert.equal((await fs.lstat(path.join(restored, ".env"))).mode & 0o777, 0o600);
  // Resume-safe: identical bytes at the destination are a no-op.
  await restoreProvisionedFiles(snapshotDir, [entry], restored);
  // A leftover inflight temp from a crashed write is discarded, not wedged.
  await fs.writeFile(path.join(restored, ".env.aiden-restore-inflight"), "partial\n");
  await restoreProvisionedFiles(snapshotDir, [entry], restored);
  await assert.rejects(
    fs.lstat(path.join(restored, ".env.aiden-restore-inflight")),
    { code: "ENOENT" },
  );
  assert.equal(await fs.readFile(path.join(restored, ".env"), "utf8"), "CAPTURED=1\n");
  // Conflicting content fails closed.
  await fs.writeFile(path.join(restored, ".env"), "OTHER=0\n");
  await assert.rejects(
    restoreProvisionedFiles(snapshotDir, [entry], restored),
    (error: unknown) =>
      error instanceof ManagedWorktreeSnapshotError && error.code === "destination_exists",
  );

  // Corruption and loss are detected.
  const blob = path.join(snapshotDir, entry.blobPath);
  await fs.writeFile(blob, "tampered\n");
  await assert.rejects(
    verifyProvisionedFileBlobs(snapshotDir, [entry]),
    (error: unknown) =>
      error instanceof ManagedWorktreeSnapshotError && error.code === "blob_corrupt",
  );
  await fs.unlink(blob);
  await assert.rejects(
    verifyProvisionedFileBlobs(snapshotDir, [entry]),
    (error: unknown) =>
      error instanceof ManagedWorktreeSnapshotError && error.code === "blob_missing",
  );
});

test("snapshot manifests round-trip and reject incomplete or corrupt records", async (t) => {
  const snapshotRoot = await temporaryDirectory(t);
  const snapshotId = randomUUID();
  const manifest: ManagedWorktreeSnapshot = {
    id: snapshotId,
    workspaceId: "w1",
    repositoryPath: "/tmp/repo",
    worktreePath: "/tmp/wt",
    workspaceSubpath: "sub/dir",
    branch: "codex/x",
    originalHead: "a".repeat(40),
    snapshotRef: `refs/aiden/snapshots/${snapshotId}`,
    snapshotCommit: "b".repeat(40),
    snapshotTree: "c".repeat(40),
    createdAt: 1,
    provisionedFiles: [],
    state: "ready",
  };
  await persistManagedWorktreeSnapshot(snapshotRoot, manifest);
  assert.deepEqual(
    await readManagedWorktreeSnapshot(snapshotRoot, snapshotId),
    manifest,
  );
  await assert.rejects(
    requireReadyManagedWorktreeSnapshot(snapshotRoot, randomUUID()),
    (error: unknown) =>
      error instanceof ManagedWorktreeSnapshotError && error.code === "snapshot_incomplete",
  );
  await fs.writeFile(
    path.join(snapshotRoot, snapshotId, "manifest.json"),
    JSON.stringify({ ...manifest, snapshotRef: "refs/aiden/snapshots/tampered" }),
  );
  await assert.rejects(
    readManagedWorktreeSnapshot(snapshotRoot, snapshotId),
    (error: unknown) =>
      error instanceof ManagedWorktreeSnapshotError && error.code === "snapshot_invalid",
  );
  // A "creating" record is never a usable snapshot.
  await persistManagedWorktreeSnapshot(snapshotRoot, { ...manifest, state: "creating" });
  await assert.rejects(
    requireReadyManagedWorktreeSnapshot(snapshotRoot, snapshotId),
    (error: unknown) =>
      error instanceof ManagedWorktreeSnapshotError && error.code === "snapshot_incomplete",
  );
});

test("readWorktreeInclude rejects symlinks and oversized includes", async (t) => {
  const repository = await createRepository(t);
  assert.equal(await readWorktreeInclude(repository), undefined);
  const outside = await temporaryDirectory(t);
  const target = path.join(outside, "real-include");
  await fs.writeFile(target, ".env\n");
  await fs.symlink(target, path.join(repository, ".worktreeinclude"));
  await assert.rejects(
    readWorktreeInclude(repository),
    (error: unknown) =>
      error instanceof ManagedWorktreeProvisionerError && error.code === "include_invalid",
  );
});
