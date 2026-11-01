import {
  createChatDraft,
  discardChatDraft,
  listChatDrafts,
  requestChatDraftComposerFocus,
  subscribeChatDrafts,
} from "../lib/chat-draft";
import { openWorkspaceSettings } from "./workspace-settings-dialog";
import { workspaceHasOwnSettings } from "../lib/workspace-settings-view";
import { useNewChatActions } from "../lib/new-chat-actions";
import { HistoryNavButtons } from "./history-nav";
import { forkedFromLabel } from "../lib/chat-copy-view";
// Unified workspace/chat sidebar with workspace-grouped, recent, and
// Inbox (Beta) views, route-driven selection, and workspace/chat actions.

import * as React from "react";
import { workspaceDisplayName, workspaceSecondaryLabel, type WorkspacePathPreferences } from "../lib/workspace-path-display";
import { WorkspacePathLabel } from "./workspace-path-label";
import { isNoWorkspace, NO_WORKSPACE_GROUP_LABEL, sidebarGroupWorkspaceId } from "../lib/no-workspace";
import { useWorkspacePathPreferences } from "../lib/use-workspace-path-preferences";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
  Dialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { Progress } from "./ui-primitives";
import {
  Folder,
  FolderPlus,
  Loader2,
  MessageCircle,
  Plus,
  Settings,
  SquarePen,
  UserRound,
} from "lucide-react";
import { SidebarPrimaryNav } from "./sidebar-primary-nav";
import { appUpdatesApi, chatsApi, gitApi, peerHostsApi, workspacesApi } from "../lib/ipc";
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
import { useHeldModifierReveal } from "../lib/use-held-modifier-reveal";
import { queryKeys, useAllRegularChats, useFoundationModelsConnection, useSidebarChatPullRequests } from "../lib/queries";
import { MAX_SIDEBAR_PULL_REQUEST_CHATS } from "../shared/chat-pull-requests";
import type { ChatTriageEntry } from "../shared/chat-triage";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useEnvironmentPanel } from "./environment-panel";
import type { ChatMeta, Workspace } from "../lib/types";
import { useCommandHandler, useCommandSystem } from "../lib/command-system";
import type { CommandId } from "../shared/keybindings";
import { ariaKeyShortcut, prettyAccelerator } from "../shared/keybindings";
import { removeDeletedChatFromCache } from "../lib/chat-deletion-cache";
import { useAppUpdateSnapshot } from "../lib/use-app-update-snapshot";
import type { AppUpdateRestartResult, AppUpdateSnapshot } from "../shared/app-update";
import { useChatActivityState, useChatReadMarkers } from "../lib/use-chat-activity";
import { chatRowStateFor } from "../lib/chat-activity";
import { isChatUnread } from "../shared/chat-row-state";
import { CHAT_ROW_INBOX_ACTIONS, ChatRow, type ChatRowInbox, type ChatRowMenu } from "./sidebar/chat-row";
import { InboxView, type InboxRowContext, type InboxViewHandle } from "./sidebar/inbox-view";
import {
  botInboxRows,
  botInboxKey,
  remoteBotInboxRows,
  filterInboxEntries,
  INBOX_SHORTCUT_LIMIT,
  inboxRowAction,
  inboxShortcutTargets,
  resolveInboxEntry,
  localInboxEntries,
  markReadThroughMessageId,
  pendingAttentionRequest,
  remoteInboxEntries,
  type InboxEntry,
} from "../lib/sidebar-inbox-view";
import { RowGroup } from "./sidebar/row-group";
import { SectionHeader } from "./sidebar/section-header";
import { SidebarOverflowMenu } from "./sidebar/sidebar-overflow-menu";
import { remoteChatRowMenu } from "./sidebar/remote-chat-row-menu";
import { inboxTriageMenuItems } from "./sidebar/inbox-triage-menu";
import { useInboxTriage, type InboxTriageRow } from "../lib/use-inbox-triage";
import { inboxTriageOffer } from "../lib/inbox-triage";
import { RemoteHostAdapter, remoteHostCapabilities } from "../lib/hosts/remote-host-adapter";
import { isRevisionConflict, type HostChatCapability } from "../lib/hosts/host-chat-adapter";
import { ChatRowContextGlyphs } from "./chat-row-context";
import { sidebarPullRequestChatIds } from "../lib/chat-row-context";
import { RemoteConnectionPopover } from "./remote-connection-popover";
import { useAppCapabilities } from "../lib/app-capabilities";
import { botChatPath, botListLocation, botRouteBotId, hostBotChatRouteKey, sidebarShowsBotList } from "../lib/bot-routes";
import { useRemoteBots } from "../main/remote-bots";
import { useRovingRows } from "../lib/roving-rows";
import { BotSidebar } from "../main/bots/bot-sidebar";
import { useBotRows } from "../main/bots/bot-sidebar-rows";
import { botSidebarPreferenceActions, useBotSidebarPreferencesWhen } from "../main/bots/use-bot-sidebar-preferences";
import { isBotUnread } from "../lib/bot-sidebar-preferences";
import { AvatarFace } from "./bot-avatar";
import {
  localSidebarChats,
  localSidebarProjects,
  type LocalSidebarChat,
  type LocalSidebarProject,
} from "../lib/sidebar-workspace-groups";
import {
  canMoveProjectKey,
  displayedSidebarChats,
  latestProjectChat,
  LOCAL_SIDEBAR_HOST_ID,
  mergeProjectOrder,
  moveProjectKey,
  moveProjectKeyTo,
  organizeSidebar,
  projectOrderKey,
  visibleProjectChats,
  type SidebarChatSort,
  type SidebarMachineFilter,
  type SidebarProjectGroup,
  type SidebarProjectGrouping,
  type SidebarPreferences,
  type SidebarProjectSort,
} from "../lib/sidebar-organization";
import {
  readSidebarPreferences,
  useSidebarPreferencesFromOtherWindows,
  useSidebarView,
  writeSidebarPreferences,
} from "../lib/use-sidebar-view";
import { SidebarOrganizeMenuItems } from "./sidebar-organize-menu";
import {
  combineSidebarRows,
  effectiveMachineFilter,
  isRemoteSidebarChat,
  isRemoteSidebarProject,
  machineFilterLabel,
  projectEntryMachineLabels,
  remoteChatRowActions,
  remoteSidebarRows,
  type RemoteSidebarChat,
  type RemoteSidebarProject,
  type SidebarProjectEntry,
} from "../lib/sidebar-remote-groups";
import { useLocalRepositoryIdentities, usePeerHostSidebar } from "../lib/hosts/use-peer-host-sidebar";
import {
  MachineBadges,
  MachineFilterChip,
  RemoteHostStatusList,
} from "./sidebar-remote";

const AIDEN_MARK_URL = new URL("../../resources/app-icon.png", import.meta.url).href;
const COLLAPSED_WORKSPACE_CHAT_LIMIT = 4;
const NO_REMOTE_CAPABILITIES: ReadonlySet<HostChatCapability> = new Set();
/** Must match aiden-app-update-banner-out in styles.css. */
const APP_UPDATE_BANNER_EXIT_MS = 120;

interface ChatSidebarProps {
  activeChatId: string | undefined;
  /** The open chat when it lives on a paired host; kept apart from local chat IDs. */
  activeRemoteChat?: { hostId: string; chatId: string } | null;
  titleReveal?: ChatTitleRevealEvent | null;
}

type SidebarEntry = SidebarProjectEntry<LocalSidebarProject>;
type SidebarRow = LocalSidebarChat | RemoteSidebarChat;
type SyncedSidebarField =
  | "chatSort"
  | "projectSort"
  | "projectOrder"
  | "expandedWorkspaceIds"
  | "machineFilter"
  | "projectGrouping";

/**
 * The remote chat a rename dialog is for. It names the chat, not a revision:
 * the host moves the revision on every write (a Working chat moves it often),
 * so the rename reads it from the newest feed row when it is saved.
 */
interface RemoteRenameTarget {
  hostId: string;
  chatId: string;
  hostLabel: string;
}

function workspaceAccessibleName(workspace: Workspace, preferences: WorkspacePathPreferences, workspaces: readonly Workspace[]): string {
  // The Chats group stands for every hidden No workspace folder; its own folder is no name for it.
  if (isNoWorkspace(workspace)) return NO_WORKSPACE_GROUP_LABEL;
  return [workspaceDisplayName(workspace, workspaces), workspaceSecondaryLabel(workspace, preferences)].filter(Boolean).join(", ");
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
  // Quick View and assistant dock presence primitives.
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
        <Progress
          className="mt-2"
          label="Update download progress"
          value={displayedSnapshot.percent}
        />
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

/** A paired host's row for triage, with the entry its summary reports (revision 48). */
function remoteTriageRow(chat: RemoteSidebarChat): InboxTriageRow {
  return { key: chat.key, hostId: chat.hostId, chatId: chat.chatId, reported: chat.triage ?? null };
}

/**
 * On any Bots page the sidebar lists only Bots (spec §9); everywhere else it is
 * the workspace outline. With the Inbox as the view, a Bot opened from the
 * Inbox keeps the Inbox (it owns ⌘1–9 there), and the Bot list shows on the
 * history entries where the person asked for it (the Bots nav entry,
 * `bots.open`, All Bots) until they leave Bots. Only one of the two sidebars
 * mounts, so only one registers the jump shortcuts.
 */
export function ChatSidebar(props: ChatSidebarProps) {
  const capabilities = useAppCapabilities();
  const { view } = useSidebarView();
  const inboxView = view === "inbox";
  const showsBotList = useRouterState({ select: (state) => sidebarShowsBotList(state.location, inboxView) });
  return capabilities.bots && showsBotList
    ? <BotSidebar />
    : <WorkspaceChatSidebar {...props} />;
}

function WorkspaceChatSidebar({ activeChatId, activeRemoteChat = null, titleReveal }: ChatSidebarProps) {
  const pathPreferences = useWorkspacePathPreferences();
  const navigate = useNavigate();
  const capabilities = useAppCapabilities();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  const { workspaces, activeId, select, isReady: workspaceRegistryReady } = useActiveWorkspace();
  const environmentPanel = useEnvironmentPanel();
  const chatActivity = useChatActivityState();
  const readMarkers = useChatReadMarkers();
  const appendReconciliationRequired = useAppendReconciliationRequired();
  const chats = useAllRegularChats(workspaces.length > 0);
  const newChat = useNewChatActions();
  // The open, unsent draft shows as an italic "New chat" row under its
  // workspace, and follows the draft if its workspace changes.
  const chatDrafts = React.useSyncExternalStore(subscribeChatDrafts, listChatDrafts);
  const openDraft = chatDrafts.find((draft) => draft.chat.id === activeChatId);
  const draftWorkspaceId = openDraft?.chat.workspaceId;
  const chatTitlesById = React.useMemo(
    () => new Map((chats.data ?? []).map((chat) => [chat.id, chat.title])),
    [chats.data],
  );
  const workspacesById = React.useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );
  const foundationModels = useFoundationModelsConnection(capabilities.appleFoundationModels);
  const [search, setSearch] = React.useState("");
  const initialPreferences = React.useMemo(readSidebarPreferences, []);
  const { view, setView } = useSidebarView();
  const [chatSort, setChatSort] = React.useState<SidebarChatSort>(initialPreferences.chatSort);
  const [projectSort, setProjectSort] = React.useState<SidebarProjectSort>(
    initialPreferences.projectSort,
  );
  const [projectOrder, setProjectOrder] = React.useState<string[]>(
    initialPreferences.projectOrder,
  );
  const [draggedProjectKey, setDraggedProjectKey] = React.useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = React.useState<{
    key: string;
    placement: "before" | "after";
  } | null>(null);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = React.useState(
    () => new Set(initialPreferences.expandedWorkspaceIds),
  );
  const sidebarChatIds = React.useMemo(
    () => sidebarPullRequestChatIds(chats.data ?? [], expandedWorkspaceIds, MAX_SIDEBAR_PULL_REQUEST_CHATS),
    [chats.data, expandedWorkspaceIds],
  );
  const sidebarPullRequestsQuery = useSidebarChatPullRequests(sidebarChatIds);
  const sidebarPullRequests = sidebarPullRequestsQuery.data?.rows ?? {};
  // Only chats the bulk read actually asked about have known dismissals; a
  // missing entry for any other chat is not proof that nothing was unlinked.
  const sidebarPullRequestsKnown = React.useMemo(
    () => new Set(sidebarPullRequestsQuery.data?.chatIds ?? []),
    [sidebarPullRequestsQuery.data?.chatIds],
  );
  const [fullyRevealedWorkspaceIds, setFullyRevealedWorkspaceIds] = React.useState(
    () => new Set<string>(),
  );
  // Paired-host groups are keyed by their host-qualified project key and stay in memory.
  const [expandedRemoteKeys, setExpandedRemoteKeys] = React.useState(() => new Set<string>());
  const [revealedRemoteKeys, setRevealedRemoteKeys] = React.useState(() => new Set<string>());
  const [machineFilter, setMachineFilter] = React.useState<SidebarMachineFilter>(
    initialPreferences.machineFilter,
  );
  const [projectGrouping, setProjectGrouping] = React.useState<SidebarProjectGrouping>(
    initialPreferences.projectGrouping,
  );
  const peerHosts = usePeerHostSidebar();
  const hasHosts = peerHosts.hosts.length > 0;
  const remoteCapabilities = React.useMemo(
    () =>
      new Map(
        [...peerHosts.views].map(([hostId, view]) => [hostId, remoteHostCapabilities(view)] as const),
      ),
    [peerHosts.views],
  );
  const shownMachines = effectiveMachineFilter(machineFilter, peerHosts.hosts);
  const initializedExpansionRef = React.useRef(false);
  const [renaming, setRenaming] = React.useState<ChatMeta | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renamingWithAppleId, setRenamingWithAppleId] = React.useState<string | null>(null);
  const [remoteRenaming, setRemoteRenaming] = React.useState<RemoteRenameTarget | null>(null);
  const [remoteRenameBusy, setRemoteRenameBusy] = React.useState(false);
  const [deleting, setDeleting] = React.useState<ChatMeta | null>(null);
  const [removingWorkspace, setRemovingWorkspace] = React.useState<Workspace | null>(null);
  const [removingWorkspaceBusy, setRemovingWorkspaceBusy] = React.useState(false);
  const [deletingWorktree, setDeletingWorktree] = React.useState<Workspace | null>(null);
  const [deletingWorktreeBusy, setDeletingWorktreeBusy] = React.useState(false);

  const searching = Boolean(search.trim());
  const sidebarProjects = React.useMemo(() => localSidebarProjects(workspaces), [workspaces]);
  const sidebarChats = React.useMemo(
    () => localSidebarChats(workspaces, chats.data ?? []),
    [chats.data, workspaces],
  );
  const workspaceIds = React.useMemo(() => workspaces.map((workspace) => workspace.id), [workspaces]);
  const localRepositories = useLocalRepositoryIdentities(
    workspaceIds,
    hasHosts && projectGrouping !== "separate",
  );
  const remoteRows = React.useMemo(
    () =>
      peerHosts.hosts.map((host) =>
        remoteSidebarRows(
          host,
          peerHosts.feeds.get(host.id),
          (hostId, chatId) =>
            activeRemoteChat?.hostId === hostId && activeRemoteChat.chatId === chatId,
        ),
      ),
    [activeRemoteChat, peerHosts.feeds, peerHosts.hosts],
  );
  // Each paired host's reported triage, so this device's optimistic writes give
  // way once the host's summaries catch up.
  const remoteTriageReported = React.useMemo(() => {
    const reported = new Map<string, ChatTriageEntry>();
    for (const rows of remoteRows) {
      for (const chat of rows.chats) if (chat.triage) reported.set(chat.key, chat.triage);
    }
    return reported;
  }, [remoteRows]);
  const inboxViewRef = React.useRef<InboxViewHandle>(null);
  const restoreInboxRows = React.useCallback((keys: readonly string[]) => inboxViewRef.current?.touch(keys), []);
  const triage = useInboxTriage({ views: peerHosts.views, reported: remoteTriageReported, onRestore: restoreInboxRows });
  // Read by an in-flight remote rename, which outlives the render that started it.
  const remoteRowsRef = React.useRef(remoteRows);
  remoteRowsRef.current = remoteRows;
  const combined = React.useMemo(
    () =>
      combineSidebarRows({
        local: { projects: sidebarProjects, chats: sidebarChats },
        remote: remoteRows,
        hosts: peerHosts.hosts,
        filter: shownMachines,
        grouping: projectGrouping,
        localRepository: (project) => localRepositories.get(project.workspace.id) ?? null,
      }),
    [
      localRepositories,
      peerHosts.hosts,
      projectGrouping,
      remoteRows,
      shownMachines,
      sidebarChats,
      sidebarProjects,
    ],
  );
  const organized = React.useMemo(
    () =>
      organizeSidebar<SidebarEntry, SidebarRow>({
        projects: combined.projects,
        chats: combined.chats,
        search,
        view,
        chatSort,
        projectSort,
        projectOrder,
        now: Date.now(),
      }),
    [chatSort, combined, projectOrder, projectSort, search, view],
  );
  const chatViewTitle = view === "inbox" ? "Inbox" : "Recents";
  const inboxActive = view === "inbox";
  // Local waits, prompt times and request text. Change events (activity, and
  // anything that invalidates the chat list) refetch it; nothing polls.
  // The request names its ids by count and hash, and the query function sends
  // exactly those ids, so a response always answers the key it is cached under.
  const pendingAttentionReq = React.useMemo(
    () => pendingAttentionRequest(
      chats.data ?? [],
      [chatActivity.approvalChatIds, chatActivity.inputChatIds, chatActivity.activeChatIds],
    ),
    [chats.data, chatActivity.activeChatIds, chatActivity.approvalChatIds, chatActivity.inputChatIds],
  );
  const pendingAttention = useQuery({
    queryKey: [...queryKeys.pendingAttention, chatActivity.revision, chats.dataUpdatedAt, pendingAttentionReq.key],
    queryFn: () => chatsApi.pendingAttention([...pendingAttentionReq.ids]),
    enabled: inboxActive && pendingAttentionReq.ids.length > 0,
    placeholderData: keepPreviousData,
  });
  // This Mac's Bots join the Inbox when they need the person or have an unread
  // reply. Their unread comes from the Bots sidebar's own record, not chat read markers.
  const inboxBotsShown = inboxActive && capabilities.bots;
  // Both read nothing, and the preferences re-render nothing, until then.
  const botRows = useBotRows({ enabled: inboxBotsShown });
  const botPreferences = useBotSidebarPreferencesWhen(inboxBotsShown);
  const openBotId = capabilities.bots ? botRouteBotId(pathname) : null;
  // Every Bot, listed or not: a Bot that stops qualifying while the list holds
  // it (a freeze, the Needs you linger) still exists and shows its live state.
  const botInbox = React.useMemo(
    () =>
      inboxBotsShown && botPreferences
        ? botInboxRows({
            bots: botRows.rows,
            openBotId,
            unread: (botId, lastReplyAt) => isBotUnread(botPreferences, botId, lastReplyAt),
          })
        : { listed: [], unlisted: [] },
    [botPreferences, botRows.rows, inboxBotsShown, openBotId],
  );
  // Paired hosts' Bots join while their host says they need the person or failed (revision 48).
  const openRemoteBotKey = hostBotChatRouteKey(pathname);
  const { open: openHostBot, opening: openingHostBot } = useRemoteBots();
  const remoteBotInbox = React.useMemo(
    () =>
      inboxActive
        ? remoteBotInboxRows({ hosts: peerHosts.hosts, feeds: peerHosts.feeds, openKey: openRemoteBotKey })
        : { listed: [], unlisted: [] },
    [inboxActive, openRemoteBotKey, peerHosts.feeds, peerHosts.hosts],
  );
  const allInboxEntries = React.useMemo(() => {
    if (!inboxActive) return [];
    const pending = new Map((pendingAttention.data ?? []).map((item) => [item.chatId, item] as const));
    return [
      ...localInboxEntries({
        chats: chats.data ?? [],
        workspaces,
        activeChatId,
        rowState: (chatId) =>
          chatRowStateFor(chatActivity, chatId, chatId === activeChatId && environmentPanel.agentBusy),
        unread: (chat) =>
          chat.id !== activeChatId &&
          isChatUnread(chat.lastAssistantAt, readMarkers, chat.id, chat.lastAssistantSequence),
        pending,
        triage: (chatId) =>
          triage.entryFor({ key: projectOrderKey(LOCAL_SIDEBAR_HOST_ID, chatId), hostId: LOCAL_SIDEBAR_HOST_ID, chatId }),
      }),
      ...remoteInboxEntries(
        remoteRows,
        peerHosts.hosts,
        (hostId, chatId) => activeRemoteChat?.hostId === hostId && activeRemoteChat.chatId === chatId,
        (chat) => triage.entryFor(remoteTriageRow(chat)),
      ),
      ...botInbox.listed,
      ...remoteBotInbox.listed,
    ];
  }, [
    activeChatId,
    activeRemoteChat,
    botInbox.listed,
    remoteBotInbox.listed,
    chatActivity,
    chats.data,
    environmentPanel.agentBusy,
    inboxActive,
    peerHosts.hosts,
    pendingAttention.data,
    readMarkers,
    remoteRows,
    triage,
    workspaces,
  ]);
  const inboxEntries = React.useMemo(
    () => filterInboxEntries(allInboxEntries, { search, machineFilter: shownMachines }),
    [allInboxEntries, search, shownMachines],
  );
  const inboxPresent = React.useMemo(
    () => new Set([...allInboxEntries, ...botInbox.unlisted, ...remoteBotInbox.unlisted].map((entry) => entry.key)),
    [allInboxEntries, botInbox.unlisted, remoteBotInbox.unlisted],
  );
  const inboxUnlisted = React.useMemo(
    () => new Map([...botInbox.unlisted, ...remoteBotInbox.unlisted].map((entry) => [entry.key, entry] as const)),
    [botInbox.unlisted, remoteBotInbox.unlisted],
  );
  const inboxEntriesByKey = React.useMemo(
    () => new Map(inboxEntries.map((entry) => [entry.key, entry] as const)),
    [inboxEntries],
  );
  const openRemoteBot = openRemoteBotKey ? remoteBotInbox.listed.find((entry) => entry.signals.isOpen) : undefined;
  const activeInboxKey = openBotId
    ? botInboxKey(openBotId)
    : openRemoteBot
    ? openRemoteBot.key
    : activeRemoteChat
    ? projectOrderKey(activeRemoteChat.hostId, activeRemoteChat.chatId)
    : activeChatId
      ? projectOrderKey(LOCAL_SIDEBAR_HOST_ID, activeChatId)
      : null;
  // The Inbox reports its visible rows in on-screen (frozen) order.
  const [inboxShortcutKeys, setInboxShortcutKeys] = React.useState<readonly string[]>([]);
  // Keep the same array when the order didn't change, so the sidebar doesn't re-render for nothing.
  const updateInboxShortcutKeys = React.useCallback((keys: readonly string[]) => {
    setInboxShortcutKeys((current) =>
      current.length === keys.length && current.every((key, index) => key === keys[index]) ? current : keys);
  }, []);
  const inboxShortcutNumbers = React.useMemo(
    () => new Map(inboxShortcutKeys.slice(0, INBOX_SHORTCUT_LIMIT).map((key, index) => [key, index + 1] as const)),
    [inboxShortcutKeys],
  );
  const manualReorderEnabled = view === "projects" && projectSort === "manual" && !searching;
  const displayOptions = React.useMemo(
    () => ({
      search,
      isExpanded: ({ key, primary }: SidebarEntry) =>
        isRemoteSidebarProject(primary)
          ? expandedRemoteKeys.has(key)
          : expandedWorkspaceIds.has(primary.workspace.id),
      isFullyRevealed: ({ key, primary }: SidebarEntry) =>
        isRemoteSidebarProject(primary)
          ? revealedRemoteKeys.has(key)
          : fullyRevealedWorkspaceIds.has(primary.workspace.id),
      collapsedChatLimit: COLLAPSED_WORKSPACE_CHAT_LIMIT,
    }),
    [expandedRemoteKeys, expandedWorkspaceIds, fullyRevealedWorkspaceIds, revealedRemoteKeys, search],
  );
  // The chat list takes one Tab stop; arrow keys move between its rows. The
  // region spans the Inbox's Working shelf, which sits below the scrolling list.
  const rovingRef = React.useRef<HTMLDivElement>(null);
  useRovingRows(rovingRef);
  const [inboxShelfHost, setInboxShelfHost] = React.useState<HTMLDivElement | null>(null);
  // Jump shortcuts and previous/next cover this Mac's chats only.
  const shortcutGroups = React.useMemo(
    () =>
      displayedSidebarChats(organized, view, displayOptions).map((section) => ({
        chats: section.chats.flatMap((summary) => (isRemoteSidebarChat(summary) ? [] : [summary.chat])),
      })),
    [displayOptions, organized, view],
  );
  const shortcutAssignments = React.useMemo(
    () => createSidebarChatShortcutAssignments(shortcutGroups),
    [shortcutGroups],
  );
  const orderedChats = React.useMemo(
    () => shortcutGroups.flatMap((group) => group.chats),
    [shortcutGroups],
  );
  const chatNavigationTargets = React.useMemo(
    () => sidebarChatNavigationTargets(orderedChats, activeChatId),
    [activeChatId, orderedChats],
  );
  const {
    binding: commandBinding,
    execute,
    register: registerCommand,
  } = useCommandSystem();
  const chatJumpBindings = Array.from({ length: 9 }, (_, index) =>
    commandBinding(`chat.jump.${index + 1}` as CommandId),
  );
  const revealModifierSets = chatShortcutRevealModifierSets(chatJumpBindings);
  const chatShortcutsVisible = useHeldModifierReveal(
    revealModifierSets,
    COMMAND_CHAT_SHORTCUT_REVEAL_MS,
  );
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
    async (chat: ChatMeta | null | undefined) => {
      if (!chat) return;
      if (settingsBlockedReason) {
        toast.info(settingsBlockedReason);
        return;
      }
      const targetWorkspaceId = chat.workspaceId;
      const previousWorkspaceId = activeId;
      // The Assistant and Scheduled chats have no workspace in the registry.
      if (targetWorkspaceId && targetWorkspaceId !== activeId && workspacesById.has(targetWorkspaceId)) {
        if (environmentPanel.agentBusy) environmentPanel.cancelAgent?.();
        select(targetWorkspaceId);
      }
      try {
        await navigate({ to: "/chat/$chatId", params: { chatId: chat.id } });
      } catch (error) {
        if (previousWorkspaceId && targetWorkspaceId !== previousWorkspaceId) {
          select(previousWorkspaceId);
        }
        toast.error(error instanceof Error ? error.message : "Aiden could not open that chat.");
      }
    },
    [
      activeId,
      environmentPanel.agentBusy,
      environmentPanel.cancelAgent,
      navigate,
      select,
      settingsBlockedReason,
      workspacesById,
    ],
  );
  const openRemoteSettings = React.useCallback(() => {
    if (settingsBlockedReason) {
      toast.info(settingsBlockedReason);
      return;
    }
    void navigate({ to: "/settings", search: { section: "remoteAccess" } });
  }, [navigate, settingsBlockedReason]);
  const openRemoteChat = React.useCallback(
    async (chat: RemoteSidebarChat) => {
      if (settingsBlockedReason) {
        toast.info(settingsBlockedReason);
        return;
      }
      try {
        await navigate({
          to: "/host/$hostId/chat/$chatId",
          params: { hostId: chat.hostId, chatId: chat.chatId },
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Aiden could not open that chat.");
      }
    },
    [navigate, settingsBlockedReason],
  );
  const openSidebarChat = React.useCallback(
    (summary: SidebarRow | undefined) => {
      if (!summary) return;
      if (isRemoteSidebarChat(summary)) void openRemoteChat(summary);
      else void openChat(summary.chat);
    },
    [openChat, openRemoteChat],
  );
  const markRemoteChatRead = React.useCallback(
    async (chat: RemoteSidebarChat) => {
      const view = peerHosts.views.get(chat.hostId);
      if (!view) return;
      const adapter = new RemoteHostAdapter(view);
      try {
        await adapter.ready();
        // Summaries name no message, so the host marks through its newest output.
        const result = await adapter.markRead(chat.chatId);
        if (!result.ok) toast.error(result.error.message || "Aiden could not mark that chat read.");
      } finally {
        adapter.dispose();
      }
    },
    [peerHosts.views],
  );
  const commitRemoteRename = React.useCallback(async () => {
    const target = remoteRenaming;
    const title = renameValue.trim();
    if (!target || !title) return;
    const view = peerHosts.views.get(target.hostId);
    if (!view) {
      setRemoteRenaming(null);
      toast.error(`${target.hostLabel} is no longer paired with this Mac.`);
      return;
    }
    const currentRevision = () =>
      remoteRowsRef.current
        .flatMap((rows) => rows.chats)
        .find((chat) => chat.hostId === target.hostId && chat.chatId === target.chatId)?.revision;
    const revision = currentRevision();
    if (!revision) {
      setRemoteRenaming(null);
      toast.error(`That chat is no longer on ${target.hostLabel}.`);
      return;
    }
    setRemoteRenameBusy(true);
    const adapter = new RemoteHostAdapter(view);
    try {
      await adapter.ready();
      try {
        // The host's feed broadcasts the new title; the row updates from it.
        await adapter.rename(target.chatId, { title, revision });
      } catch (error) {
        // The chat moved on the host since the row was read; one retry against its newer row.
        const newer = isRevisionConflict(error) ? currentRevision() : undefined;
        if (!newer || newer === revision) throw error;
        await adapter.rename(target.chatId, { title, revision: newer });
      }
      setRemoteRenaming(null);
    } catch (error) {
      toast.error(
        isRevisionConflict(error)
          ? `This chat changed on ${target.hostLabel}. Try again.`
          : error instanceof Error
            ? error.message
            : "Aiden could not rename that chat.",
      );
    } finally {
      adapter.dispose();
      setRemoteRenameBusy(false);
    }
  }, [peerHosts.views, remoteRenaming, renameValue]);
  const reconnectHost = React.useCallback(async (hostId: string) => {
    try {
      await peerHostsApi.reconnect(hostId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not reconnect to that Mac.");
    }
  }, []);

  // A draft opened from anywhere (⌘N, the palette) shows its row expanded.
  React.useEffect(() => {
    if (!draftWorkspaceId) return;
    setExpandedWorkspaceIds((current) =>
      current.has(draftWorkspaceId) ? current : new Set(current).add(draftWorkspaceId),
    );
  }, [draftWorkspaceId]);

  React.useEffect(() => {
    if (!activeId || initializedExpansionRef.current) return;
    initializedExpansionRef.current = true;
    setExpandedWorkspaceIds((current) => new Set(current).add(activeId));
  }, [activeId]);

  React.useEffect(() => {
    if (!workspaceRegistryReady) return;
    const valid = new Set(workspaces.map((workspace) => workspace.id));
    setExpandedWorkspaceIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
    setFullyRevealedWorkspaceIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [workspaceRegistryReady, workspaces]);

  // Writes only the fields this window changed, so another window's change to a
  // different field survives. The view writes itself through `useSidebarView`.
  const writtenPreferences = React.useRef<Partial<SidebarPreferences>>(initialPreferences);
  // Another window's write replaces this window's copies of the fields it
  // changed, so a later local change (a drag, a collapse) merges into it rather
  // than restoring old values. Fields it left alone keep any local edit still
  // waiting to render.
  useSidebarPreferencesFromOtherWindows((stored) => {
    const written = writtenPreferences.current;
    const changed = (field: SyncedSidebarField) =>
      JSON.stringify(stored[field]) !== JSON.stringify(written[field]);
    const adopted: Partial<SidebarPreferences> = {};
    if (changed("chatSort")) {
      adopted.chatSort = stored.chatSort;
      setChatSort(stored.chatSort);
    }
    if (changed("projectSort")) {
      adopted.projectSort = stored.projectSort;
      setProjectSort(stored.projectSort);
    }
    if (changed("projectOrder")) {
      adopted.projectOrder = stored.projectOrder;
      setProjectOrder(stored.projectOrder);
    }
    if (changed("expandedWorkspaceIds")) {
      adopted.expandedWorkspaceIds = stored.expandedWorkspaceIds;
      setExpandedWorkspaceIds(new Set(stored.expandedWorkspaceIds));
    }
    if (changed("machineFilter")) {
      adopted.machineFilter = stored.machineFilter;
      setMachineFilter(stored.machineFilter);
    }
    if (changed("projectGrouping")) {
      adopted.projectGrouping = stored.projectGrouping;
      setProjectGrouping(stored.projectGrouping);
    }
    writtenPreferences.current = { ...written, ...adopted };
  });
  // Pruning runs only when this window's workspace list changes, so adopting
  // another window's ids never prunes one this window hasn't loaded yet.
  const prunedWorkspaces = React.useRef<typeof workspaces | null>(null);
  React.useEffect(() => {
    if (!workspaceRegistryReady) return;
    const own: Partial<SidebarPreferences> = {
      chatSort,
      projectSort,
      projectOrder,
      expandedWorkspaceIds: [...expandedWorkspaceIds],
      machineFilter,
      projectGrouping,
    };
    const written = writtenPreferences.current;
    const patch = Object.fromEntries(
      Object.entries(own).filter(
        ([field, value]) =>
          JSON.stringify(value) !== JSON.stringify(written[field as keyof SidebarPreferences]),
      ),
    ) as Partial<SidebarPreferences>;
    writtenPreferences.current = own;
    if (Object.keys(patch).length === 0 && prunedWorkspaces.current === workspaces) return;
    prunedWorkspaces.current = workspaces;
    writeSidebarPreferences(patch, workspaces.map((workspace) => workspace.id));
  }, [
    chatSort,
    expandedWorkspaceIds,
    machineFilter,
    projectGrouping,
    projectOrder,
    projectSort,
    workspaceRegistryReady,
    workspaces,
  ]);

  const openInboxEntry = React.useCallback(
    (entry: InboxEntry | undefined) => {
      if (!entry) return;
      if (entry.source.kind === "remote") void openRemoteChat(entry.source.chat);
      else if (entry.source.kind === "bot") void navigate(botChatPath(entry.source.bot.id));
      else if (entry.source.kind === "remoteBot") openHostBot(entry.hostId, entry.source.botId);
      else void openChat(entry.source.chat);
    },
    [navigate, openChat, openRemoteChat, openHostBot],
  );

  // In the Inbox, ⌘1–9 and previous/next follow its visible rows, remote ones
  // and held Bots included, in the order that numbers their hints.
  // The last order that listed the open chat: previous/next step from its old
  // place after Mark done or Snooze takes it out of the list.
  const activeInboxOrderRef = React.useRef<{ key: string; keys: readonly string[] } | null>(null);
  React.useEffect(() => {
    if (!inboxActive) return;
    if (activeInboxKey && inboxShortcutKeys.includes(activeInboxKey)) {
      activeInboxOrderRef.current = { key: activeInboxKey, keys: inboxShortcutKeys };
    }
    const remembered = activeInboxOrderRef.current;
    const lastOrder = remembered && remembered.key === activeInboxKey ? remembered.keys : undefined;
    const resolve = resolveInboxEntry(inboxEntriesByKey, inboxUnlisted);
    const { jump, previous, next } = inboxShortcutTargets(inboxShortcutKeys, resolve, activeInboxKey, lastOrder);
    const unregister = jump.flatMap((entry, index) =>
      entry ? [registerCommand(`chat.jump.${index + 1}` as CommandId, () => openInboxEntry(entry))] : [],
    );
    if (previous) unregister.push(registerCommand("chat.previous", () => openInboxEntry(previous)));
    if (next) unregister.push(registerCommand("chat.next", () => openInboxEntry(next)));
    return () => unregister.forEach((dispose) => dispose());
  }, [activeInboxKey, inboxActive, inboxEntriesByKey, inboxShortcutKeys, inboxUnlisted, openInboxEntry, registerCommand]);

  React.useEffect(() => {
    if (inboxActive) return;
    const unregister = shortcutAssignments.map(({ chat, number }) =>
      registerCommand(`chat.jump.${number}` as CommandId, () => {
        void openChat(chat);
      }),
    );
    if (chatNavigationTargets.previous) {
      unregister.push(
        registerCommand("chat.previous", () => {
          void openChat(chatNavigationTargets.previous);
        }),
      );
    }
    if (chatNavigationTargets.next) {
      unregister.push(
        registerCommand("chat.next", () => {
          void openChat(chatNavigationTargets.next);
        }),
      );
    }
    return () => unregister.forEach((dispose) => dispose());
  }, [chatNavigationTargets, inboxActive, openChat, registerCommand, shortcutAssignments]);

  // Move to a workspace and open its latest chat, or an unsaved draft if empty.
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
      const target = list[0] ?? createChatDraft(id).chat;
      const previousWorkspaceId = activeId;
      select(id);
      try {
        await navigate({ to: "/chat/$chatId", params: { chatId: target.id } });
      } catch (error) {
        if (!list.length) discardChatDraft(target.id);
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
      if (removingWorkspace.id === activeId) {
        const switched = await enterWorkspace(remaining[0].id, true);
        if (!switched) return;
      }
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
    const remaining = workspaces.filter((workspace) => workspace.id !== target.id);
    if (!remaining[0]) return;
    setDeletingWorktreeBusy(true);
    let gitBusy = false;
    try {
      if (target.id === activeId) {
        if (environmentPanel.agentBusy) environmentPanel.cancelAgent?.();
        const switched = await enterWorkspace(remaining[0].id, true);
        if (!switched) return;
      }
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
      await qc.invalidateQueries({
        queryKey: queryKeys.foundationModelsConnection,
      });
    } finally {
      setRenamingWithAppleId(null);
    }
  };

  // ⌘K → Delete chat… asks about the open chat, through the same confirmation.
  const activeListedChat = (chats.data ?? []).find((chat) => chat.id === activeChatId);
  useCommandHandler(
    "chat.delete",
    () => {
      if (activeListedChat) setDeleting(activeListedChat);
    },
    activeListedChat !== undefined && renamingWithAppleId !== activeListedChat.id,
  );

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

  const newAgentInWorkspace = React.useCallback(
    async (workspaceId: string) => {
      if (appendReconciliationRequired || settingsBlockedReason) {
        if (settingsBlockedReason) toast.info(settingsBlockedReason);
        return;
      }
      setExpandedWorkspaceIds((current) => new Set(current).add(workspaceId));
      try {
        await newChat.openNewChatIn(workspaceId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Aiden could not create a chat.");
      }
    },
    [appendReconciliationRequired, newChat, settingsBlockedReason],
  );

  const newAgent = React.useCallback(async () => {
    if (!activeId) return;
    await newAgentInWorkspace(activeId);
  }, [activeId, newAgentInWorkspace]);

  const toggleWorkspace = React.useCallback((workspaceId: string) => {
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }, []);

  const toggleRemoteProject = React.useCallback((key: string) => {
    setExpandedRemoteKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const changeProjectSort = React.useCallback(
    (sort: SidebarProjectSort) => {
      if (sort === "manual" && projectSort !== "manual") {
        // Start manual order from the list on screen so choosing Manual never reshuffles it.
        const displayed = organized.projectOrder;
        setProjectOrder((stored) => mergeProjectOrder(displayed, stored));
      }
      setProjectSort(sort);
    },
    [organized.projectOrder, projectSort],
  );

  const commitProjectOrder = React.useCallback((arranged: string[]) => {
    setProjectOrder((stored) => mergeProjectOrder(arranged, stored));
  }, []);

  const endProjectDrag = React.useCallback(() => {
    setDraggedProjectKey(null);
    setProjectDropTarget(null);
  }, []);

  const revealWorkspace = React.useCallback(async (workspace: Workspace) => {
    try {
      await workspacesApi.openFolder(workspace.id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Aiden could not reveal “${workspace.name}”.`,
      );
    }
  }, []);

  // The open draft and any unsent draft with text, newest first, under their
  // workspaces. Hidden while searching, and once the first send lists the chat.
  const draftsByWorkspace = React.useMemo(() => {
    const grouped = new Map<string, ChatMeta[]>();
    if (searching) return grouped;
    const listed = new Set((chats.data ?? []).map((chat) => chat.id));
    for (const { chat } of [...chatDrafts].reverse()) {
      if (!chat.workspaceId || listed.has(chat.id)) continue;
      // Drafts in any hidden No workspace folder show under the one Chats group.
      const groupId = sidebarGroupWorkspaceId(chat.workspaceId, workspaces);
      grouped.set(groupId, [...(grouped.get(groupId) ?? []), chat]);
    }
    return grouped;
  }, [chatDrafts, chats.data, searching, workspaces]);
  const renderDraftRow = (draft: ChatMeta) => (
    <SidebarListItem
      key={`draft:${draft.id}`}
      data-roving-item
      className="pl-8"
      data-draft-chat={draft.id}
      aria-description="Unsent draft"
      title={<span className="italic">New chat</span>}
      selected={draft.id === activeChatId}
      onClick={() => {
        if (draft.id === activeChatId) requestChatDraftComposerFocus(draft.id);
        else void openChat(draft).then(() => requestChatDraftComposerFocus(draft.id));
      }}
    />
  );

  // Local Mark read covers only the output the row rendered, so a reply that
  // lands mid-click stays unread.
  const markLocalChatRead = async (chat: ChatMeta) => {
    try {
      // Always read the chat afresh: a cached copy can predate the reply the row shows.
      const session = await qc.fetchQuery({
        queryKey: queryKeys.chat(chat.id),
        queryFn: () => chatsApi.get(chat.id),
        staleTime: 0,
      });
      const through = session ? markReadThroughMessageId(session.messages, chat.lastAssistantAt) : null;
      if (!through) return;
      await chatsApi.markRead(chat.id, through);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not mark that chat read.");
    }
  };

  const inboxRowParts = (
    entry: InboxEntry,
    context: InboxRowContext,
    markRead: () => void,
  ): ChatRowInbox => {
    const remoteCanMarkRead =
      entry.source.kind === "remote" && (remoteCapabilities.get(entry.hostId)?.has("markRead") ?? false);
    // A dimmed row (held after it left, or its host offline) offers no action.
    const action = context.dimmed
      ? null
      : inboxRowAction(entry, context.section, context.status, remoteCanMarkRead);
    return {
      meta: hasHosts ? `${entry.project} · ${entry.hostLabel}` : entry.project,
      status: context.status,
      ...(context.description ? { description: context.description } : {}),
      unread: entry.signals.unread && !entry.signals.isOpen,
      dimmed: context.dimmed,
      ...(action
        ? {
            action: {
              kind: action,
              onSelect: () => {
                context.touch();
                markRead();
              },
            },
          }
        : {}),
    };
  };

  // Pin, Mark done and Snooze: in an Inbox row's ••• and context menus only.
  // On unseen failed output, Mark done and Snooze also mark the chat read, or
  // the row would stay in Needs you.
  const inboxTriageItems = (
    parts: Parameters<ChatRowMenu>,
    entry: InboxEntry,
    context: InboxRowContext,
    row: InboxTriageRow,
    disabled: boolean,
    markRead: (() => void) | null,
  ) => {
    const offer = inboxTriageOffer(entry.signals, Date.now());
    return inboxTriageMenuItems(parts, {
      pinned: entry.signals.pinnedAt !== undefined,
      offer,
      disabled,
      onAct: (kind, until) => {
        context.touch();
        if (offer.alsoMarkRead && markRead && (kind === "done" || kind === "snooze")) markRead();
        void triage.act(kind, [row], until);
      },
    });
  };

  const renderChatRow = (
    chat: ChatMeta,
    indented = false,
    liveContext = false,
    inbox?: { entry: InboxEntry; context: InboxRowContext },
  ) => {
    const shortcutNumber = inbox
      ? inboxShortcutNumbers.get(inbox.entry.key)
      : shortcutNumberByChatId.get(chat.id);
    const shortcutBinding = shortcutNumber
      ? commandBinding(`chat.jump.${shortcutNumber}` as CommandId)
      : null;
    const rowState = chatRowStateFor(
      chatActivity,
      chat.id,
      chat.id === activeChatId && environmentPanel.agentBusy,
    );
    // The open chat is being viewed, so its own output never reads as unread.
    const unread = chat.id !== activeChatId && isChatUnread(chat.lastAssistantAt, readMarkers, chat.id, chat.lastAssistantSequence);
    const forkedFrom = chat.forkedFrom
      ? forkedFromLabel(chatTitlesById.get(chat.forkedFrom.chatId))
      : undefined;
    const titleContent =
      titleReveal?.chatId === chat.id ? (
        <GeneratedTitleReveal
          key={`${chat.id}-${titleReveal.version}`}
          previousTitle={titleReveal.previousTitle}
          title={chat.title}
        />
      ) : (
        chat.title
      );
    const inboxParts = inbox
      ? inboxRowParts(inbox.entry, inbox.context, () => void markLocalChatRead(chat))
      : undefined;
    const inboxAction = inboxParts?.action;
    const menuItems: ChatRowMenu = (Item, Separator, SubMenu) => (
      <>
      {inboxAction ? (
        <>
          <Item icon={CHAT_ROW_INBOX_ACTIONS[inboxAction.kind].menuIcon} onSelect={inboxAction.onSelect}>
            {CHAT_ROW_INBOX_ACTIONS[inboxAction.kind].label}
          </Item>
          {inbox ? null : <Separator />}
        </>
      ) : null}
      {inbox ? (
        <>
          {inboxTriageItems(
            [Item, Separator, SubMenu],
            inbox.entry,
            inbox.context,
            { key: inbox.entry.key, hostId: LOCAL_SIDEBAR_HOST_ID, chatId: chat.id },
            inbox.context.dimmed,
            () => void markLocalChatRead(chat),
          )}
          <Separator />
        </>
      ) : null}
      <Item
        icon="pencil"
        disabled={renamingWithAppleId === chat.id}
        onSelect={() => {
          setRenameValue(chat.title);
          setRenaming(chat);
        }}
      >
        Rename
      </Item>
      {capabilities.appleFoundationModels && foundationModels.data !== null ? (
        <Item
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
        </Item>
      ) : null}
      <Separator />
      <Item
        icon="trash"
        color="red"
        disabled={renamingWithAppleId === chat.id}
        onSelect={() => setDeleting(chat)}
      >
        Delete
      </Item>
      </>
    );
    return (
      <ChatRow
        key={chat.id}
        title={chat.title}
        titleContent={titleContent}
        status={{ state: rowState, unread, failed: chat.lastAssistantFailed === true }}
        selected={chat.id === activeChatId}
        indented={indented}
        {...(inboxParts ? { layout: "inbox" as const, inbox: inboxParts } : {})}
        icon={
          renamingWithAppleId === chat.id ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : undefined
        }
        busy={renamingWithAppleId === chat.id}
        forkedFrom={forkedFrom}
        context={
          // Only rows in a group the user expanded (not one search opened)
          // read live branch PRs, as the old group indicator did, and only
          // once their dismissals are known.
          <ChatRowContextGlyphs
            workspace={chat.workspaceId ? workspacesById.get(chat.workspaceId) : undefined}
            pullRequests={sidebarPullRequests[chat.id]}
            live={liveContext && sidebarPullRequestsKnown.has(chat.id)}
          />
        }
        shortcutHint={shortcutBinding ? prettyAccelerator(shortcutBinding) : undefined}
        shortcutsRevealed={chatShortcutsVisible}
        ariaKeyShortcuts={ariaKeyShortcut(shortcutBinding)}
        menu={menuItems}
        onPointerEnter={() => prefetchChat(chat.id)}
        onFocus={() => prefetchChat(chat.id)}
        onOpen={() => void openChat(chat)}
      />
    );
  };

  // A Bot's Inbox row: its avatar and "Bot" in place of a project. Opening it
  // opens the Bot's chat; Mark read records its newest reply as seen.
  const renderBotInboxRow = (
    entry: InboxEntry,
    source: Extract<InboxEntry["source"], { kind: "bot" }>,
    context: InboxRowContext,
  ) => {
    const { bot } = source;
    const shortcutNumber = inboxShortcutNumbers.get(entry.key);
    const shortcutBinding = shortcutNumber ? commandBinding(`chat.jump.${shortcutNumber}` as CommandId) : null;
    // Mark read clears the unread reply only: it isn't a visit, so `/bots` still opens the Bot last viewed.
    const inboxParts = inboxRowParts(entry, context, () =>
      botSidebarPreferenceActions.markReplySeen(bot.id, source.lastReplyAt));
    const inboxAction = inboxParts.action;
    const open = () => void navigate(botChatPath(bot.id));
    return (
      <ChatRow
        key={entry.key}
        title={bot.name}
        status={{
          state: entry.signals.rowState === "needs_input" ? "needs_input" : source.working ? "working" : "idle",
          unread: entry.signals.unread,
        }}
        selected={entry.signals.isOpen}
        layout="inbox"
        inbox={{ ...inboxParts, metaIcon: <AvatarFace avatar={bot.avatar} /> }}
        shortcutHint={shortcutBinding ? prettyAccelerator(shortcutBinding) : undefined}
        shortcutsRevealed={chatShortcutsVisible}
        ariaKeyShortcuts={ariaKeyShortcut(shortcutBinding)}
        {...(inboxAction
          ? {
              menu: ((Item) => (
                <Item icon={CHAT_ROW_INBOX_ACTIONS[inboxAction.kind].menuIcon} onSelect={inboxAction.onSelect}>
                  {CHAT_ROW_INBOX_ACTIONS[inboxAction.kind].label}
                </Item>
              )) satisfies ChatRowMenu,
            }
          : {})}
        onOpen={open}
      />
    );
  };

  // A paired host's Bot: opening it opens its chat on that host. It has no read
  // state there, so it offers no Mark read; its next run clears a failure.
  const renderRemoteBotInboxRow = (
    entry: InboxEntry,
    source: Extract<InboxEntry["source"], { kind: "remoteBot" }>,
    context: InboxRowContext,
  ) => {
    const shortcutNumber = inboxShortcutNumbers.get(entry.key);
    const shortcutBinding = shortcutNumber ? commandBinding(`chat.jump.${shortcutNumber}` as CommandId) : null;
    const inboxParts = inboxRowParts(entry, context, () => undefined);
    return (
      <ChatRow
        key={entry.key}
        title={source.name}
        status={{
          state: entry.signals.rowState === "needs_input" ? "needs_input" : source.working ? "working" : "idle",
          unread: entry.signals.unread,
          failed: entry.signals.failed,
        }}
        selected={entry.signals.isOpen}
        layout="inbox"
        remote={{ hostLabel: entry.hostLabel, stale: !entry.signals.hostOnline }}
        inbox={{ ...inboxParts, ...(source.avatar ? { metaIcon: <AvatarFace avatar={source.avatar} /> } : {}) }}
        shortcutHint={shortcutBinding ? prettyAccelerator(shortcutBinding) : undefined}
        shortcutsRevealed={chatShortcutsVisible}
        ariaKeyShortcuts={ariaKeyShortcut(shortcutBinding)}
        busy={openingHostBot === `${entry.hostId}/${source.botId}`}
        onOpen={() => openHostBot(entry.hostId, source.botId)}
      />
    );
  };

  // Remote rows offer only what this Mac's client for that host supports; stale rows look muted.
  const renderRemoteChatRow = (
    chat: RemoteSidebarChat,
    indented = false,
    inbox?: { entry: InboxEntry; context: InboxRowContext },
  ) => {
    const actions = remoteChatRowActions(chat, remoteCapabilities.get(chat.hostId) ?? NO_REMOTE_CAPABILITIES);
    const inboxParts = inbox
      ? inboxRowParts(inbox.entry, inbox.context, () => void markRemoteChatRead(chat))
      : undefined;
    const shortcutNumber = inbox ? inboxShortcutNumbers.get(inbox.entry.key) : undefined;
    const shortcutBinding = shortcutNumber
      ? commandBinding(`chat.jump.${shortcutNumber}` as CommandId)
      : null;
    // Triage needs the host's `chat-triage-v1` grant; a host that isn't online
    // (`hostControlRefusal`) shows the items disabled rather than queueing them.
    const capabilitiesForHost = remoteCapabilities.get(chat.hostId);
    const triageable = inbox !== undefined && (capabilitiesForHost?.has("triage") ?? false);
    const menuItems = remoteChatRowMenu(actions, {
      ...(inboxParts ? { inboxAction: inboxParts.action ?? null } : {}),
      ...(triageable
        ? {
            triage: (...parts: Parameters<ChatRowMenu>) =>
              inboxTriageItems(
                parts,
                inbox.entry,
                inbox.context,
                remoteTriageRow(chat),
                chat.stale || inbox.context.dimmed,
                capabilitiesForHost?.has("markRead") ? () => void markRemoteChatRead(chat) : null,
              ),
          }
        : {}),
      onOpen: () => void openRemoteChat(chat),
      onMarkRead: () => void markRemoteChatRead(chat),
      onRename: () => {
        setRenameValue(chat.title);
        setRemoteRenaming({ hostId: chat.hostId, chatId: chat.chatId, hostLabel: chat.hostLabel });
      },
    });
    return (
      <ChatRow
        key={chat.key}
        title={chat.title}
        status={{ state: chat.rowState, unread: chat.unread, failed: chat.lastRunFailed }}
        selected={
          activeRemoteChat?.hostId === chat.hostId && activeRemoteChat.chatId === chat.chatId
        }
        indented={indented}
        remote={{ hostLabel: chat.hostLabel, stale: chat.stale }}
        {...(inboxParts ? { layout: "inbox" as const, inbox: inboxParts } : {})}
        shortcutHint={shortcutBinding ? prettyAccelerator(shortcutBinding) : undefined}
        shortcutsRevealed={chatShortcutsVisible}
        ariaKeyShortcuts={ariaKeyShortcut(shortcutBinding)}
        menu={menuItems}
        onOpen={() => void openRemoteChat(chat)}
      />
    );
  };

  const renderSidebarChat = (summary: SidebarRow, indented = false, liveContext = false) =>
    isRemoteSidebarChat(summary)
      ? renderRemoteChatRow(summary, indented)
      : renderChatRow(summary.chat, indented, liveContext);

  // A workspace that lives only on a paired host. Its rows are last-known while the
  // host is unreachable, and nothing here changes the host's data.
  const renderRemoteProjectGroup = ({
    group,
    primary,
    visibleChats,
    remainingChatCount,
    dropProps,
    dragProps,
    dropIndicator,
    moveItems,
  }: {
    group: SidebarProjectGroup<SidebarEntry, SidebarRow>;
    primary: RemoteSidebarProject;
    visibleChats: SidebarRow[];
    remainingChatCount: number;
    dropProps: React.HTMLAttributes<HTMLDivElement>;
    dragProps: React.HTMLAttributes<HTMLDivElement>;
    dropIndicator: React.ReactNode;
    moveItems: React.ReactNode;
  }) => {
    const projectKey = group.project.key;
    const expanded = searching || expandedRemoteKeys.has(projectKey);
    const name = group.project.name;
    const accessibleName = `${name}, on ${primary.hostLabel}${primary.stale ? ", offline" : ""}`;
    return (
      <RowGroup
        key={projectKey}
        data-remote-project={primary.stale ? "stale" : "live"}
        {...dropProps}
        dropIndicator={dropIndicator}
        dragProps={dragProps}
        expanded={expanded}
        icon={<Folder />}
        accessibleName={accessibleName}
        onToggle={() => toggleRemoteProject(projectKey)}
        title={
              <span className="flex min-w-0 flex-col">
                <span className={primary.stale ? "truncate text-secondary" : "truncate"}>{name}</span>
                <span className="flex min-w-0 items-center gap-1 text-small text-tertiary">
                  {primary.branchName ? (
                    <span className="max-w-[45%] truncate">{primary.branchName} ·</span>
                  ) : null}
                  <span className="truncate">{primary.hostLabel}</span>
                </span>
                <MachineBadges labels={projectEntryMachineLabels(group.project)} />
              </span>
        }
        actions={
          <div className="group/workspace-actions relative size-7 shrink-0">
            <SidebarOverflowMenu
              ariaLabel={`Actions for ${accessibleName}`}
              triggerClassName="workspace-overflow-trigger pointer-events-none absolute inset-0 size-7 text-tertiary opacity-0 group-hover/workspace:pointer-events-auto group-hover/workspace:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100"
              contentClassName="w-64"
            >
              <DropdownMenuItem
                disabled={group.chats.length === 0}
                onSelect={() => openSidebarChat(latestProjectChat(group))}
              >
                Open latest chat
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={primary.stale}
                onSelect={() =>
                  void navigate({
                    to: "/host/$hostId/new",
                    params: { hostId: primary.hostId },
                    search: { workspaceId: primary.workspaceId },
                  })
                }
              >
                {`New chat on ${primary.hostLabel}`}
              </DropdownMenuItem>
              {moveItems}
            </SidebarOverflowMenu>
          </div>
        }
      >
            {visibleChats.map((summary) => renderSidebarChat(summary, true))}
            {group.chats.length === 0 ? (
              <SidebarListItem data-roving-item className="pl-9 text-secondary" title="No chats yet" disabled />
            ) : null}
            {remainingChatCount > 0 ? (
              <SidebarListItem
                data-roving-item
                className="pl-9 text-secondary"
                title={`Show ${remainingChatCount} more`}
                onClick={() => setRevealedRemoteKeys((current) => new Set(current).add(projectKey))}
              />
            ) : null}
      </RowGroup>
    );
  };

  const machineFilterChip =
    hasHosts && shownMachines !== "all" ? (
      <MachineFilterChip
        label={machineFilterLabel(shownMachines, peerHosts.hosts)}
        onClear={() => setMachineFilter("all")}
      />
    ) : null;

  const sidebarOrganizationMenu = (
    <SidebarOverflowMenu
      ariaLabel="Organize sidebar"
      triggerClassName="size-7 text-tertiary"
      contentClassName="w-56"
    >
      <SidebarOrganizeMenuItems
        view={view}
        chatSort={chatSort}
        projectSort={projectSort}
        onViewChange={setView}
        onChatSortChange={setChatSort}
        onProjectSortChange={changeProjectSort}
        machines={
          hasHosts
            ? {
                hosts: peerHosts.hosts,
                filter: shownMachines,
                grouping: projectGrouping,
                onFilterChange: setMachineFilter,
                onGroupingChange: setProjectGrouping,
              }
            : undefined
        }
      />
    </SidebarOverflowMenu>
  );

  const workspaceCreationMenu = (
    <SidebarOverflowMenu
      ariaLabel="Add workspace"
      triggerClassName="size-7 text-tertiary"
      contentClassName="w-64"
      triggerIcon={<FolderPlus />}
    >
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
    </SidebarOverflowMenu>
  );

  return (
    <>
      <Sidebar
        listRegionRef={rovingRef}
        belowList={
          inboxActive ? (
            <div
              ref={setInboxShelfHost}
              data-inbox-shelf-host=""
              className="dimmable relative z-1 flex min-h-0 shrink-0 flex-col empty:hidden"
            />
          ) : undefined
        }
        searchable
        searchPlaceholder="Search chats…"
        searchValue={search}
        onSearchChange={setSearch}
        actions={
          <SplitView.SidebarToggle>
            <HistoryNavButtons />
          </SplitView.SidebarToggle>
        }
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
        <SidebarPrimaryNav
          pathname={pathname}
          capabilities={capabilities}
          newAgentDisabled={!activeId || appendReconciliationRequired}
          onNewAgent={() => void newAgent()}
          onNewChatIn={() => execute("chat.newIn")}
          newChatInKeyShortcut={ariaKeyShortcut(commandBinding("chat.newIn"))}
          onNavigate={(to) => void navigate(to === "/bots" ? botListLocation() : { to })}
          openBotShownBelow={botInbox.listed.some((entry) => entry.signals.isOpen && inboxEntriesByKey.has(entry.key))}
        />

        {hasHosts ? (
          <RemoteHostStatusList
            hosts={peerHosts.hosts}
            filter={shownMachines}
            onReconnect={reconnectHost}
            onManage={openRemoteSettings}
          />
        ) : null}

        <SidebarList>
          {view === "projects" ? (
            <SidebarListGroup
              title={
                <SectionHeader
                  label="Workspaces"
                  accessory={machineFilterChip}
                  actions={
                    <span className="flex items-center gap-0.5">
                      {sidebarOrganizationMenu}
                      {workspaceCreationMenu}
                    </span>
                  }
                />
              }
            >
              {chats.isLoading ? (
                <EmptyState
                  placement="inline"
                  title="Loading chats…"
                  description="Reading workspace history."
                />
              ) : chats.isError ? (
                <div role="alert" className="flex flex-col gap-1">
                  <EmptyState
                    placement="inline"
                    title="Chats couldn’t load"
                    description="Retry before starting a chat from an empty workspace."
                  />
                  <SidebarListItem title="Retry" onClick={() => void chats.refetch()} />
                </div>
              ) : organized.projectGroups.length === 0 ? (
                <EmptyState
                  placement="inline"
                  title={
                    search.trim()
                      ? "No matches"
                      : shownMachines !== "all"
                        ? `No workspaces on ${machineFilterLabel(shownMachines, peerHosts.hosts)}`
                        : "No workspaces yet"
                  }
                  description={
                    search.trim()
                      ? "Try a different search."
                      : shownMachines !== "all"
                        ? "Choose All machines in Organize to see every workspace."
                        : "Add a folder or create an empty workspace to begin."
                  }
                />
              ) : (
                organized.projectGroups.map((group) => {
                  const projectKey = group.project.key;
                  const primary = group.project.primary;
                  const visibleChats = visibleProjectChats(group, displayOptions);
                  const remainingChatCount = group.chats.length - visibleChats.length;
                  const dropPlacement =
                    projectDropTarget?.key === projectKey ? projectDropTarget.placement : null;
                  const dropProps = {
                    "data-project-drop": dropPlacement ?? undefined,
                    onDragOver:
                      manualReorderEnabled && draggedProjectKey && draggedProjectKey !== projectKey
                        ? (event: React.DragEvent<HTMLDivElement>) => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            const bounds = event.currentTarget.getBoundingClientRect();
                            const placement =
                              event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
                            if (dropPlacement !== placement) {
                              setProjectDropTarget({ key: projectKey, placement });
                            }
                          }
                        : undefined,
                    onDrop:
                      manualReorderEnabled && draggedProjectKey
                        ? (event: React.DragEvent<HTMLDivElement>) => {
                            event.preventDefault();
                            if (dropPlacement && draggedProjectKey !== projectKey) {
                              commitProjectOrder(
                                moveProjectKeyTo(
                                  organized.projectOrder,
                                  draggedProjectKey,
                                  projectKey,
                                  dropPlacement,
                                ),
                              );
                            }
                            endProjectDrag();
                          }
                        : undefined,
                  };
                  const dragProps = {
                    draggable: manualReorderEnabled || undefined,
                    onDragStart: manualReorderEnabled
                      ? (event: React.DragEvent<HTMLDivElement>) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", group.project.name);
                          setDraggedProjectKey(projectKey);
                        }
                      : undefined,
                    onDragEnd: manualReorderEnabled ? endProjectDrag : undefined,
                  };
                  const dropIndicator = dropPlacement ? (
                    <div
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-pill bg-accent ${
                        dropPlacement === "before" ? "-top-px" : "-bottom-px"
                      }`}
                    />
                  ) : null;
                  const moveItems =
                    projectSort === "manual" ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={
                            searching || !canMoveProjectKey(organized.projectOrder, projectKey, -1)
                          }
                          onSelect={() =>
                            commitProjectOrder(moveProjectKey(organized.projectOrder, projectKey, -1))
                          }
                        >
                          Move up
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={
                            searching || !canMoveProjectKey(organized.projectOrder, projectKey, 1)
                          }
                          onSelect={() =>
                            commitProjectOrder(moveProjectKey(organized.projectOrder, projectKey, 1))
                          }
                        >
                          Move down
                        </DropdownMenuItem>
                      </>
                    ) : null;
                  if (isRemoteSidebarProject(primary)) {
                    return renderRemoteProjectGroup({
                      group,
                      primary,
                      visibleChats,
                      remainingChatCount,
                      dropProps,
                      dragProps,
                      dropIndicator,
                      moveItems,
                    });
                  }
                  const workspace = primary.workspace;
                  const chatsGroup = isNoWorkspace(workspace);
                  const groupName = chatsGroup ? NO_WORKSPACE_GROUP_LABEL : workspaceDisplayName(workspace, workspaces);
                  const secondaryLabel = chatsGroup ? undefined : workspaceSecondaryLabel(workspace, pathPreferences);
                  const explicitlyExpanded = expandedWorkspaceIds.has(workspace.id);
                  const expanded = searching || explicitlyExpanded;
                  return (
                    <RowGroup
                      key={projectKey}
                      {...dropProps}
                      dropIndicator={dropIndicator}
                      dragProps={dragProps}
                      expanded={expanded}
                      icon={chatsGroup ? <MessageCircle /> : <Folder />}
                      accessibleName={workspaceAccessibleName(workspace, pathPreferences, workspaces)}
                      onToggle={() => toggleWorkspace(workspace.id)}
                      title={
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{groupName}</span>
                              {!chatsGroup && workspace.folderPath && pathPreferences.showWorkspacePaths ? (
                                <span className="flex min-w-0 items-center gap-1 text-small text-tertiary">
                                  {workspace.managedWorktree?.branch ? <span className="max-w-[45%] truncate">{workspace.managedWorktree.branch} ·</span> : null}
                                  <WorkspacePathLabel path={workspace.folderPath} format={pathPreferences.workspacePathFormat} />
                                </span>
                              ) : secondaryLabel ? <span className="truncate text-small text-tertiary">{secondaryLabel}</span> : null}
                              <MachineBadges labels={projectEntryMachineLabels(group.project)} />
                            </span>
                      }
                      actions={
                        <>
                        <Button
                          variant="transparent"
                          size="small"
                          iconOnly
                          aria-label={chatsGroup ? "New chat without a workspace" : `New chat in ${groupName}`}
                          disabled={Boolean(settingsBlockedReason) || appendReconciliationRequired}
                          className="size-7 shrink-0 text-tertiary opacity-0 group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100 focus-visible:opacity-100"
                          onClick={() => void newAgentInWorkspace(workspace.id)}
                        >
                          <Plus />
                        </Button>
                        <div className="group/workspace-actions relative size-7 shrink-0">
                          <SidebarOverflowMenu
                            ariaLabel={`Actions for ${workspaceAccessibleName(workspace, pathPreferences, workspaces)}`}
                            triggerClassName="workspace-overflow-trigger pointer-events-none absolute inset-0 size-7 text-tertiary opacity-0 group-hover/workspace:pointer-events-auto group-hover/workspace:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100"
                            contentClassName="w-64"
                          >
                            <DropdownMenuItem
                              disabled={
                                Boolean(settingsBlockedReason) || appendReconciliationRequired
                              }
                              onSelect={() => void newAgentInWorkspace(workspace.id)}
                            >
                              New chat
                            </DropdownMenuItem>
                            {workspaceHasOwnSettings(workspace) ? (
                              <DropdownMenuItem onSelect={() => openWorkspaceSettings(workspace.id)}>
                                Workspace settings…
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                              disabled={workspaceSwitchBlocked || group.chats.length === 0}
                              title={
                                group.chats.length === 0
                                  ? "Choose New chat to start this workspace."
                                  : undefined
                              }
                              onSelect={() => openSidebarChat(latestProjectChat(group))}
                            >
                              Open latest chat
                            </DropdownMenuItem>
                            {!chatsGroup && workspace.folderPath ? (
                              <DropdownMenuItem
                                onSelect={() => void revealWorkspace(workspace)}
                              >
                                Show in file manager
                              </DropdownMenuItem>
                            ) : null}
                            {moveItems}
                            {/* The Chats group is a view over hidden folders: nothing to remove. */}
                            {!chatsGroup && workspaces.length > 1 ? <DropdownMenuSeparator /> : null}
                            {workspaces.length > 1 && workspace.managedWorktree ? (
                              <DropdownMenuItem
                                disabled={workspaceActionBlocked}
                                icon="trash"
                                color="red"
                                onSelect={() => setDeletingWorktree(workspace)}
                              >
                                Delete worktree…
                              </DropdownMenuItem>
                            ) : null}
                            {!chatsGroup && workspaces.length > 1 && !workspace.managedWorktree ? (
                              <DropdownMenuItem
                                disabled={workspaceActionBlocked}
                                icon="trash"
                                color="red"
                                onSelect={() => setRemovingWorkspace(workspace)}
                              >
                                Remove “{workspace.name}”
                              </DropdownMenuItem>
                            ) : null}
                          </SidebarOverflowMenu>
                        </div>
                        </>
                      }
                    >
                          {draftsByWorkspace.get(workspace.id)?.map(renderDraftRow)}
                          {visibleChats.map((summary) => renderSidebarChat(summary, true, explicitlyExpanded))}
                          {group.chats.length === 0 &&
                          !draftsByWorkspace.has(workspace.id) ? (
                            <SidebarListItem
                              data-roving-item
                              className="pl-9 text-secondary"
                              icon={<SquarePen />}
                              title="New chat"
                              disabled={
                                Boolean(settingsBlockedReason) || appendReconciliationRequired
                              }
                              onClick={() => void newAgentInWorkspace(workspace.id)}
                            />
                          ) : null}
                          {remainingChatCount > 0 ? (
                            <SidebarListItem
                              data-roving-item
                              className="pl-9 text-secondary"
                              title={`Show ${remainingChatCount} more`}
                              onClick={() =>
                                setFullyRevealedWorkspaceIds((current) =>
                                  new Set(current).add(workspace.id),
                                )
                              }
                            />
                          ) : null}
                    </RowGroup>
                  );
                })
              )}
            </SidebarListGroup>
          ) : chats.isLoading ? (
            <SidebarListGroup
              title={
                <SectionHeader
                  label={chatViewTitle}
                  accessory={machineFilterChip}
                  actions={sidebarOrganizationMenu}
                />
              }
            >
              <EmptyState
                placement="inline"
                title="Loading chats…"
                description="Reading workspace history."
              />
            </SidebarListGroup>
          ) : chats.isError ? (
            <SidebarListGroup
              title={
                <SectionHeader
                  label={chatViewTitle}
                  accessory={machineFilterChip}
                  actions={sidebarOrganizationMenu}
                />
              }
            >
              <div role="alert" className="flex flex-col gap-1">
                <EmptyState
                  placement="inline"
                  title="Chats couldn’t load"
                  description="Retry to restore workspace history."
                />
                <SidebarListItem title="Retry" onClick={() => void chats.refetch()} />
              </div>
            </SidebarListGroup>
          ) : inboxActive ? (
            <InboxView
              entries={inboxEntries}
              present={inboxPresent}
              unlisted={inboxUnlisted}
              searching={searching}
              resetKey={`${search.trim()}\u0000${shownMachines}`}
              activeKey={activeInboxKey}
              headerAccessory={
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="rounded-pill bg-control px-1.5 text-mini font-medium text-tertiary">
                    Beta
                  </span>
                  {machineFilterChip}
                </span>
              }
              headerActions={sidebarOrganizationMenu}
              shelfHost={inboxShelfHost}
              onShortcutOrderChange={updateInboxShortcutKeys}
              handleRef={inboxViewRef}
              renderRow={(entry, context) =>
                entry.source.kind === "remote"
                  ? renderRemoteChatRow(entry.source.chat, false, { entry, context })
                  : entry.source.kind === "bot"
                    ? renderBotInboxRow(entry, entry.source, context)
                    : entry.source.kind === "remoteBot"
                      ? renderRemoteBotInboxRow(entry, entry.source, context)
                      : renderChatRow(entry.source.chat, false, false, { entry, context })
              }
            />
          ) : organized.chatSections.length === 0 ? (
            <SidebarListGroup
              title={
                <SectionHeader
                  label={chatViewTitle}
                  accessory={machineFilterChip}
                  actions={sidebarOrganizationMenu}
                />
              }
            >
              <EmptyState
                placement="inline"
                title={search.trim() ? "No matches" : "No chats yet"}
                description={
                  search.trim()
                    ? "Try a different search."
                    : "Start a new conversation to see it here."
                }
              />
            </SidebarListGroup>
          ) : (
            organized.chatSections.map((group, index) => (
              <SidebarListGroup
                key={group.id}
                title={
                  index === 0 ? (
                    <SectionHeader
                      label={group.label}
                      accessory={machineFilterChip}
                      actions={sidebarOrganizationMenu}
                    />
                  ) : (
                    <SectionHeader label={group.label} />
                  )
                }
              >
                {group.chats.map((summary) => renderSidebarChat(summary))}
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

      <Dialog
        open={remoteRenaming !== null}
        onOpenChange={(open) => !open && !remoteRenameBusy && setRemoteRenaming(null)}
        title="Rename chat"
        description={
          remoteRenaming
            ? `Choose the name shown for this conversation on ${remoteRenaming.hostLabel}.`
            : undefined
        }
        confirmLabel="Save"
        confirmDisabled={!renameValue.trim() || remoteRenameBusy}
        busy={remoteRenameBusy}
        onConfirm={commitRemoteRename}
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
              Dirty worktrees are refused. Target: {deletingWorktree.folderPath ?? deletingWorktree.name}.
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
              listed. The folder itself is not touched. Target:{" "}
              {removingWorkspace.folderPath ?? removingWorkspace.name}.
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
