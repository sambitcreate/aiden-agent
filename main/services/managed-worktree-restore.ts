// First-class restore for managed-worktree snapshots: recreate an owned
// checkout at the snapshot's base commit, replay the captured tree as working
// dirt, and rewrite provisioned ignored files from their captured bytes.
// A small journal in the snapshot directory makes every crash boundary
// restart-idempotent.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GitCreatedWorktree } from "./git.js";
import {
  type ManagedWorktreeRestoreJournal,
  type ManagedWorktreeSnapshot,
  ManagedWorktreeSnapshotError,
  createManagedWorktreeRestoreJournal,
  readManagedWorktreeRestoreJournal,
  requireReadyManagedWorktreeSnapshot,
  restoreProvisionedFiles,
  updateManagedWorktreeSnapshotState,
  verifyProvisionedFileBlobs,
  writeManagedWorktreeRestoreJournal,
} from "./managed-worktree-snapshot.js";

async function pathExists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  );
}

export interface ManagedWorktreeRestoreDependencies {
  ensureWorktreeRoot(): Promise<string>;
  snapshotRoot(): Promise<string>;
  checkCapacity(root: string, phase: ManagedWorktreeRestoreJournal["phase"]): Promise<void>;
  repositoryPaths(repositoryPath: string): Promise<{ topLevel: string; commonDir: string }>;
  snapshotCommit(repositoryPath: string, snapshotId: string): Promise<string | undefined>;
  restoreCheckout(
    repositoryPath: string,
    root: string,
    worktreePath: string,
    branch: string,
    baseCommit: string,
    workspaceSubpath: string,
    signal?: AbortSignal,
  ): Promise<GitCreatedWorktree>;
  resumeCheckout(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    baseCommit: string,
    workspaceSubpath: string,
    signal?: AbortSignal,
  ): Promise<GitCreatedWorktree>;
  applySnapshot(
    worktreePath: string,
    snapshotCommit: string,
    signal?: AbortSignal,
  ): Promise<void>;
  managedWorktreeUsable(
    repositoryPath: string,
    worktreePath: string,
    branch: string,
    worktreeGitDir: string,
    ownershipToken: string,
    worktreeDevice: number,
    worktreeInode: number,
  ): Promise<boolean>;
  createWorkspaceId(): string;
  signal?: AbortSignal;
}

export interface ManagedWorktreeRestoreResult {
  snapshot: ManagedWorktreeSnapshot;
  workspaceId: string;
  worktree: GitCreatedWorktree;
}

function restoredWorktreePath(
  root: string,
  commonDir: string,
  repositoryPath: string,
  branch: string,
): { repositoryRoot: string; worktreePath: string } {
  const repositoryId = createHash("sha256").update(commonDir).digest("hex").slice(0, 12);
  const repositoryName =
    path.basename(repositoryPath).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repository";
  const branchSlug =
    branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
  const repositoryRoot = path.join(root, `${repositoryName}-${repositoryId}`);
  return {
    repositoryRoot,
    worktreePath: path.join(
      repositoryRoot,
      `${branchSlug}-restored-${randomUUID().slice(0, 8)}`,
    ),
  };
}

/**
 * Verify a checkout created by an earlier restore attempt is still the exact
 * owned directory the journal recorded.
 */
async function verifiedJournaledCheckout(
  dependencies: ManagedWorktreeRestoreDependencies,
  journal: ManagedWorktreeRestoreJournal,
  snapshot: ManagedWorktreeSnapshot,
): Promise<void> {
  if (
    journal.worktreeGitDir === undefined ||
    journal.ownershipToken === undefined ||
    journal.worktreeDevice === undefined ||
    journal.worktreeInode === undefined
  ) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "The managed worktree restore journal is missing checkout identity.",
    );
  }
  const usable = await dependencies.managedWorktreeUsable(
    snapshot.repositoryPath,
    journal.worktreePath,
    snapshot.branch,
    journal.worktreeGitDir,
    journal.ownershipToken,
    journal.worktreeDevice,
    journal.worktreeInode,
  );
  if (!usable) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "A partially restored managed worktree could not be verified.",
    );
  }
}

/**
 * Restore a snapshot into a new managed worktree. Fails closed on a missing or
 * corrupt snapshot, a changed repository identity, a branch/worktree conflict,
 * or any unverifiable identity. Restart-safe: a `restore.json` journal records
 * each completed step so a re-run converges without duplicating worktrees.
 */
export async function restoreManagedWorktreeSnapshot(
  dependencies: ManagedWorktreeRestoreDependencies,
  snapshotId: string,
): Promise<ManagedWorktreeRestoreResult> {
  const snapshotRoot = await dependencies.snapshotRoot();
  const snapshot = await requireReadyManagedWorktreeSnapshot(snapshotRoot, snapshotId);
  const snapshotDirPath = path.join(snapshotRoot, snapshotId);

  // The snapshot ref is the durable Git anchor — it must still point at the
  // recorded synthetic commit, and the repository must still be the same
  // checkout the snapshot was taken from.
  const repo = await dependencies.repositoryPaths(snapshot.repositoryPath);
  if (repo.topLevel !== snapshot.repositoryPath) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_invalid",
      "The repository moved since the snapshot was captured.",
    );
  }
  const commit = await dependencies.snapshotCommit(snapshot.repositoryPath, snapshotId);
  if (commit === undefined || commit !== snapshot.snapshotCommit) {
    throw new ManagedWorktreeSnapshotError(
      "snapshot_incomplete",
      "The managed worktree snapshot ref is missing or changed.",
    );
  }
  await verifyProvisionedFileBlobs(snapshotDirPath, snapshot.provisionedFiles);

  let journal = await readManagedWorktreeRestoreJournal(snapshotRoot, snapshotId);
  const signal = dependencies.signal;
  if (journal?.phase !== "complete") {
    await dependencies.checkCapacity(
      journal ? path.dirname(journal.worktreePath) : await dependencies.ensureWorktreeRoot(),
      journal?.phase ?? "checkout_planned",
    );
  }
  await updateManagedWorktreeSnapshotState(snapshotRoot, snapshot, "restoring");

  if (journal === undefined) {
    // Journal the planned checkout path before creating it so a crash between
    // `worktree add` and the journal write cannot orphan a registered worktree
    // on an unreachable branch. The exclusive create also converges two
    // concurrent restores of the same snapshot onto one plan.
    const worktreeRoot = await dependencies.ensureWorktreeRoot();
    const { repositoryRoot, worktreePath } = restoredWorktreePath(
      worktreeRoot,
      repo.commonDir,
      snapshot.repositoryPath,
      snapshot.branch,
    );
    await fs.mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
    const planned: ManagedWorktreeRestoreJournal = {
      version: 1,
      phase: "checkout_planned",
      snapshotId,
      workspaceId: dependencies.createWorkspaceId(),
      worktreePath,
    };
    try {
      await createManagedWorktreeRestoreJournal(snapshotRoot, planned);
      journal = planned;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
      journal = await readManagedWorktreeRestoreJournal(snapshotRoot, snapshotId);
      if (journal === undefined) {
        throw new ManagedWorktreeSnapshotError(
          "snapshot_invalid",
          "The managed worktree restore journal could not be verified.",
        );
      }
    }
  }

  if (journal.phase === "checkout_planned") {
    let worktree: GitCreatedWorktree;
    if (await pathExists(journal.worktreePath)) {
      // A crash after `worktree add` left the checkout here; adopt it only when
      // every identity check verifies it as the one Aiden created.
      worktree = await dependencies.resumeCheckout(
        snapshot.repositoryPath,
        journal.worktreePath,
        snapshot.branch,
        snapshot.originalHead,
        snapshot.workspaceSubpath,
        signal,
      );
    } else {
      worktree = await dependencies.restoreCheckout(
        snapshot.repositoryPath,
        path.dirname(journal.worktreePath),
        journal.worktreePath,
        snapshot.branch,
        snapshot.originalHead,
        snapshot.workspaceSubpath,
        signal,
      );
    }
    journal = {
      ...journal,
      phase: "checkout_created",
      // Record the checkout's registered (canonical) path so later phases and
      // retries compare against what git actually registered.
      worktreePath: worktree.path,
      worktreeGitDir: worktree.worktreeGitDir,
      ownershipToken: worktree.ownershipToken,
      worktreeDevice: worktree.worktreeDevice,
      worktreeInode: worktree.worktreeInode,
    };
    await writeManagedWorktreeRestoreJournal(snapshotRoot, journal);
  } else {
    await verifiedJournaledCheckout(dependencies, journal, snapshot);
  }

  if (journal.phase === "checkout_created") {
    await dependencies.applySnapshot(journal.worktreePath, snapshot.snapshotCommit, signal);
    journal = { ...journal, phase: "snapshot_applied" };
    await writeManagedWorktreeRestoreJournal(snapshotRoot, journal);
  }
  if (journal.phase === "snapshot_applied") {
    await restoreProvisionedFiles(
      snapshotDirPath,
      snapshot.provisionedFiles,
      journal.worktreePath,
      {
        path: journal.worktreePath,
        device: String(journal.worktreeDevice),
        inode: String(journal.worktreeInode),
      },
    );
    journal = { ...journal, phase: "complete" };
    await writeManagedWorktreeRestoreJournal(snapshotRoot, journal);
  }

  // Reconstruct the checkout descriptor when resuming a completed restore.
  const worktree: GitCreatedWorktree = {
    path: journal.worktreePath,
    branch: snapshot.branch,
    head: snapshot.originalHead,
    bare: false,
    detached: false,
    current: false,
    workspacePath: path.join(journal.worktreePath, snapshot.workspaceSubpath),
    repositoryPath: snapshot.repositoryPath,
    worktreeGitDir: journal.worktreeGitDir!,
    ownershipToken: journal.ownershipToken!,
    worktreeDevice: journal.worktreeDevice!,
    worktreeInode: journal.worktreeInode!,
    createdFromHead: snapshot.originalHead,
  };
  return { snapshot, workspaceId: journal.workspaceId, worktree };
}
