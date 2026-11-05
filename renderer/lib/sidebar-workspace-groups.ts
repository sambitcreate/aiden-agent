import {
  LOCAL_SIDEBAR_HOST_ID,
  projectOrderKey,
  type SidebarChatSummary,
  type SidebarProjectSummary,
} from "./sidebar-organization";
import { isNoWorkspace, NO_WORKSPACE_GROUP_LABEL, noWorkspaceHome, sidebarGroupWorkspaceId } from "./no-workspace";
import type { ChatMeta, Workspace } from "./types";

/**
 * Local adapter for the sidebar projection: maps this Mac's workspace registry
 * and chat metadata into the host-qualified summaries `organizeSidebar` takes.
 */

export interface LocalSidebarProject extends SidebarProjectSummary {
  workspace: Workspace;
}

export interface LocalSidebarChat extends SidebarChatSummary {
  chat: ChatMeta;
}

export function localSidebarProjectKey(workspaceId: string): string {
  return projectOrderKey(LOCAL_SIDEBAR_HOST_ID, workspaceId);
}

/**
 * Hidden No workspace records collapse into one Chats project, represented by
 * their stable home record (see `noWorkspaceHome`), instead of a row each.
 */
export function localSidebarProjects(workspaces: readonly Workspace[]): LocalSidebarProject[] {
  const home = noWorkspaceHome(workspaces);
  return workspaces.flatMap((workspace): LocalSidebarProject[] => {
    if (isNoWorkspace(workspace) && workspace !== home) return [];
    const name = workspace === home ? NO_WORKSPACE_GROUP_LABEL : workspace.name;
    return [
      {
        key: localSidebarProjectKey(workspace.id),
        name,
        searchText: workspace === home ? name : `${workspace.name} ${workspace.folderPath ?? ""}`,
        createdAt: workspace.createdAt,
        lastActivityAt: workspace.updatedAt,
        workspace,
      },
    ];
  });
}

/**
 * Only chats owned by the supplied workspace registry are admitted, which keeps
 * reserved Assistant, Bot, and removed-workspace records out of the sidebar.
 */
export function localSidebarChats(
  workspaces: readonly Workspace[],
  chats: readonly ChatMeta[],
): LocalSidebarChat[] {
  const registered = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const home = noWorkspaceHome(workspaces);
  return chats.flatMap((chat): LocalSidebarChat[] =>
    typeof chat.workspaceId === "string" && registered.has(chat.workspaceId)
      ? [
          {
            key: chat.id,
            projectKey: localSidebarProjectKey(
              home && isNoWorkspace(registered.get(chat.workspaceId)) ? home.id : chat.workspaceId,
            ),
            title: chat.title,
            createdAt: chat.createdAt,
            lastActivityAt: chat.updatedAt,
            chat,
          },
        ]
      : [],
  );
}

/**
 * The one project a scoped sidebar shows (design mode scopes it to the open
 * chat's project) and that project's chats. A No workspace folder scopes to
 * the Chats group. Null when there is nothing to scope to: the project is no
 * longer registered or has no chats left, so the sidebar shows every project.
 */
export function scopedLocalSidebar(
  scopeWorkspaceId: string | null | undefined,
  workspaces: readonly Workspace[],
  projects: readonly LocalSidebarProject[],
  chats: readonly LocalSidebarChat[],
): { project: LocalSidebarProject; chats: LocalSidebarChat[] } | null {
  if (!scopeWorkspaceId || !workspaces.some((workspace) => workspace.id === scopeWorkspaceId)) return null;
  const key = localSidebarProjectKey(sidebarGroupWorkspaceId(scopeWorkspaceId, workspaces));
  const project = projects.find((entry) => entry.key === key);
  if (!project) return null;
  const projectChats = chats.filter((entry) => entry.projectKey === key);
  return projectChats.length > 0 ? { project, chats: projectChats } : null;
}
