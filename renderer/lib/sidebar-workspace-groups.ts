import type { ChatMeta, Workspace } from "./types";

export type SidebarOrganization = "workspace" | "recent";

export interface SidebarWorkspaceGroup {
  workspace: Workspace;
  chats: ChatMeta[];
  newestActivityAt: number;
}

export interface SidebarWorkspaceProjection {
  groups: SidebarWorkspaceGroup[];
  recents: ChatMeta[];
}

export interface SidebarPreferencesV1 {
  organization: SidebarOrganization;
  expandedWorkspaceIds: string[];
}

const MAX_PERSISTED_EXPANSIONS = 200;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function newestFirst(left: ChatMeta, right: ChatMeta): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

function searchableWorkspaceText(workspace: Workspace): string {
  return `${workspace.name} ${workspace.folderPath ?? ""}`.toLocaleLowerCase();
}

/**
 * Builds the one workspace/chat graph used by both the grouped outline and the
 * flat Recent view. Only chats owned by the supplied workspace registry are
 * admitted, which keeps reserved Assistant and removed-workspace records out.
 */
export function projectSidebarWorkspaces(
  workspaces: readonly Workspace[],
  chats: readonly ChatMeta[],
  search: string,
): SidebarWorkspaceProjection {
  const query = search.trim().toLocaleLowerCase();
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const regularChats = chats
    .filter(
      (chat): chat is ChatMeta & { workspaceId: string } =>
        typeof chat.workspaceId === "string" && workspaceById.has(chat.workspaceId),
    )
    .sort(newestFirst);
  const chatsByWorkspace = new Map<string, ChatMeta[]>();
  for (const chat of regularChats) {
    const owned = chatsByWorkspace.get(chat.workspaceId!) ?? [];
    owned.push(chat);
    chatsByWorkspace.set(chat.workspaceId!, owned);
  }

  const groups = workspaces
    .flatMap((workspace): SidebarWorkspaceGroup[] => {
      const allChats = chatsByWorkspace.get(workspace.id) ?? [];
      const workspaceMatches =
        query.length > 0 && searchableWorkspaceText(workspace).includes(query);
      const visibleChats =
        query.length === 0 || workspaceMatches
          ? allChats
          : allChats.filter((chat) => chat.title.toLocaleLowerCase().includes(query));
      if (query.length > 0 && !workspaceMatches && visibleChats.length === 0) return [];
      return [
        {
          workspace,
          chats: visibleChats,
          newestActivityAt: Math.max(workspace.updatedAt, allChats[0]?.updatedAt ?? 0),
        },
      ];
    })
    .sort(
      (left, right) =>
        right.newestActivityAt - left.newestActivityAt ||
        left.workspace.name.localeCompare(right.workspace.name) ||
        left.workspace.id.localeCompare(right.workspace.id),
    );

  const recents = regularChats.filter((chat) => {
    if (!query) return true;
    const workspace = workspaceById.get(chat.workspaceId!);
    return (
      chat.title.toLocaleLowerCase().includes(query) ||
      (workspace ? searchableWorkspaceText(workspace).includes(query) : false)
    );
  });

  return { groups, recents };
}

export function parseSidebarPreferences(
  value: string | null,
  validWorkspaceIds?: readonly string[],
): SidebarPreferencesV1 {
  const valid = validWorkspaceIds ? new Set(validWorkspaceIds) : null;
  try {
    const parsed = value ? (JSON.parse(value) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const record = parsed as Record<string, unknown>;
    const organization: SidebarOrganization =
      record.organization === "recent" ? "recent" : "workspace";
    const expandedWorkspaceIds = Array.isArray(record.expandedWorkspaceIds)
      ? Array.from(
          new Set(
            record.expandedWorkspaceIds
              .filter(
                (id): id is string =>
                  typeof id === "string" &&
                  SAFE_WORKSPACE_ID.test(id) &&
                  (valid === null || valid.has(id)),
              )
              .slice(0, MAX_PERSISTED_EXPANSIONS),
          ),
        )
      : [];
    return { organization, expandedWorkspaceIds };
  } catch {
    return { organization: "workspace", expandedWorkspaceIds: [] };
  }
}
