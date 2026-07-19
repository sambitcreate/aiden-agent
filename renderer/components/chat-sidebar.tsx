// Chat sidebar: a workspace switcher (change folders), the active workspace's
// chat history with route-driven selection + rename/delete, and a Settings
// footer button.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Sidebar,
  SidebarFooter,
  SidebarList,
  SidebarListGroup,
  SidebarListItem,
  SplitView,
  Text,
} from "./ui";
import { ChevronsUpDown, Folder, FolderGit2, MessagesSquare, Settings } from "lucide-react";
import { chatsApi, pickFolder, workspacesApi } from "../lib/ipc";
import { queryKeys, useChats } from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import type { ChatMeta, Workspace } from "../lib/types";

interface ChatSidebarProps {
  activeChatId: string | undefined;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Time bucket for a chat, e.g. "Recent", "Yesterday", "June", "Older". */
function bucketLabel(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day >= today) return "Recent";
  if (day >= today - DAY_MS) return "Yesterday";
  const d = new Date(ts);
  if (d.getFullYear() === new Date().getFullYear()) return MONTHS[d.getMonth()];
  return "Older";
}

/** Group chats into ordered time buckets, newest first. */
function groupChats(chats: ChatMeta[]): { label: string; chats: ChatMeta[] }[] {
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups: { label: string; chats: ChatMeta[] }[] = [];
  const byLabel = new Map<string, ChatMeta[]>();
  for (const chat of sorted) {
    const label = bucketLabel(chat.updatedAt);
    let arr = byLabel.get(label);
    if (!arr) {
      arr = [];
      byLabel.set(label, arr);
      groups.push({ label, chats: arr });
    }
    arr.push(chat);
  }
  return groups;
}

export function ChatSidebar({ activeChatId }: ChatSidebarProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { workspaces, active, activeId, select } = useActiveWorkspace();
  const chats = useChats(activeId);
  const [search, setSearch] = React.useState("");
  const [renaming, setRenaming] = React.useState<ChatMeta | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleting, setDeleting] = React.useState<ChatMeta | null>(null);
  const [removingWorkspace, setRemovingWorkspace] = React.useState<Workspace | null>(null);

  const items = (chats.data ?? []).filter((c) =>
    c.title.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const groups = groupChats(items);

  // Move to a workspace and land on one of its chats (creating one if empty).
  const enterWorkspace = React.useCallback(
    async (id: string) => {
      select(id);
      const list = await chatsApi.list(id);
      const target = list[0] ?? (await chatsApi.create({ workspaceId: id }));
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
      void navigate({ to: "/chat/$chatId", params: { chatId: target.id } });
    },
    [navigate, qc, select],
  );

  const switchWorkspace = React.useCallback(
    (id: string) => {
      if (id !== activeId) void enterWorkspace(id);
    },
    [activeId, enterWorkspace],
  );

  const openFolderWorkspace = React.useCallback(async () => {
    const folderPath = await pickFolder();
    if (!folderPath) return;
    const ws = await workspacesApi.create({ folderPath, permission: "ask" });
    await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    await enterWorkspace(ws.id);
  }, [enterWorkspace, qc]);

  const newEmptyWorkspace = React.useCallback(async () => {
    const ws = await workspacesApi.create({ permission: "ask" });
    await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    await enterWorkspace(ws.id);
  }, [enterWorkspace, qc]);

  const commitRemoveWorkspace = async () => {
    if (!removingWorkspace) return;
    await workspacesApi.remove(removingWorkspace.id);
    await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    const remaining = workspaces.filter((w) => w.id !== removingWorkspace.id);
    setRemovingWorkspace(null);
    if (remaining[0]) await enterWorkspace(remaining[0].id);
  };

  const commitRename = async () => {
    if (!renaming) return;
    const title = renameValue.trim();
    if (!title) return;
    await chatsApi.rename(renaming.id, title);
    await qc.invalidateQueries({ queryKey: queryKeys.chats });
    await qc.invalidateQueries({ queryKey: queryKeys.chat(renaming.id) });
    setRenaming(null);
  };

  const commitDelete = async () => {
    if (!deleting) return;
    await chatsApi.remove(deleting.id);
    await qc.invalidateQueries({ queryKey: queryKeys.chats });
    if (deleting.id === activeChatId) void navigate({ to: "/" });
    setDeleting(null);
  };

  return (
    <>
      <Sidebar
        searchable
        searchPlaceholder="Search chats…"
        searchValue={search}
        onSearchChange={setSearch}
        actions={<SplitView.SidebarToggle />}
        footer={
          <SidebarFooter>
            <Button
              variant="transparent"
              className="h-10 w-full justify-start gap-2.5 px-2.5 text-[14px] font-normal"
              onClick={() => navigate({ to: "/settings" })}
            >
              <Settings className="size-4.5 text-secondary" />
              Settings
            </Button>
          </SidebarFooter>
        }
      >
        {/* Workspace switcher — change the folder Pi works in. */}
        <div className="px-2.5 pb-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="transparent" className="h-10 w-full justify-between px-2.5 text-[14px] font-normal">
                <span className="flex min-w-0 items-center gap-2.5">
                  {active?.folderPath ? (
                    <FolderGit2 className="size-4 shrink-0 text-secondary" />
                  ) : (
                    <Folder className="size-4 shrink-0 text-secondary" />
                  )}
                  <span className="truncate font-medium">{active?.name ?? "Workspace"}</span>
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-tertiary" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              {workspaces.map((w) => (
                <DropdownMenuCheckboxItem
                  key={w.id}
                  checked={w.id === activeId}
                  sublabel={w.folderPath ?? undefined}
                  onCheckedChange={() => switchWorkspace(w.id)}
                >
                  {w.name}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openFolderWorkspace}>Open folder as workspace…</DropdownMenuItem>
              <DropdownMenuItem onSelect={newEmptyWorkspace}>New empty workspace</DropdownMenuItem>
              {active && workspaces.length > 1 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem icon="trash" color="red" onSelect={() => setRemovingWorkspace(active)}>
                    Remove “{active.name}”
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <SidebarList>
          {groups.length === 0 ? (
            <EmptyState
              placement="inline"
              title={search.trim() ? "No matches" : "No chats yet"}
              description={
                search.trim()
                  ? "Try a different search."
                  : "Start a new conversation to see it here."
              }
            />
          ) : (
            groups.map((group) => (
              <SidebarListGroup key={group.label} title={group.label}>
                {group.chats.map((chat) => (
                  <ContextMenu key={chat.id}>
                    <ContextMenuTrigger asChild>
                      <SidebarListItem
                        icon={<MessagesSquare className="size-4" />}
                        title={chat.title}
                        selected={chat.id === activeChatId}
                        onClick={() => navigate({ to: "/chat/$chatId", params: { chatId: chat.id } })}
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        icon="pencil"
                        onSelect={() => {
                          setRenameValue(chat.title);
                          setRenaming(chat);
                        }}
                      >
                        Rename
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem icon="trash" color="red" onSelect={() => setDeleting(chat)}>
                        Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </SidebarListGroup>
            ))
          )}
        </SidebarList>
      </Sidebar>

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="Rename chat"
        confirmLabel="Save"
        confirmDisabled={!renameValue.trim()}
        onConfirm={commitRename}
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="Chat name"
          autoFocus
        />
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this chat?"
        description={
          deleting ? (
            <Text variant="small" color="secondary">
              “{deleting.title}” and its messages will be permanently removed.
            </Text>
          ) : null
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={commitDelete}
      />

      <AlertDialog
        open={removingWorkspace !== null}
        onOpenChange={(open) => !open && setRemovingWorkspace(null)}
        title="Remove this workspace?"
        description={
          removingWorkspace ? (
            <Text variant="small" color="secondary">
              “{removingWorkspace.name}” will be removed. Its chats stay on disk but won’t be listed. The folder
              itself is not touched.
            </Text>
          ) : null
        }
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={commitRemoveWorkspace}
      />
    </>
  );
}
