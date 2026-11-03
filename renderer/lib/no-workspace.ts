import type { Workspace } from "./types";

/**
 * "No workspace" chats: each one runs in a hidden workspace (`noWorkspace`)
 * whose folder Aiden manages, with global settings. They are never offered as
 * workspaces; the sidebar lists them together under one Chats group.
 */

export const NO_WORKSPACE_LABEL = "No workspace";
export const NO_WORKSPACE_GROUP_LABEL = "Chats";

export function isNoWorkspace(workspace: Pick<Workspace, "noWorkspace"> | null | undefined): boolean {
  return workspace?.noWorkspace === true;
}

/** Workspaces a person can pick, open or configure: everything but the hidden No workspace records. */
export function workspaceChoices<T extends Pick<Workspace, "noWorkspace">>(workspaces: readonly T[]): T[] {
  return workspaces.filter((workspace) => !isNoWorkspace(workspace));
}

/**
 * The hidden workspace that stands for the whole Chats group: the long-lived
 * default home when it is one, else the oldest. Stable while chats come and go.
 */
export function noWorkspaceHome(workspaces: readonly Workspace[]): Workspace | undefined {
  let home: Workspace | undefined;
  for (const workspace of workspaces) {
    if (!isNoWorkspace(workspace)) continue;
    if (workspace.id === "default") return workspace;
    if (!home || workspace.createdAt < home.createdAt) home = workspace;
  }
  return home;
}

/** Maps a hidden No workspace id onto the Chats group's id; other ids pass through. */
export function sidebarGroupWorkspaceId(
  workspaceId: string,
  workspaces: readonly Workspace[],
  home = noWorkspaceHome(workspaces),
): string {
  if (!home) return workspaceId;
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  return isNoWorkspace(workspace) ? home.id : workspaceId;
}
