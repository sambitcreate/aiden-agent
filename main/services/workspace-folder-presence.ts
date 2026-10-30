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

export function workspaceFolderMissingText(workspace: Pick<Workspace, "name" | "folderPath">): string {
  return workspaceFolderMissingMessage(
    workspace.name,
    workspace.folderPath ? displayWorkspaceFolder(workspace.folderPath) : undefined,
  );
}

export class WorkspaceFolderMissingError extends Error {
  readonly code = "workspace_folder_missing";
  constructor(workspace: Pick<Workspace, "name" | "folderPath">) {
    super(workspaceFolderMissingText(workspace));
    this.name = "WorkspaceFolderMissingError";
  }
}

type CheckedWorkspace = Pick<Workspace, "name" | "folderPath" | "permission" | "managedWorktree">;

/**
 * A No workspace chat's folder is Aiden's own, so a missing one (cleared app
 * data, a manual delete) is made again empty instead of stopping the chat.
 */
export async function restoreNoWorkspaceFolder(
  workspace: Pick<Workspace, "folderPath" | "noWorkspace">,
  mkdir: (target: string, options: { recursive: true; mode: number }) => Promise<unknown> = fs.mkdir,
): Promise<void> {
  if (!workspace.noWorkspace || !workspace.folderPath) return;
  if ((await workspaceFolderPresence(workspace.folderPath)) !== "missing") return;
  await mkdir(workspace.folderPath, { recursive: true, mode: 0o700 });
}

/** Whether this workspace's folder is checked and gone. */
export async function workspaceFolderMissing(workspace: CheckedWorkspace, stat?: Stat): Promise<boolean> {
  return (
    workspaceFolderCheckApplies(workspace) &&
    (await workspaceFolderPresence(workspace.folderPath!, stat)) === "missing"
  );
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
