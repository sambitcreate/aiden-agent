// Chat sidebar: a workspace switcher (change folders), the active workspace's
// chat history with route-driven selection + rename/delete, and a Settings
// footer button.

import * as React from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
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
  toast,
} from "./ui";
import {
  ChevronsUpDown,
  Folder,
  FolderGit2,
  Loader2,
  Settings,
  UserRound,
} from "lucide-react";
import { chatsApi, gitApi, workspacesApi } from "../lib/ipc";
import {
  CHAT_TITLE_FADE_OUT_MS,
  createChatTitleReveal,
  type ChatTitleRevealEvent,
} from "../lib/chat-title-reveal";
import {
  COMMAND_CHAT_SHORTCUT_REVEAL_MS,
  commandChatShortcutNumber,
  createSidebarChatShortcutAssignments,
} from "../lib/sidebar-chat-shortcuts";
import { queryKeys, useChats, useFoundationModelsConnection } from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useEnvironmentPanel } from "./environment-panel";
import type { ChatMeta, Workspace } from "../lib/types";

interface ChatSidebarProps {
  activeChatId: string | undefined;
  titleReveal?: ChatTitleRevealEvent | null;
}

function GeneratedTitleReveal({ previousTitle, title }: { previousTitle: string; title: string }) {
  const characters = createChatTitleReveal(title);

  return (
    <span className="inline-grid max-w-full">
      <span className="sr-only">{title}</span>
      <span
        aria-hidden="true"
        className="chat-title-reveal-previous col-start-1 row-start-1 truncate"
      >
        {previousTitle}
      </span>
      <span aria-hidden="true" className="col-start-1 row-start-1 whitespace-nowrap">
        {characters.map(({ value, delayMs }, index) => (
          <span
            className="chat-title-reveal-character inline-block"
            key={`${index}-${value}`}
            style={{ animationDelay: `${CHAT_TITLE_FADE_OUT_MS + delayMs}ms` }}
          >
            {value === " " ? "\u00a0" : value}
          </span>
        ))}
      </span>
    </span>
  );
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
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

export function ChatSidebar({ activeChatId, titleReveal }: ChatSidebarProps) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  const { workspaces, active, activeId, select } = useActiveWorkspace();
  const environmentPanel = useEnvironmentPanel();
  const chats = useChats(activeId);
  const foundationModels = useFoundationModelsConnection();
  const [search, setSearch] = React.useState("");
  const [renaming, setRenaming] = React.useState<ChatMeta | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renamingWithAppleId, setRenamingWithAppleId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<ChatMeta | null>(null);
  const [removingWorkspace, setRemovingWorkspace] = React.useState<Workspace | null>(null);
  const [removingWorkspaceBusy, setRemovingWorkspaceBusy] = React.useState(false);
  const [deletingWorktree, setDeletingWorktree] = React.useState<Workspace | null>(null);
  const [deletingWorktreeBusy, setDeletingWorktreeBusy] = React.useState(false);
  const [chatShortcutsVisible, setChatShortcutsVisible] = React.useState(false);
  const shortcutRevealTimerRef = React.useRef<number | null>(null);
  const heldCommandKeysRef = React.useRef(new Set<string>());

  const orderedGroups = React.useMemo(() => groupChats(chats.data ?? []), [chats.data]);
  const groups = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return orderedGroups;

    return orderedGroups.flatMap((group) => {
      const matches = group.chats.filter((chat) => chat.title.toLowerCase().includes(query));
      return matches.length > 0 ? [{ ...group, chats: matches }] : [];
    });
  }, [orderedGroups, search]);
  const shortcutAssignments = React.useMemo(
    () => createSidebarChatShortcutAssignments(orderedGroups),
    [orderedGroups],
  );
  const shortcutAssignmentsRef = React.useRef(shortcutAssignments);
  shortcutAssignmentsRef.current = shortcutAssignments;
  const shortcutNumberByChatId = React.useMemo(
    () => new Map(shortcutAssignments.map(({ chat, number }) => [chat.id, number])),
    [shortcutAssignments],
  );
  const appleRenameReady = foundationModels.data?.state === "ready";
  const appleRenameDetail = foundationModels.isLoading
    ? "Checking Apple Foundation Models availability."
    : foundationModels.data?.detail ?? "Apple Foundation Models are unavailable.";
  const workspaceActionBlocked = environmentPanel.editorState.saving || environmentPanel.gitOperationBusy;
  const workspaceSwitchBlocked = workspaceActionBlocked || environmentPanel.editorState.dirty;
  const settingsBlockedReason = environmentPanel.gitOperationBusy
    ? "Wait for the current Git operation to finish"
    : environmentPanel.editorState.saving
      ? "Wait for the open file to finish saving"
      : environmentPanel.editorState.dirty
        ? "Save or discard the open file's edits first"
        : undefined;

  React.useEffect(() => {
    const clearRevealTimer = () => {
      if (shortcutRevealTimerRef.current === null) return;
      window.clearTimeout(shortcutRevealTimerRef.current);
      shortcutRevealTimerRef.current = null;
    };
    const hideShortcuts = () => {
      heldCommandKeysRef.current.clear();
      clearRevealTimer();
      setChatShortcutsVisible(false);
    };
    const isCommandKey = (event: KeyboardEvent) =>
      event.key === "Meta" || event.code === "MetaLeft" || event.code === "MetaRight";

    const onKeyDown = (event: KeyboardEvent) => {
      if (isCommandKey(event)) {
        const commandKey = event.code || "Meta";
        const wasAlreadyHeld = heldCommandKeysRef.current.has(commandKey);
        heldCommandKeysRef.current.add(commandKey);
        if (!wasAlreadyHeld && shortcutRevealTimerRef.current === null) {
          shortcutRevealTimerRef.current = window.setTimeout(() => {
            shortcutRevealTimerRef.current = null;
            if (heldCommandKeysRef.current.size > 0) setChatShortcutsVisible(true);
          }, COMMAND_CHAT_SHORTCUT_REVEAL_MS);
        }
        return;
      }

      if (
        event.defaultPrevented ||
        document.querySelector('[data-slot="dialog-content"][data-state="open"]')
      ) {
        return;
      }

      const shortcutNumber = commandChatShortcutNumber(event);
      if (shortcutNumber === null) return;
      const assignment = shortcutAssignmentsRef.current[shortcutNumber - 1];
      if (!assignment) return;

      event.preventDefault();
      void navigate({ to: "/chat/$chatId", params: { chatId: assignment.chat.id } });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isCommandKey(event)) return;
      heldCommandKeysRef.current.delete(event.code || "Meta");
      if (heldCommandKeysRef.current.size === 0) hideShortcuts();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") hideShortcuts();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", hideShortcuts);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", hideShortcuts);
      heldCommandKeysRef.current.clear();
      clearRevealTimer();
    };
  }, [navigate]);

  // Move to a workspace and land on one of its chats (creating one if empty).
  const enterWorkspace = React.useCallback(
    async (id: string, allowDirtyDiscard = false) => {
      if (environmentPanel.gitOperationBusy) {
        toast.info("Wait for the current Git operation to finish before switching workspaces.");
        return false;
      }
      if (environmentPanel.editorState.saving) {
        toast.info("Wait for the open file to finish saving before switching workspaces.");
        return false;
      }
      if (environmentPanel.editorState.dirty && !allowDirtyDiscard) {
        toast.info("Save or discard the open file's edits before switching workspaces.");
        return false;
      }
      if (environmentPanel.agentBusy) environmentPanel.cancelAgent?.();
      const list = await chatsApi.list(id);
      const target = list[0] ?? (await chatsApi.create({ workspaceId: id }));
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
      const previousWorkspaceId = activeId;
      select(id);
      try {
        await navigate({ to: "/chat/$chatId", params: { chatId: target.id } });
      } catch (error) {
        if (previousWorkspaceId) select(previousWorkspaceId);
        throw error;
      }
      return true;
    },
    [activeId, environmentPanel.agentBusy, environmentPanel.cancelAgent, environmentPanel.editorState.dirty, environmentPanel.editorState.saving, environmentPanel.gitOperationBusy, navigate, qc, select],
  );

  const switchWorkspace = React.useCallback(
    (id: string) => {
      if (id !== activeId) void enterWorkspace(id);
    },
    [activeId, enterWorkspace],
  );

  const openFolderWorkspace = React.useCallback(async () => {
    if (workspaceSwitchBlocked) return;
    const ws = await workspacesApi.createFromFolder();
    if (!ws) return;
    await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    await enterWorkspace(ws.id);
  }, [enterWorkspace, qc, workspaceSwitchBlocked]);

  const newEmptyWorkspace = React.useCallback(async () => {
    if (workspaceSwitchBlocked) return;
    const ws = await workspacesApi.create({ permission: "ask" });
    await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    await enterWorkspace(ws.id);
  }, [enterWorkspace, qc, workspaceSwitchBlocked]);

  const commitRemoveWorkspace = async () => {
    if (!removingWorkspace || removingWorkspaceBusy) return;
    if (environmentPanel.gitOperationBusy) {
      toast.info("Wait for the current Git operation to finish before removing this workspace.");
      return;
    }
    if (environmentPanel.editorState.saving) {
      toast.info("Wait for the open file to finish saving before removing this workspace.");
      return;
    }
    const remaining = workspaces.filter((w) => w.id !== removingWorkspace.id);
    if (!remaining[0]) return;
    setRemovingWorkspaceBusy(true);
    try {
      const switched = await enterWorkspace(remaining[0].id, true);
      if (!switched) return;
      await workspacesApi.remove(removingWorkspace.id);
      await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      setRemovingWorkspace(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't remove that workspace.");
    } finally {
      setRemovingWorkspaceBusy(false);
    }
  };

  const commitDeleteWorktree = async () => {
    const target = deletingWorktree;
    if (!target || deletingWorktreeBusy) return;
    if (environmentPanel.gitOperationBusy) {
      toast.info("Wait for the current Git operation to finish before deleting this worktree.");
      return;
    }
    if (environmentPanel.editorState.saving) {
      toast.info("Wait for the open file to finish saving before deleting this worktree.");
      return;
    }
    if (environmentPanel.agentBusy) environmentPanel.cancelAgent?.();
    const remaining = workspaces.filter((workspace) => workspace.id !== target.id);
    if (!remaining[0]) return;
    setDeletingWorktreeBusy(true);
    let gitBusy = false;
    try {
      const switched = await enterWorkspace(remaining[0].id, true);
      if (!switched) return;
      environmentPanel.setGitOperationBusy(true);
      gitBusy = true;
      const result = await gitApi.deleteManagedWorktree(target.id);
      await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
      setDeletingWorktree(null);
      toast.success(
        result.branchDeleted
          ? "Worktree and unchanged branch deleted."
          : "Worktree deleted; branch kept.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't delete that worktree.");
    } finally {
      if (gitBusy) environmentPanel.setGitOperationBusy(false);
      setDeletingWorktreeBusy(false);
    }
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

  const renameWithApple = async (chat: ChatMeta) => {
    if (renamingWithAppleId) return;
    if (!appleRenameReady) {
      toast.info(appleRenameDetail);
      return;
    }
    setRenamingWithAppleId(chat.id);
    try {
      const result = await chatsApi.renameWithFoundationModels(chat.id);
      if (result.changed) toast.success(`Renamed to “${result.title}”.`);
      else toast.info(`“${result.title}” already fits this chat.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Apple couldn't rename that chat.");
      await qc.invalidateQueries({ queryKey: queryKeys.foundationModelsConnection });
    } finally {
      setRenamingWithAppleId(null);
    }
  };

  const commitDelete = async () => {
    if (!deleting) return;
    if (deleting.id === activeChatId && environmentPanel.agentBusy) {
      environmentPanel.cancelAgent?.();
    }
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
            <div className="flex flex-col gap-0.5" title={settingsBlockedReason}>
              <SidebarListItem
                icon={<UserRound />}
                title="Profile"
                selected={pathname === "/profile"}
                disabled={Boolean(settingsBlockedReason)}
                onClick={() => navigate({ to: "/profile" })}
              />
              <SidebarListItem
                icon={<Settings />}
                title="Settings"
                selected={pathname === "/settings"}
                disabled={Boolean(settingsBlockedReason)}
                onClick={() => navigate({ to: "/settings" })}
              />
            </div>
          </SidebarFooter>
        }
      >
        {/* Workspace switcher — change the folder Pi works in. */}
        <div className="px-2.5 pb-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="transparent"
                className="h-10 w-full justify-between px-2.5 text-[14px] font-normal"
              >
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
            <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              {workspaces.map((w) => (
                <DropdownMenuCheckboxItem
                  key={w.id}
                  checked={w.id === activeId}
                  disabled={workspaceSwitchBlocked}
                  sublabel={w.folderPath ?? undefined}
                  onCheckedChange={() => switchWorkspace(w.id)}
                >
                  {w.name}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={workspaceSwitchBlocked} onSelect={openFolderWorkspace}>
                Open folder as workspace…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={workspaceSwitchBlocked} onSelect={newEmptyWorkspace}>
                New empty workspace
              </DropdownMenuItem>
              {active && workspaces.length > 1 ? (
                <>
                  <DropdownMenuSeparator />
                  {active.managedWorktree ? (
                    <DropdownMenuItem
                      disabled={workspaceActionBlocked}
                      icon="trash"
                      color="red"
                      onSelect={() => setDeletingWorktree(active)}
                    >
                      Delete worktree…
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    disabled={workspaceActionBlocked}
                    icon="trash"
                    color="red"
                    onSelect={() => setRemovingWorkspace(active)}
                  >
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
                {group.chats.map((chat) => {
                  const shortcutNumber = shortcutNumberByChatId.get(chat.id);
                  return <ContextMenu key={chat.id}>
                    <ContextMenuTrigger asChild>
                      <SidebarListItem
                        icon={
                          renamingWithAppleId === chat.id
                            ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            : undefined
                        }
                        aria-busy={renamingWithAppleId === chat.id}
                        title={
                          titleReveal?.chatId === chat.id ? (
                            <GeneratedTitleReveal
                              key={`${chat.id}-${titleReveal.version}`}
                              previousTitle={titleReveal.previousTitle}
                              title={chat.title}
                            />
                          ) : (
                            chat.title
                          )
                        }
                        trailing={
                          chatShortcutsVisible && shortcutNumber ? (
                            <kbd
                              aria-hidden="true"
                              className="inline-flex h-5 min-w-8 items-center justify-center rounded-pill bg-control px-1.5 font-sans text-mini font-medium tabular-nums text-tertiary"
                            >
                              ⌘{shortcutNumber}
                            </kbd>
                          ) : undefined
                        }
                        aria-keyshortcuts={shortcutNumber ? `Meta+${shortcutNumber}` : undefined}
                        selected={chat.id === activeChatId}
                        onClick={() =>
                          navigate({ to: "/chat/$chatId", params: { chatId: chat.id } })
                        }
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        icon="pencil"
                        disabled={renamingWithAppleId === chat.id}
                        onSelect={() => {
                          setRenameValue(chat.title);
                          setRenaming(chat);
                        }}
                      >
                        Rename
                      </ContextMenuItem>
                      {foundationModels.data !== null ? (
                        <ContextMenuItem
                          disabled={!appleRenameReady || renamingWithAppleId !== null}
                          aria-label={
                            renamingWithAppleId === chat.id
                              ? "Renaming with Apple"
                              : appleRenameReady
                                ? "Rename with Apple"
                                : `Rename with Apple. ${appleRenameDetail}`
                          }
                          onSelect={() => void renameWithApple(chat)}
                        >
                          <span className="min-w-0 flex-1">
                            {renamingWithAppleId === chat.id ? "Renaming with Apple…" : "Rename with Apple"}
                          </span>
                          {!appleRenameReady ? (
                            <span className="text-small text-tertiary">
                              {foundationModels.isLoading ? "Checking…" : "Unavailable"}
                            </span>
                          ) : null}
                        </ContextMenuItem>
                      ) : null}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon="trash"
                        color="red"
                        disabled={renamingWithAppleId === chat.id}
                        onSelect={() => setDeleting(chat)}
                      >
                        Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>;
                })}
              </SidebarListGroup>
            ))
          )}
        </SidebarList>
      </Sidebar>

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="Rename chat"
        description="Choose the name shown for this conversation in the sidebar."
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
        open={deletingWorktree !== null}
        onOpenChange={(open) => !open && !deletingWorktreeBusy && setDeletingWorktree(null)}
        title="Delete this worktree?"
        description={
          deletingWorktree ? (
            <Text variant="small" color="secondary">
              The clean checkout for “{deletingWorktree.name}” will be removed. Its branch is deleted only if it
              has no commits beyond where Aiden created it. Chats stay on disk. Dirty worktrees are refused.
              {environmentPanel.editorState.workspaceId === deletingWorktree.id && environmentPanel.editorState.dirty
                ? ` The unsaved edit to ${environmentPanel.editorState.path ?? "the open file"} will be discarded.`
                : ""}
            </Text>
          ) : null
        }
        confirmLabel={deletingWorktreeBusy ? "Deleting…" : "Delete worktree"}
        confirmVariant="destructive"
        busy={deletingWorktreeBusy}
        keepOpenOnConfirm
        onConfirm={commitDeleteWorktree}
      />

      <AlertDialog
        open={removingWorkspace !== null}
        onOpenChange={(open) => !open && !removingWorkspaceBusy && setRemovingWorkspace(null)}
        title="Remove this workspace?"
        description={
          removingWorkspace ? (
            <Text variant="small" color="secondary">
              “{removingWorkspace.name}” will be removed. Its chats stay on disk but won’t be listed. The folder
              itself is not touched.
              {environmentPanel.editorState.workspaceId === removingWorkspace.id && environmentPanel.editorState.dirty
                ? ` The unsaved edit to ${environmentPanel.editorState.path ?? "the open file"} will be discarded.`
                : ""}
            </Text>
          ) : null
        }
        confirmLabel={removingWorkspaceBusy ? "Removing…" : "Remove"}
        confirmVariant="destructive"
        busy={removingWorkspaceBusy}
        keepOpenOnConfirm
        onConfirm={commitRemoveWorkspace}
      />
    </>
  );
}
