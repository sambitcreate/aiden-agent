// Whether a workspace's folder is still on disk.
//
// A folder can be moved, renamed or deleted while Aiden keeps the workspace.
// Without this check a turn would start anyway and every tool would fail with
// errors that never name the cause (a missing working folder surfaces as
// `spawn /bin/sh ENOENT`). Checking first lets Aiden say what happened.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Workspace } from "./types.js";
import {
  type MissingWorktreeOptions,
  MANAGED_WORKTREE_MISSING_REMOTE_REFUSAL,
  managedWorktreeMissingMessage,
  WORKSPACE_FOLDER_MISSING_REMOTE_REFUSAL,
  workspaceFolderCheckApplies,
  workspaceFolderMissingMessage,
} from "../../renderer/shared/workspace-folder-presence.js";

/** `present`, `missing`, or `unknown` when the check itself could not answer. */
export type WorkspaceFolderPresence = "present" | "missing" | "unknown";

type Stat = (target: string) => Promise<{ isDirectory(): boolean }>;

export async function workspaceFolderPresence(
  folderPath: string,
  stat: Stat = fs.stat,
): Promise<WorkspaceFolderPresence> {
  try {
    return (await stat(folderPath)).isDirectory() ? "present" : "missing";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    // Permission or I/O trouble is not proof the folder is gone; the tools
    // report those themselves.
    return "unknown";
  }
}

/** The folder with the home folder shown as `~`, for user-facing text. */
export function displayWorkspaceFolder(folderPath: string, home = os.homedir()): string {
  if (home && (folderPath === home || folderPath.startsWith(home + path.sep))) {
    return "~" + folderPath.slice(home.length);
  }
  return folderPath;
}

type CheckedWorkspace = Pick<Workspace, "name" | "folderPath" | "permission" | "managedWorktree">;

/** The folder whose absence counts: an Aiden-managed worktree's checkout root, else the workspace folder. */
export function checkedWorkspaceFolder(workspace: Pick<Workspace, "folderPath" | "managedWorktree">): string | undefined {
  return workspace.managedWorktree?.worktreePath ?? workspace.folderPath;
}

export function workspaceFolderMissingText(workspace: Pick<Workspace, "name" | "folderPath" | "managedWorktree">): string {
  const folder = checkedWorkspaceFolder(workspace);
  const shown = folder ? displayWorkspaceFolder(folder) : undefined;
  return workspace.managedWorktree
    ? managedWorktreeMissingMessage(workspace.name, shown)
    : workspaceFolderMissingMessage(workspace.name, shown);
}

export class WorkspaceFolderMissingError extends Error {
  readonly code = "workspace_folder_missing";
  constructor(workspace: Pick<Workspace, "name" | "folderPath" | "managedWorktree">) {
    super(workspaceFolderMissingText(workspace));
    this.name = "WorkspaceFolderMissingError";
  }
}

/** Whether this workspace's folder is checked and gone. */
export async function workspaceFolderMissing(workspace: CheckedWorkspace, stat?: Stat): Promise<boolean> {
  return (
    workspaceFolderCheckApplies(workspace) &&
    (await workspaceFolderPresence(checkedWorkspaceFolder(workspace)!, stat)) === "missing"
  );
}

/** What a paired device hears when its turn is refused for a missing folder, or undefined. */
export async function workspaceFolderRemoteRefusal(workspace: CheckedWorkspace, stat?: Stat): Promise<string | undefined> {
  if (!(await workspaceFolderMissing(workspace, stat))) return undefined;
  return workspace.managedWorktree ? MANAGED_WORKTREE_MISSING_REMOTE_REFUSAL : WORKSPACE_FOLDER_MISSING_REMOTE_REFUSAL;
}

/** Refuse to start a turn in a workspace whose folder is gone. */
export async function assertWorkspaceFolderPresent(
  workspace: CheckedWorkspace,
  stat?: Stat,
): Promise<void> {
  if (await workspaceFolderMissing(workspace, stat)) {
    throw new WorkspaceFolderMissingError(workspace);
  }
}

export interface MissingWorktreeGit {
  /** The commit the branch points at, or undefined when it no longer exists. */
  branchHead(repositoryPath: string, branch: string): Promise<string | undefined>;
  worktrees(repositoryPath: string): Promise<ReadonlyArray<{ path: string; branch?: string }>>;
}

/**
 * What the notice for a deleted managed worktree can offer: Restore when its
 * branch still exists and no other worktree has it checked out, and a new
 * chat in the workspace for the repository's main checkout (the same nested
 * folder the worktree was made from when there is one, else the repository
 * root). A Git error only takes Restore away; it never hides the notice.
 */
export async function missingWorktreeOptions(
  workspace: Pick<Workspace, "folderPath" | "managedWorktree">,
  workspaces: readonly Workspace[],
  git: MissingWorktreeGit,
): Promise<MissingWorktreeOptions | undefined> {
  const managed = workspace.managedWorktree;
  if (!managed) return undefined;
  let restorable = false;
  try {
    if ((await git.branchHead(managed.repositoryPath, managed.branch)) !== undefined) {
      const checkout = path.resolve(managed.worktreePath);
      restorable = !(await git.worktrees(managed.repositoryPath)).some(
        (worktree) => worktree.branch === managed.branch && path.resolve(worktree.path) !== checkout,
      );
    }
  } catch {
    restorable = false;
  }
  const subpath = workspace.folderPath ? path.relative(managed.worktreePath, workspace.folderPath) : "";
  const candidates = [path.resolve(managed.repositoryPath, subpath), path.resolve(managed.repositoryPath)];
  const main = candidates
    .map((folder) =>
      workspaces.find(
        (candidate) =>
          !candidate.managedWorktree &&
          !candidate.scratch &&
          candidate.permission !== "none" &&
          candidate.folderPath !== undefined &&
          path.resolve(candidate.folderPath) === folder,
      ),
    )
    .find((candidate) => candidate !== undefined);
  return {
    branch: managed.branch,
    restorable,
    ...(main ? { mainWorkspaceId: main.id, mainWorkspaceName: main.name } : {}),
  };
}
