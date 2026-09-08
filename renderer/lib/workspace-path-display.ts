import type { AppearanceConfig } from "../shared/appearance";
import type { Workspace } from "./types";
import { DEFAULT_PATH_TRUNCATE_LENGTH, pathTextEdge, truncatePathMiddle } from "./truncate-path";

export type WorkspacePathPreferences = Pick<
  AppearanceConfig,
  "showWorkspacePaths" | "workspacePathFormat"
>;

/** A stable, path-free identity for duplicate names, independent of search/order. */
export function workspaceDisplayName(
  workspace: Workspace,
  workspaces: readonly Workspace[],
): string {
  const peers = workspaces.filter(
    (entry) =>
      entry.id !== workspace.id &&
      entry.name.toLocaleLowerCase() === workspace.name.toLocaleLowerCase(),
  );
  if (peers.length === 0) return workspace.name;
  let length = Math.min(4, workspace.id.length);
  while (
    length < workspace.id.length &&
    peers.some((entry) => entry.id.slice(-length) === workspace.id.slice(-length))
  )
    length += 1;
  return `${workspace.name} · ${workspace.id.slice(-length)}`;
}

/** Display only: never use a shortened path for filesystem operations. */
export function formatWorkspacePath(
  path: string,
  format: AppearanceConfig["workspacePathFormat"],
  maxLength = DEFAULT_PATH_TRUNCATE_LENGTH,
): string {
  const value = path;
  const limit = Math.max(0, Math.floor(maxLength));
  if (limit === 0) return "";
  if (value.length <= limit) return value;
  if (limit === 1) return "…";
  if (format === "start") return `${pathTextEdge(value, limit - 1, "start")}…`;
  if (format === "end") {
    const separator = value.includes("/") ? "/" : "\\";
    const tail = pathTextEdge(value, limit - 1, "end");
    const boundary = tail.indexOf(separator);
    return `…${boundary >= 0 && boundary < tail.length - 1 ? tail.slice(boundary) : tail}`;
  }
  return truncatePathMiddle(value, limit);
}

export function workspaceSecondaryLabel(
  workspace: Workspace,
  preferences: WorkspacePathPreferences,
): string {
  const branch = workspace.managedWorktree?.branch;
  const path =
    preferences.showWorkspacePaths && workspace.folderPath
      ? formatWorkspacePath(workspace.folderPath, preferences.workspacePathFormat)
      : undefined;
  return (
    [branch, path].filter(Boolean).join(" · ") ||
    (workspace.folderPath ? "" : `No folder · ${workspace.id.slice(0, 8)}`)
  );
}
