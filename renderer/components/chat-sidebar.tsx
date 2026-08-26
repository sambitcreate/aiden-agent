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
  Clock3,
  Folder,
  FolderGit2,
  Loader2,
  Settings,
  SquarePen,
  UserRound,
} from "lucide-react";
import { appUpdatesApi, chatsApi, gitApi, workspacesApi } from "../lib/ipc";
import { truncatePathMiddle } from "../lib/truncate-path";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";
import {
  CHAT_TITLE_FADE_OUT_MS,
  createChatTitleReveal,
  type ChatTitleRevealEvent,
} from "../lib/chat-title-reveal";
import {
  COMMAND_CHAT_SHORTCUT_REVEAL_MS,
  chatShortcutRevealModifierSets,
  createSidebarChatShortcutAssignments,
  sidebarChatNavigationTargets,
} from "../lib/sidebar-chat-shortcuts";
import { queryKeys, useChats, useFoundationModelsConnection } from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useEnvironmentPanel } from "./environment-panel";
import type { ChatMeta, Workspace } from "../lib/types";
import { useCommandSystem } from "../lib/command-system";
import type { CommandId } from "../shared/keybindings";
import { ariaKeyShortcut, prettyAccelerator } from "../shared/keybindings";
import { removeDeletedChatFromCache } from "../lib/chat-deletion-cache";
import { useAppUpdateSnapshot } from "../lib/use-app-update-snapshot";
import type { AppUpdateRestartResult, AppUpdateSnapshot } from "../shared/app-update";
import { useActiveChatIds } from "../lib/use-chat-activity";
import { RemoteConnectionPopover } from "./remote-connection-popover";
import { useAppCapabilities } from "../lib/app-capabilities";

const AIDEN_MARK_URL = new URL("../../resources/app-icon.png", import.meta.url).href;
/** Must match aiden-app-update-banner-out in styles.css. */
const APP_UPDATE_BANNER_EXIT_MS = 120;

interface ChatSidebarProps {
  activeChatId: string | undefined;
  titleReveal?: ChatTitleRevealEvent | null;
}

function updateRestartError(result: AppUpdateRestartResult): string | null {
  if (result.accepted) return null;
  switch (result.reason) {
    case "busy":
      return "Aiden is already preparing another window action.";
    case "not-ready":
      return "That update is no longer ready. Check for updates again.";
    case "unavailable":
      return "Aiden could not restart into the update.";
  }
}

function updateBannerKey(snapshot: AppUpdateSnapshot): string | null {
  switch (snapshot.status) {
    case "downloading":
    case "ready":
      return `${snapshot.status}:${snapshot.version}`;
    case "error":
      return `${snapshot.status}:${snapshot.error}:${snapshot.version ?? "unknown"}`;
    case "checking":
    case "idle":
      return null;
  }
}

function UpdateReadyBanner({ blockedReason }: { blockedReason?: string }) {
  const snapshot = useAppUpdateSnapshot();
  const [dismissedKey, setDismissedKey] = React.useState<string | null>(null);
  const [restarting, setRestarting] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const [present, setPresent] = React.useState(false);
  const [displayedSnapshot, setDisplayedSnapshot] = React.useState<AppUpdateSnapshot>(snapshot);
  const titleId = React.useId();
  const bannerKey = updateBannerKey(snapshot);
  const open = bannerKey !== null && dismissedKey !== bannerKey;

  React.useEffect(() => {
    if (snapshot.status !== "ready") setRestarting(false);
    if (snapshot.status !== "error") setRetrying(false);
    if (bannerKey === null) setDismissedKey(null);
  }, [bannerKey, snapshot.status]);

  // Keep the banner mounted through its exit animation, matching Aiden's
  // environment summary and assistant dock presence primitives.
  React.useLayoutEffect(() => {
    if (open) {
      setDisplayedSnapshot(snapshot);
      setPresent(true);
      return;
    }
    if (!present) return;
    if (document.documentElement.dataset.reduceMotion === "true") {
      setPresent(false);
      return;
    }
    const timeout = window.setTimeout(() => setPresent(false), APP_UPDATE_BANNER_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [open, present, snapshot]);

  const restart = async () => {
    if (!open) return;
    if (blockedReason) {
      toast.info(blockedReason);
      return;
    }
    setRestarting(true);
    try {
      const result = await appUpdatesApi.restart();
      const message = updateRestartError(result);
      if (message) {
        setRestarting(false);
        toast.error(message);
      } else {
        window.setTimeout(() => setRestarting(false), 10_000);
      }
    } catch (error) {
      setRestarting(false);
      toast.error(error instanceof Error ? error.message : "Aiden could not restart.");
    }
  };

  const retry = async () => {
    if (!open || displayedSnapshot.status !== "error") return;
    setRetrying(true);
    try {
      const result = await appUpdatesApi.check();
      if (result.outcome === "unavailable") {
        setRetrying(false);
        toast.error("Automatic updates are unavailable in this build.");
      }
    } catch {
      setRetrying(false);
      toast.error("Aiden could not start another update check.");
    }
  };

  if (!present || updateBannerKey(displayedSnapshot) === null) return null;

  const displayedVersion =
    displayedSnapshot.status === "downloading" ||
    displayedSnapshot.status === "ready" ||
    displayedSnapshot.status === "error"
      ? displayedSnapshot.version
      : null;
  const title =
    displayedSnapshot.status === "downloading"
      ? "Downloading update"
      : displayedSnapshot.status === "error"
        ? displayedSnapshot.error === "download-failed"
          ? "Update download failed"
          : "Update check failed"
        : "Update ready";
  const description =
    displayedSnapshot.status === "downloading"
      ? displayedSnapshot.percent === null
        ? "Preparing the download…"
        : `${Math.floor(displayedSnapshot.percent)}% downloaded`
      : displayedSnapshot.status === "error"
        ? "Check your connection and try again."
        : (blockedReason ?? "Restart to finish installing.");

  return (
    <section
      aria-labelledby={titleId}
      aria-hidden={!open ? true : undefined}
      className="app-update-banner mb-2 origin-bottom rounded-card bg-control/70 px-3 py-3 text-primary"
      data-state={open ? "open" : "closed"}
      inert={!open ? true : undefined}
    >
      <div className="flex items-start gap-2.5">
        <img src={AIDEN_MARK_URL} alt="" className="size-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-small-strong">
            {title}
          </h2>
          {displayedVersion ? (
            <p className="mt-0.5 truncate text-small text-secondary">
              Aiden Agent {displayedVersion}
            </p>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-small text-secondary">{description}</p>
      {displayedSnapshot.status === "downloading" && displayedSnapshot.percent !== null ? (
        <div
          className="mt-2 h-1 overflow-hidden rounded-full bg-control"
          role="progressbar"
          aria-label="Update download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(displayedSnapshot.percent)}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${displayedSnapshot.percent}%` }}
          />
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-1">
        <Button
          size="small"
          variant="transparent"
          disabled={!open || restarting || retrying}
          onClick={() => setDismissedKey(updateBannerKey(displayedSnapshot))}
        >
          {displayedSnapshot.status === "ready" ? "Later" : "Hide"}
        </Button>
        {displayedSnapshot.status === "error" ? (
          <Button
            size="small"
            variant="accent"
            disabled={!open || retrying}
            onClick={() => void retry()}
          >
            {retrying ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {retrying ? "Retrying…" : "Try again"}
          </Button>
        ) : displayedSnapshot.status === "ready" ? (
          <Button
            size="small"
            variant="accent"
            disabled={!open || restarting || Boolean(blockedReason)}
            title={blockedReason}
            onClick={() => void restart()}
          >
            {restarting ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                Restarting…
              </>
            ) : (
              "Update and restart"
            )}
          </Button>
        ) : null}
      </div>
    </section>
  );
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

function ChatActivityIndicator() {
  return (
    <span
      role="img"
      aria-label="Working"
      title="Working"
      className="inline-flex size-5 items-center justify-center text-accent"
    >
      {/* A static open ring communicates in-progress work without an animation clock. */}
      <Loader2 className="size-4" aria-hidden="true" />
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
  const capabilities = useAppCapabilities();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  const { workspaces, active, activeId, select } = useActiveWorkspace();
  const environmentPanel = useEnvironmentPanel();
  const activeChatIds = useActiveChatIds();
  const appendReconciliationRequired = useAppendReconciliationRequired();
  const chats = useChats(activeId);
  const foundationModels = useFoundationModelsConnection(capabilities.appleFoundationModels);
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
  const orderedChats = React.useMemo(
    () => orderedGroups.flatMap((group) => group.chats),
    [orderedGroups],
  );
  const chatNavigationTargets = React.useMemo(
    () => sidebarChatNavigationTargets(orderedChats, activeChatId),
    [activeChatId, orderedChats],
  );
  const { binding: commandBinding, register: registerCommand } = useCommandSystem();
  const chatJumpBindings = Array.from({ length: 9 }, (_, index) =>
    commandBinding(`chat.jump.${index + 1}` as CommandId),
  );
  const revealModifierSignature = chatShortcutRevealModifierSets(chatJumpBindings)
    .map((modifiers) => modifiers.join("+"))
    .join("|");
  const shortcutNumberByChatId = React.useMemo(
    () => new Map(shortcutAssignments.map(({ chat, number }) => [chat.id, number])),
    [shortcutAssignments],
  );
  const appleRenameReady = foundationModels.data?.state === "ready";
  const appleRenameDetail = foundationModels.isLoading
    ? "Checking Apple Foundation Models availability."
    : (foundationModels.data?.detail ?? "Apple Foundation Models are unavailable.");
  const workspaceActionBlocked =
    environmentPanel.editorState.saving || environmentPanel.gitOperationBusy;
  const workspaceSwitchBlocked = workspaceActionBlocked || environmentPanel.editorState.dirty;
  const settingsBlockedReason = environmentPanel.gitOperationBusy
    ? "Wait for the current Git operation to finish"
    : environmentPanel.editorState.saving
      ? "Wait for the open file to finish saving"
      : environmentPanel.editorState.dirty
        ? "Save or discard the open file's edits first"
        : undefined;
  const updateRestartBlockedReason = environmentPanel.gitOperationBusy
    ? "Wait for the current Git operation to finish before restarting."
    : environmentPanel.editorState.saving
      ? "Wait for the open file to finish saving before restarting."
      : undefined;
  const openChat = React.useCallback(
    (chatId: string | undefined) => {
      if (!chatId) return;
      if (settingsBlockedReason) {
        toast.info(settingsBlockedReason);
        return;
      }
      void navigate({ to: "/chat/$chatId", params: { chatId } });
    },
    [navigate, settingsBlockedReason],
  );
  const openRemoteSettings = React.useCallback(() => {
    if (settingsBlockedReason) {
      toast.info(settingsBlockedReason);
      return;
    }
    void navigate({ to: "/settings", search: { section: "remoteAccess" } });
  }, [navigate, settingsBlockedReason]);

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
    const revealModifierSets = revealModifierSignature
      .split("|")
      .filter(Boolean)
      .map((signature) => signature.split("+"));
    const revealModifiers = new Set(revealModifierSets.flat());
    const hasCompleteModifierSet = () =>
      revealModifierSets.some((required) =>
        required.every((modifier) => heldCommandKeysRef.current.has(modifier)),
      );
    const eventModifier = (event: KeyboardEvent) =>
      ["Meta", "Control", "Alt", "Shift"].includes(event.key) ? event.key : null;

    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = eventModifier(event);
      if (modifier && revealModifiers.has(modifier)) {
        const wasAlreadyHeld = heldCommandKeysRef.current.has(modifier);
        heldCommandKeysRef.current.add(modifier);
        if (
          !wasAlreadyHeld &&
          hasCompleteModifierSet() &&
          shortcutRevealTimerRef.current === null
        ) {
          shortcutRevealTimerRef.current = window.setTimeout(() => {
            shortcutRevealTimerRef.current = null;
            if (hasCompleteModifierSet()) setChatShortcutsVisible(true);
          }, COMMAND_CHAT_SHORTCUT_REVEAL_MS);
        }
        return;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const modifier = eventModifier(event);
      if (!modifier || !revealModifiers.has(modifier)) return;
      heldCommandKeysRef.current.delete(modifier);
      if (heldCommandKeysRef.current.size === 0) {
        hideShortcuts();
      } else if (!hasCompleteModifierSet()) {
        clearRevealTimer();
        setChatShortcutsVisible(false);
      }
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
  }, [revealModifierSignature]);

  React.useEffect(() => {
    const unregister = shortcutAssignments.map(({ chat, number }) =>
      registerCommand(`chat.jump.${number}` as CommandId, () => {
        openChat(chat.id);
      }),
    );
    if (chatNavigationTargets.previous) {
      unregister.push(
        registerCommand("chat.previous", () => {
          openChat(chatNavigationTargets.previous?.id);
        }),
      );
    }
    if (chatNavigationTargets.next) {
      unregister.push(
        registerCommand("chat.next", () => {
          openChat(chatNavigationTargets.next?.id);
        }),
      );
    }
    return () => unregister.forEach((dispose) => dispose());
  }, [chatNavigationTargets, openChat, registerCommand, shortcutAssignments]);

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
      if (list.length === 0 && appendReconciliationRequired) {
        toast.error("Reload Aiden before creating a chat in this workspace.");
        return false;
      }
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
    [
      activeId,
      appendReconciliationRequired,
      environmentPanel.agentBusy,
      environmentPanel.cancelAgent,
      environmentPanel.editorState.dirty,
      environmentPanel.editorState.saving,
      environmentPanel.gitOperationBusy,
      navigate,
      qc,
      select,
    ],
  );

  const switchWorkspace = React.useCallback(
    (id: string) => {
      if (id !== activeId) {
        void enterWorkspace(id).catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Aiden could not switch workspaces.");
        });
      }
    },
    [activeId, enterWorkspace],
  );

  const openFolderWorkspace = React.useCallback(async () => {
    if (workspaceSwitchBlocked || appendReconciliationRequired) return;
    const ws = await workspacesApi.createFromFolder();
    if (!ws) return;
    await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    await enterWorkspace(ws.id);
  }, [appendReconciliationRequired, enterWorkspace, qc, workspaceSwitchBlocked]);

  const newEmptyWorkspace = React.useCallback(async () => {
    if (workspaceSwitchBlocked || appendReconciliationRequired) return;
    const ws = await workspacesApi.create({ permission: "ask" });
    await qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    await enterWorkspace(ws.id);
  }, [appendReconciliationRequired, enterWorkspace, qc, workspaceSwitchBlocked]);

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
    await removeDeletedChatFromCache(qc, deleting.id);
    await qc.invalidateQueries({ queryKey: queryKeys.chats });
    if (deleting.id === activeChatId) void navigate({ to: "/" });
    setDeleting(null);
  };

  // Warm the transcript before the click lands so opening a chat does not blank
  // the pane on `chat.isLoading`. Cached entries resolve without a second read.
  const prefetchChat = React.useCallback(
    (id: string) => {
      void qc.prefetchQuery({
        queryKey: queryKeys.chat(id),
        queryFn: () => chatsApi.get(id),
      });
    },
    [qc],
  );

  const newAgent = React.useCallback(async () => {
    if (!activeId || appendReconciliationRequired) return;
    try {
      const created = await chatsApi.create({ workspaceId: activeId });
      await qc.invalidateQueries({ queryKey: queryKeys.chats });
      void navigate({ to: "/chat/$chatId", params: { chatId: created.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not create a chat.");
    }
  }, [activeId, appendReconciliationRequired, navigate, qc]);

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
            <UpdateReadyBanner blockedReason={updateRestartBlockedReason} />
            <div className="flex flex-col gap-0.5" title={settingsBlockedReason}>
              <SidebarListItem
                icon={<UserRound />}
                title="Profile"
                selected={pathname === "/profile"}
                disabled={Boolean(settingsBlockedReason)}
                onClick={() => navigate({ to: "/profile" })}
              />
              <div className="flex min-w-0 items-center gap-0.5">
                <SidebarListItem
                  icon={<Settings />}
                  title="Settings"
                  selected={pathname === "/settings"}
                  disabled={Boolean(settingsBlockedReason)}
                  className="min-w-0 flex-1"
                  onClick={() => navigate({ to: "/settings" })}
                />
                <RemoteConnectionPopover
                  settingsBlockedReason={settingsBlockedReason}
                  onManage={openRemoteSettings}
                />
              </div>
            </div>
          </SidebarFooter>
        }
      >
        <div className="flex flex-col gap-0.5 px-2.5 pb-2">
          <SidebarListItem
            icon={<SquarePen />}
            title="New Agent"
            disabled={!activeId || appendReconciliationRequired}
            onClick={() => void newAgent()}
          />
          <SidebarListItem
            icon={<Clock3 />}
            title="Scheduled"
            selected={pathname === "/scheduled"}
            onClick={() => navigate({ to: "/scheduled" })}
          />
        </div>

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
                  sublabel={w.folderPath ? truncatePathMiddle(w.folderPath) : undefined}
                  title={w.folderPath ?? undefined}
                  onCheckedChange={() => switchWorkspace(w.id)}
                >
                  {w.name}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={workspaceSwitchBlocked || appendReconciliationRequired}
                onSelect={openFolderWorkspace}
              >
                Open folder as workspace…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={workspaceSwitchBlocked || appendReconciliationRequired}
                onSelect={newEmptyWorkspace}
              >
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
                  {!active.managedWorktree ? (
                    <DropdownMenuItem
                      disabled={workspaceActionBlocked}
                      icon="trash"
                      color="red"
                      onSelect={() => setRemovingWorkspace(active)}
                    >
                      Remove “{active.name}”
                    </DropdownMenuItem>
                  ) : null}
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
                  const shortcutBinding = shortcutNumber
                    ? commandBinding(`chat.jump.${shortcutNumber}` as CommandId)
                    : null;
                  const working =
                    activeChatIds.has(chat.id) ||
                    (chat.id === activeChatId && environmentPanel.agentBusy);
                  return (
                    <ContextMenu key={chat.id}>
                      <ContextMenuTrigger asChild>
                        <SidebarListItem
                          icon={
                            renamingWithAppleId === chat.id ? (
                              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            ) : undefined
                          }
                          aria-busy={renamingWithAppleId === chat.id || working}
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
                            working || (chatShortcutsVisible && shortcutBinding) ? (
                              <span className="flex items-center gap-1">
                                {chatShortcutsVisible && shortcutBinding ? (
                                  <kbd
                                    aria-hidden="true"
                                    className="inline-flex h-5 min-w-8 items-center justify-center rounded-pill bg-control px-1.5 font-sans text-mini font-medium tabular-nums text-tertiary"
                                  >
                                    {prettyAccelerator(shortcutBinding)}
                                  </kbd>
                                ) : null}
                                {working ? <ChatActivityIndicator /> : null}
                              </span>
                            ) : undefined
                          }
                          aria-keyshortcuts={ariaKeyShortcut(shortcutBinding)}
                          selected={chat.id === activeChatId}
                          onPointerEnter={() => prefetchChat(chat.id)}
                          onFocus={() => prefetchChat(chat.id)}
                          onClick={() => openChat(chat.id)}
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
                        {capabilities.appleFoundationModels && foundationModels.data !== null ? (
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
                              {renamingWithAppleId === chat.id
                                ? "Renaming with Apple…"
                                : "Rename with Apple"}
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
                    </ContextMenu>
                  );
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
              The clean checkout for “{deletingWorktree.name}” will be removed. Its branch is
              deleted only if it has no commits beyond where Aiden created it. Chats stay on disk.
              Dirty worktrees are refused.
              {environmentPanel.editorState.workspaceId === deletingWorktree.id &&
              environmentPanel.editorState.dirty
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
              “{removingWorkspace.name}” will be removed. Its chats stay on disk but won’t be
              listed. The folder itself is not touched.
              {environmentPanel.editorState.workspaceId === removingWorkspace.id &&
              environmentPanel.editorState.dirty
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
