import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gitManagedWorktreeDeletionPending, gitManagedWorktreeUsable } from "./git.js";
import type { Workspace } from "./types.js";

export type ManagedWorktreeVerifier = (
  repositoryPath: string,
  worktreePath: string,
  branch: string,
  worktreeGitDir?: string,
  ownershipToken?: string,
  worktreeDevice?: number,
  worktreeInode?: number,
) => Promise<boolean>;

export type ManagedWorktreeDeletionPendingVerifier = (
  worktreePath: string,
  worktreeGitDir: string,
  ownershipToken: string,
) => Promise<boolean>;

const UNAVAILABLE = "The managed worktree is no longer available to Aiden.";

function relativeInside(root: string, candidate: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

/**
 * Revalidate an Aiden-owned checkout before granting any persisted workspace
 * capability. Legacy markerless records and external replacements fail closed.
 */
export async function assertManagedWorktreeAdmission(
  workspace: Workspace,
  verify: ManagedWorktreeVerifier = gitManagedWorktreeUsable,
  deletionPending: ManagedWorktreeDeletionPendingVerifier = gitManagedWorktreeDeletionPending,
): Promise<void> {
  const managed = workspace.managedWorktree;
  if (!managed) return;
  if (
    !workspace.folderPath ||
    !managed.worktreeGitDir ||
    !managed.ownershipToken ||
    !Number.isSafeInteger(managed.worktreeDevice) ||
    !Number.isSafeInteger(managed.worktreeInode) ||
    !path.isAbsolute(workspace.folderPath) ||
    !path.isAbsolute(managed.repositoryPath) ||
    !path.isAbsolute(managed.worktreePath) ||
    !path.isAbsolute(managed.worktreeGitDir)
  ) {
    throw new Error(UNAVAILABLE);
  }
  const relativeWorkspace = relativeInside(managed.worktreePath, workspace.folderPath);
  if (relativeWorkspace === undefined) throw new Error(UNAVAILABLE);

  try {
    if (
      await deletionPending(managed.worktreePath, managed.worktreeGitDir, managed.ownershipToken)
    ) {
      throw new Error(UNAVAILABLE);
    }
  } catch {
    throw new Error(UNAVAILABLE);
  }

  let usable = false;
  try {
    usable = await verify(
      managed.repositoryPath,
      managed.worktreePath,
      managed.branch,
      managed.worktreeGitDir,
      managed.ownershipToken,
      managed.worktreeDevice,
      managed.worktreeInode,
    );
  } catch {
    throw new Error(UNAVAILABLE);
  }
  if (!usable) throw new Error(UNAVAILABLE);

  try {
    const [canonicalWorktree, canonicalWorkspace] = await Promise.all([
      fs.realpath(managed.worktreePath),
      fs.realpath(workspace.folderPath),
    ]);
    if (path.resolve(canonicalWorkspace) !== path.resolve(canonicalWorktree, relativeWorkspace)) {
      throw new Error(UNAVAILABLE);
    }
    const stat = await fs.stat(canonicalWorkspace);
    if (!stat.isDirectory()) throw new Error(UNAVAILABLE);
  } catch {
    throw new Error(UNAVAILABLE);
  }
}
