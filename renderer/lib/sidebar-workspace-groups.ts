import {
  LOCAL_SIDEBAR_HOST_ID,
  projectOrderKey,
  type SidebarAttention,
  type SidebarChatSummary,
  type SidebarProjectSummary,
} from "./sidebar-organization";
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

export function localSidebarProjects(workspaces: readonly Workspace[]): LocalSidebarProject[] {
  return workspaces.map((workspace) => ({
    key: localSidebarProjectKey(workspace.id),
    name: workspace.name,
    searchText: `${workspace.name} ${workspace.folderPath ?? ""}`,
    createdAt: workspace.createdAt,
    lastActivityAt: workspace.updatedAt,
    workspace,
  }));
}

/**
 * Only chats owned by the supplied workspace registry are admitted, which keeps
 * reserved Assistant, Bot, and removed-workspace records out of the sidebar.
 */
export function localSidebarChats(
  workspaces: readonly Workspace[],
  chats: readonly ChatMeta[],
  attentionFor: (chat: ChatMeta) => SidebarAttention,
): LocalSidebarChat[] {
  const registered = new Set(workspaces.map((workspace) => workspace.id));
  return chats.flatMap((chat): LocalSidebarChat[] =>
    typeof chat.workspaceId === "string" && registered.has(chat.workspaceId)
      ? [
          {
            key: chat.id,
            projectKey: localSidebarProjectKey(chat.workspaceId),
            title: chat.title,
            createdAt: chat.createdAt,
            lastActivityAt: chat.updatedAt,
            attention: attentionFor(chat),
            chat,
          },
        ]
      : [],
  );
}
