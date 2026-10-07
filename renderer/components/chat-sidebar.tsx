import { createChatDraft, discardChatDraft } from "../lib/chat-draft";
import { forkedFromLabel } from "../lib/chat-copy-view";
// Unified workspace/chat sidebar with workspace-grouped, recent, and
// needs-attention views, route-driven selection, and workspace/chat actions.

import * as React from "react";
import { workspaceDisplayName, workspaceSecondaryLabel, type WorkspacePathPreferences } from "../lib/workspace-path-display";
import { WorkspacePathLabel } from "./workspace-path-label";
import { useWorkspacePathPreferences } from "../lib/use-workspace-path-preferences";
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
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
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  ExternalLink,
  Folder,
  FolderPlus,
  FolderGit2,
  GitFork,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  Settings,
  SquarePen,
  UserRound,
} from "lucide-react";
import { BotSidebarIcon } from "./bot-avatar";
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
import { queryKeys, useAllRegularChats, useFoundationModelsConnection, useGitPullRequestStatus } from "../lib/queries";
import { formatGitHubPausedUntil, githubPausedUntil } from "../lib/github-pause";
import { useActiveWorkspace } from "../lib/workspace-context";
import { useEnvironmentPanel } from "./environment-panel";
import type { ChatMeta, GitHubPullRequestCheck, GitHubPullRequestChecksState, Workspace } from "../lib/types";
import { useCommandSystem } from "../lib/command-system";
import type { CommandId } from "../shared/keybindings";
import { ariaKeyShortcut, prettyAccelerator } from "../shared/keybindings";
import { removeDeletedChatFromCache } from "../lib/chat-deletion-cache";
import { useAppUpdateSnapshot } from "../lib/use-app-update-snapshot";
import type { AppUpdateRestartResult, AppUpdateSnapshot } from "../shared/app-update";
import { useChatActivityState, useChatReadMarkers } from "../lib/use-chat-activity";
import { chatRowStateFor } from "../lib/chat-activity";
import { isChatUnread } from "../shared/chat-row-state";
import { ChatRowStatus } from "./chat-row-status";
import { RemoteConnectionPopover } from "./remote-connection-popover";
import { useAppCapabilities } from "../lib/app-capabilities";
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
  mergeProjectOrder,
  moveProjectKey,
  moveProjectKeyTo,
  organizeSidebar,
  parseSidebarPreferences,
  serializeSidebarPreferences,
  sidebarAttention,
  visibleProjectChats,
  type SidebarChatSort,
  type SidebarMachineFilter,
  type SidebarProjectGroup,
  type SidebarProjectGrouping,
  type SidebarProjectSort,
  type SidebarView,
} from "../lib/sidebar-organization";
import { SidebarOrganizeMenuItems } from "./sidebar-organize-menu";
import {
  combineSidebarRows,
  effectiveMachineFilter,
  isRemoteSidebarChat,
  isRemoteSidebarProject,
  machineFilterLabel,
  projectEntryMachineLabels,
  remoteSidebarRows,
  type RemoteSidebarChat,
  type RemoteSidebarProject,
  type SidebarProjectEntry,
} from "../lib/sidebar-remote-groups";
import { useLocalRepositoryIdentities, usePeerHostSidebar } from "../lib/hosts/use-peer-host-sidebar";
import {
  MachineBadges,
  MachineFilterChip,
  RemoteHostMarker,
  RemoteHostStatusList,
} from "./sidebar-remote";

const AIDEN_MARK_URL = new URL("../../resources/app-icon.png", import.meta.url).href;
const SIDEBAR_PREFERENCES_KEY = "aiden-agent.sidebar.v1";
const COLLAPSED_WORKSPACE_CHAT_LIMIT = 4;
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

function workspaceAccessibleName(workspace: Workspace, preferences: WorkspacePathPreferences, workspaces: readonly Workspace[]): string {
  return [workspaceDisplayName(workspace, workspaces), workspaceSecondaryLabel(workspace, preferences)].filter(Boolean).join(", ");
}

function SidebarOverflowMenu({
  ariaLabel,
  triggerClassName,
  contentClassName,
  triggerIcon = <MoreHorizontal />,
  children,
}: React.PropsWithChildren<{
  ariaLabel: string;
  triggerClassName?: string;
  contentClassName: string;
  triggerIcon?: React.ReactNode;
}>) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [sideOffset, setSideOffset] = React.useState(8);
  const [contentAlign, setContentAlign] = React.useState<"start" | "end">("start");
  const [contentAlignOffset, setContentAlignOffset] = React.useState(0);
  const [contentMaxHeight, setContentMaxHeight] = React.useState<number>();
  const [open, setOpen] = React.useState(false);

  const positionOutsideSidebar = React.useCallback(() => {
    const trigger = triggerRef.current;
    const sidebar = trigger?.closest<HTMLElement>("[data-sidebar]");
    if (!trigger || !sidebar) return;

    const triggerBounds = trigger.getBoundingClientRect();
    const sidebarBounds = sidebar.getBoundingClientRect();
    const nextAlign = triggerBounds.bottom > window.innerHeight / 2 ? "end" : "start";
    const viewportPadding = 8;
    const nextAlignOffset =
      nextAlign === "end"
        ? Math.max(0, triggerBounds.bottom - (window.innerHeight - viewportPadding))
        : Math.max(0, viewportPadding - triggerBounds.top);
    const contentEdge =
      nextAlign === "end"
        ? triggerBounds.bottom - nextAlignOffset
        : triggerBounds.top + nextAlignOffset;
    setSideOffset(Math.max(8, Math.ceil(sidebarBounds.right - triggerBounds.right) + 8));
    setContentAlign(nextAlign);
    setContentAlignOffset(nextAlignOffset);
    setContentMaxHeight(
      Math.max(
        1,
        Math.floor(
          nextAlign === "end"
            ? contentEdge - viewportPadding
            : window.innerHeight - contentEdge - viewportPadding,
        ),
      ),
    );
  }, []);

  React.useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", positionOutsideSidebar);
    return () => window.removeEventListener("resize", positionOutsideSidebar);
  }, [open, positionOutsideSidebar]);

  return (
    <DropdownMenu
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) positionOutsideSidebar();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant="transparent"
          size="small"
          iconOnly
          className={triggerClassName}
          aria-label={ariaLabel}
        >
          {triggerIcon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align={contentAlign}
        alignOffset={contentAlignOffset}
        sideOffset={sideOffset}
        avoidCollisions={false}
        className={contentClassName}
        style={{ maxHeight: contentMaxHeight, overflowY: "auto" }}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function pullRequestChecksLabel(state: GitHubPullRequestChecksState | null | undefined, checkCount = 0): string {
  switch (state) {
    case "passing":
      return "All checks have passed";
    case "failing":
      return "Some checks were not successful";
    case "pending":
      return "Some checks haven’t completed yet";
    default:
      return checkCount > 0 ? "Checks did not run" : "No checks reported";
  }
}

function pullRequestChecksTone(state: GitHubPullRequestChecksState | null | undefined): string {
  switch (state) {
    case "passing":
      return "bg-status-green-surface text-status-green";
    case "failing":
      return "bg-status-red-surface text-status-red";
    case "pending":
      return "bg-status-warning-surface text-status-warning";
    default:
      return "bg-control text-secondary";
  }
}

function pullRequestChecksIconTone(state: GitHubPullRequestChecksState | null | undefined): string {
  switch (state) {
    case "passing":
      return "text-status-green";
    case "failing":
      return "text-status-red";
    case "pending":
      return "text-status-warning";
    default:
      return "text-secondary";
  }
}

function checkStatusLabel(check: GitHubPullRequestCheck): string {
  if (check.status === "action-required" && /\/actions\/runs\/\d+/u.test(check.url ?? "")) {
    return "Awaiting approval";
  }
  switch (check.status) {
    case "success":
      return "Passed";
    case "failure":
      return "Failed";
    case "pending":
      return "Running";
    case "action-required":
      return "Awaiting action";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
    case "neutral":
      return "Neutral";
  }
}

function checkStatusTone(check: GitHubPullRequestCheck): string {
  switch (check.status) {
    case "success":
      return "text-status-green";
    case "failure":
      return "text-status-red";
    case "pending":
    case "action-required":
      return "text-status-warning";
    case "cancelled":
    case "skipped":
    case "neutral":
      return "text-tertiary";
  }
}

function checksIcon(state: GitHubPullRequestChecksState | null | undefined) {
  if (state === "passing") return <CheckCircle2 className="size-3.5" />;
  if (state === "failing") return <AlertCircle className="size-3.5" />;
  return <CircleDashed className="size-3.5" />;
}

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

function pullRequestStateLabel(state: "open" | "closed" | "merged", isDraft?: boolean): string | null {
  if (state === "merged") return "Merged";
  if (state === "closed") return "Closed";
  if (isDraft) return "Draft";
  return null;
}

function WorkspacePullRequestIndicator({ workspace, visible, accessibilityName }: { workspace: Workspace; visible: boolean; accessibilityName: string }) {
  const enabled = visible && Boolean(workspace.folderPath && workspace.permission !== "none");
  const status = useGitPullRequestStatus(workspace.id, enabled);
  const pullRequest = status.data?.pullRequest;
  if (!enabled || status.isLoading) return null;
  const pausedUntil = githubPausedUntil(status.data, Date.now());
  const pausedLabel = pausedUntil === undefined ? undefined : formatGitHubPausedUntil(pausedUntil, Date.now());

  if (!pullRequest && pausedLabel) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="transparent"
            size="small"
            iconOnly
            className="text-tertiary"
            aria-label={`${accessibilityName} GitHub pull request status: ${pausedLabel}`}
            onClick={(event) => event.stopPropagation()}
          >
            <Clock3 aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start" aria-label="GitHub pull request status">
          <p className="text-small-strong text-primary">{pausedLabel}</p>
          <p className="mt-1 text-small text-secondary">
            GitHub's API rate limit was reached. Aiden checks pull requests again once it resets.
          </p>
        </PopoverContent>
      </Popover>
    );
  }

  if (!pullRequest) {
    const message = status.data?.message;
    if (
      !message ||
      status.data?.availability === "no-pull-request" ||
      status.data?.availability === "not-repo" ||
      status.data?.availability === "not-github"
    ) return null;
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="transparent"
            size="small"
            iconOnly
            className="text-status-red"
            aria-label={`${accessibilityName} GitHub pull request status: ${message}`}
            onClick={(event) => event.stopPropagation()}
          >
            <AlertCircle aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start" aria-label="GitHub pull request status">
          <p className="text-small-strong text-primary">GitHub status unavailable</p>
          <p className="mt-1 text-small text-secondary">{message}</p>
          <div className="mt-3 flex justify-end">
            <Button variant="muted" size="small" onClick={() => void status.refetch()} disabled={status.isFetching}>
              {status.isFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  const stateLabel = pullRequestStateLabel(pullRequest.state, pullRequest.isDraft);
  const displayChecksState = stateLabel ? undefined : pullRequest.checksState;
  const checkLabel = pullRequestChecksLabel(pullRequest.checksState, pullRequest.checks.length);
  const label = stateLabel ? `${stateLabel}; ${checkLabel}` : checkLabel;
  const visibleChecks = pullRequest.checks.slice(0, 6);
  const remainingChecks = pullRequest.checks.length - visibleChecks.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          className={pullRequestChecksIconTone(displayChecksState)}
          aria-label={`${accessibilityName} pull request #${pullRequest.number}: ${label}`}
          onClick={(event) => event.stopPropagation()}
        >
          <GitPullRequest aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start" aria-label={`Pull request #${pullRequest.number} checks`}>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-small-strong text-primary">
              <GitPullRequest className="size-4 shrink-0 text-secondary" aria-hidden="true" />
              <span className="truncate">PR #{pullRequest.number}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-regular text-primary">{pullRequest.title}</p>
            <p className="mt-1 truncate text-small text-tertiary">
              {pullRequest.headBranch} → {pullRequest.baseBranch}
            </p>
            {stateLabel ? <span className="mt-2 inline-flex rounded-control bg-control px-2 py-0.5 text-small-strong text-secondary">{stateLabel}</span> : null}
          </div>
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label={`Open pull request #${pullRequest.number}`}
            onClick={() => openExternal(pullRequest.url)}
          >
            <ExternalLink />
          </Button>
        </div>
        <div className={`mt-3 flex items-center gap-2 rounded-control px-2.5 py-2 text-small ${pullRequestChecksTone(displayChecksState)}`} role="status">
          {checksIcon(displayChecksState)}
          <span>{checkLabel}</span>
        </div>
        {visibleChecks.length > 0 ? (
          <div className="mt-3 flex flex-col gap-1.5">
            {visibleChecks.map((check) => (
              <div key={`${check.name}:${check.status}:${check.url ?? ""}`} className="flex min-w-0 items-center gap-2 text-small">
                <span className={`size-1.5 shrink-0 rounded-full bg-current ${checkStatusTone(check)}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-primary" title={check.description ?? check.name}>{check.name}</span>
                <span className={`shrink-0 ${checkStatusTone(check)}`}>{checkStatusLabel(check)}</span>
                {check.url ? (
                  <Button
                    variant="transparent"
                    size="small"
                    iconOnly
                    aria-label={`Open details for ${check.name}`}
                    onClick={() => openExternal(check.url!)}
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            ))}
            {remainingChecks > 0 ? (
              <p className="text-small text-tertiary">
                {remainingChecks === 1 ? "1 more check on GitHub." : `${remainingChecks} more checks on GitHub.`}
              </p>
            ) : null}
          </div>
        ) : null}
        {pausedLabel ? (
          <p className="mt-3 flex items-center gap-1.5 text-small text-secondary" role="status">
            <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
            {pausedLabel}. Showing the last status.
          </p>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2">
          {status.isFetching ? <span className="inline-flex items-center gap-1.5 text-small text-tertiary"><Loader2 className="size-3.5 animate-spin" />Refreshing…</span> : <span className="text-small text-tertiary">Refreshes every 30 seconds.</span>}
          <Button variant="muted" size="small" onClick={() => void status.refetch()} disabled={status.isFetching || pausedLabel !== undefined}>
            Refresh
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
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

export function ChatSidebar({ activeChatId, activeRemoteChat = null, titleReveal }: ChatSidebarProps) {
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
  const chatTitlesById = React.useMemo(
    () => new Map((chats.data ?? []).map((chat) => [chat.id, chat.title])),
    [chats.data],
  );
  const foundationModels = useFoundationModelsConnection(capabilities.appleFoundationModels);
  const [search, setSearch] = React.useState("");
  const initialPreferences = React.useMemo(
    () => parseSidebarPreferences(localStorage.getItem(SIDEBAR_PREFERENCES_KEY)),
    [],
  );
  const [view, setView] = React.useState<SidebarView>(initialPreferences.view);
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
  const shownMachines = effectiveMachineFilter(machineFilter, peerHosts.hosts);
  const initializedExpansionRef = React.useRef(false);
  const [renaming, setRenaming] = React.useState<ChatMeta | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renamingWithAppleId, setRenamingWithAppleId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<ChatMeta | null>(null);
  const [removingWorkspace, setRemovingWorkspace] = React.useState<Workspace | null>(null);
  const [removingWorkspaceBusy, setRemovingWorkspaceBusy] = React.useState(false);
  const [deletingWorktree, setDeletingWorktree] = React.useState<Workspace | null>(null);
  const [deletingWorktreeBusy, setDeletingWorktreeBusy] = React.useState(false);

  const searching = Boolean(search.trim());
  const busyChatId = environmentPanel.agentBusy ? activeChatId : undefined;
  const sidebarProjects = React.useMemo(() => localSidebarProjects(workspaces), [workspaces]);
  const sidebarChats = React.useMemo(
    () =>
      localSidebarChats(workspaces, chats.data ?? [], (chat) =>
        sidebarAttention(
          chatRowStateFor(chatActivity, chat.id, chat.id === busyChatId),
          // The open chat is being viewed, so its own output never reads as unread.
          chat.id !== activeChatId &&
            isChatUnread(chat.lastAssistantAt, readMarkers, chat.id, chat.lastAssistantSequence),
        ),
      ),
    [activeChatId, busyChatId, chatActivity, chats.data, readMarkers, workspaces],
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
  const chatViewTitle = view === "attention" ? "Needs attention" : "Recents";
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
  const { binding: commandBinding, register: registerCommand } = useCommandSystem();
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
      if (targetWorkspaceId && targetWorkspaceId !== activeId) {
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
  const reconnectHost = React.useCallback(async (hostId: string) => {
    try {
      await peerHostsApi.reconnect(hostId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not reconnect to that Mac.");
    }
  }, []);

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

  React.useEffect(() => {
    if (!workspaceRegistryReady) return;
    const preferences = parseSidebarPreferences(
      serializeSidebarPreferences({
        view,
        chatSort,
        projectSort,
        projectOrder,
        expandedWorkspaceIds: [...expandedWorkspaceIds],
        machineFilter,
        projectGrouping,
      }),
      workspaces.map((workspace) => workspace.id),
    );
    localStorage.setItem(SIDEBAR_PREFERENCES_KEY, serializeSidebarPreferences(preferences));
  }, [
    chatSort,
    expandedWorkspaceIds,
    machineFilter,
    projectGrouping,
    projectOrder,
    projectSort,
    view,
    workspaceRegistryReady,
    workspaces,
  ]);

  React.useEffect(() => {
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
  }, [chatNavigationTargets, openChat, registerCommand, shortcutAssignments]);

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
      try {
        if (workspaceId !== activeId && environmentPanel.agentBusy) {
          environmentPanel.cancelAgent?.();
        }
        const created = createChatDraft(workspaceId).chat;
        select(workspaceId);
        setExpandedWorkspaceIds((current) => new Set(current).add(workspaceId));
        try {
          await navigate({ to: "/chat/$chatId", params: { chatId: created.id } });
        } catch (error) {
          discardChatDraft(created.id);
          throw error;
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Aiden could not create a chat.");
      }
    },
    [
      activeId,
      appendReconciliationRequired,
      environmentPanel.agentBusy,
      environmentPanel.cancelAgent,
      navigate,
      qc,
      select,
      settingsBlockedReason,
    ],
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

  const renderChatRow = (chat: ChatMeta, indented = false) => {
    const shortcutNumber = shortcutNumberByChatId.get(chat.id);
    const shortcutBinding = shortcutNumber
      ? commandBinding(`chat.jump.${shortcutNumber}` as CommandId)
      : null;
    const rowState = chatRowStateFor(
      chatActivity,
      chat.id,
      chat.id === activeChatId && environmentPanel.agentBusy,
    );
    const showsState = rowState !== "idle";
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
    return (
      <ContextMenu key={chat.id}>
        <ContextMenuTrigger asChild>
          <SidebarListItem
            className={indented ? "pl-8" : undefined}
            icon={
              renamingWithAppleId === chat.id ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : undefined
            }
            aria-busy={renamingWithAppleId === chat.id || rowState === "working"}
            aria-description={forkedFrom}
            data-forked={forkedFrom ? "true" : undefined}
            title={
              forkedFrom ? (
                <span className="flex min-w-0 items-center gap-1.5" title={forkedFrom}>
                  <GitFork aria-hidden="true" className="size-3.5 shrink-0 text-tertiary" />
                  <span className="min-w-0 truncate">{titleContent}</span>
                </span>
              ) : (
                titleContent
              )
            }
            trailing={
              showsState || unread || (chatShortcutsVisible && shortcutBinding) ? (
                <span className="flex items-center gap-1">
                  {chatShortcutsVisible && shortcutBinding ? (
                    <kbd
                      aria-hidden="true"
                      data-chat-shortcut-hint="true"
                      className="inline-flex h-5 min-w-8 items-center justify-center rounded-pill bg-control px-1.5 font-sans text-mini font-medium tabular-nums text-tertiary"
                    >
                      {prettyAccelerator(shortcutBinding)}
                    </kbd>
                  ) : null}
                  <ChatRowStatus state={rowState} unread={unread} />
                </span>
              ) : undefined
            }
            aria-keyshortcuts={ariaKeyShortcut(shortcutBinding)}
            selected={chat.id === activeChatId}
            onPointerEnter={() => prefetchChat(chat.id)}
            onFocus={() => prefetchChat(chat.id)}
            onClick={() => void openChat(chat)}
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
      </ContextMenu>
    );
  };

  // Remote rows are read-only here: no rename, delete, or shortcut, and stale rows look muted.
  const renderRemoteChatRow = (chat: RemoteSidebarChat, indented = false) => (
    <SidebarListItem
      key={chat.key}
      className={indented ? "pl-8" : undefined}
      data-remote-chat={chat.stale ? "stale" : "live"}
      aria-busy={chat.rowState === "working"}
      title={chat.stale ? <span className="text-secondary">{chat.title}</span> : chat.title}
      trailing={
        <span className="flex items-center gap-1">
          <RemoteHostMarker hostLabel={chat.hostLabel} stale={chat.stale} />
          <ChatRowStatus state={chat.rowState} unread={chat.unread} />
        </span>
      }
      selected={
        activeRemoteChat?.hostId === chat.hostId && activeRemoteChat.chatId === chat.chatId
      }
      onClick={() => void openRemoteChat(chat)}
    />
  );

  const renderSidebarChat = (summary: SidebarRow, indented = false) =>
    isRemoteSidebarChat(summary)
      ? renderRemoteChatRow(summary, indented)
      : renderChatRow(summary.chat, indented);

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
      <div
        key={projectKey}
        className="group/workspace relative"
        data-remote-project={primary.stale ? "stale" : "live"}
        {...dropProps}
      >
        {dropIndicator}
        <div className="flex min-w-0 items-center gap-0.5" {...dragProps}>
          <SidebarListItem
            className="min-w-0 flex-1"
            icon={
              <span className="flex items-center gap-1.5">
                {expanded ? <ChevronDown /> : <ChevronRight />}
                {primary.repository ? <FolderGit2 /> : <Folder />}
              </span>
            }
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
            aria-label={`${expanded ? "Collapse" : "Expand"} ${accessibleName}`}
            aria-expanded={expanded}
            onClick={() => toggleRemoteProject(projectKey)}
          />
          <div className="group/workspace-actions relative size-7 shrink-0">
            <div className="absolute inset-0 flex items-center justify-center group-hover/workspace:invisible group-has-[.workspace-overflow-trigger:focus-visible]/workspace-actions:invisible group-has-[.workspace-overflow-trigger[data-state=open]]/workspace-actions:invisible">
              <RemoteHostMarker hostLabel={primary.hostLabel} stale={primary.stale} />
            </div>
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
        </div>
        {expanded ? (
          <div className="flex flex-col gap-0.5">
            {visibleChats.map((summary) => renderSidebarChat(summary, true))}
            {group.chats.length === 0 ? (
              <SidebarListItem className="pl-9 text-secondary" title="No chats yet" disabled />
            ) : null}
            {remainingChatCount > 0 ? (
              <SidebarListItem
                className="pl-9 text-secondary"
                title={`Show ${remainingChatCount} more`}
                onClick={() => setRevealedRemoteKeys((current) => new Set(current).add(projectKey))}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const machineFilterChip =
    hasHosts && shownMachines !== "all" ? (
      <MachineFilterChip
        label={machineFilterLabel(shownMachines, peerHosts.hosts)}
        onClear={() => setMachineFilter("all")}
      />
    ) : null;
  const groupHeading = (label: string) =>
    machineFilterChip ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">{label}</span>
        {machineFilterChip}
      </span>
    ) : (
      <span>{label}</span>
    );

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
          {capabilities.bots ? (
            <SidebarListItem
              icon={<BotSidebarIcon />}
              title="Bots"
              selected={pathname.startsWith("/bots")}
              onClick={() => navigate({ to: "/bots" })}
            />
          ) : null}
        </div>

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
                <div className="flex items-center justify-between gap-2">
                  {groupHeading("Workspaces")}
                  <span className="flex items-center gap-0.5">
                    {sidebarOrganizationMenu}
                    {workspaceCreationMenu}
                  </span>
                </div>
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
                  const secondaryLabel = workspaceSecondaryLabel(workspace, pathPreferences);
                  const explicitlyExpanded = expandedWorkspaceIds.has(workspace.id);
                  const expanded = searching || explicitlyExpanded;
                  return (
                    <div
                      key={projectKey}
                      className="group/workspace relative"
                      {...dropProps}
                    >
                      {dropIndicator}
                      <div className="flex min-w-0 items-center gap-0.5" {...dragProps}>
                        <SidebarListItem
                          className="min-w-0 flex-1"
                          icon={
                            <span className="flex items-center gap-1.5">
                              {expanded ? <ChevronDown /> : <ChevronRight />}
                              {workspace.folderPath ? <FolderGit2 /> : <Folder />}
                            </span>
                          }
                          title={
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{workspaceDisplayName(workspace, workspaces)}</span>
                              {workspace.folderPath && pathPreferences.showWorkspacePaths ? (
                                <span className="flex min-w-0 items-center gap-1 text-small text-tertiary">
                                  {workspace.managedWorktree?.branch ? <span className="max-w-[45%] truncate">{workspace.managedWorktree.branch} ·</span> : null}
                                  <WorkspacePathLabel path={workspace.folderPath} format={pathPreferences.workspacePathFormat} />
                                </span>
                              ) : secondaryLabel ? <span className="truncate text-small text-tertiary">{secondaryLabel}</span> : null}
                              <MachineBadges labels={projectEntryMachineLabels(group.project)} />
                            </span>
                          }
                          aria-label={`${expanded ? "Collapse" : "Expand"} ${workspaceAccessibleName(workspace, pathPreferences, workspaces)}`}
                          aria-expanded={expanded}
                          onClick={() => toggleWorkspace(workspace.id)}
                        />
                        <div className="group/workspace-actions relative size-7 shrink-0">
                          <div className="absolute inset-0 group-hover/workspace:invisible group-has-[.workspace-overflow-trigger:focus-visible]/workspace-actions:invisible group-has-[.workspace-overflow-trigger[data-state=open]]/workspace-actions:invisible">
                            <WorkspacePullRequestIndicator
                              workspace={workspace}
                              visible={explicitlyExpanded}
                              accessibilityName={workspaceAccessibleName(
                                workspace,
                                pathPreferences,
                                workspaces,
                              )}
                            />
                          </div>
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
                            {workspace.folderPath ? (
                              <DropdownMenuItem
                                onSelect={() => void revealWorkspace(workspace)}
                              >
                                Show in file manager
                              </DropdownMenuItem>
                            ) : null}
                            {moveItems}
                            {workspaces.length > 1 ? <DropdownMenuSeparator /> : null}
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
                            {workspaces.length > 1 && !workspace.managedWorktree ? (
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
                      </div>
                      {expanded ? (
                        <div className="flex flex-col gap-0.5">
                          {visibleChats.map((summary) => renderSidebarChat(summary, true))}
                          {group.chats.length === 0 ? (
                            <SidebarListItem
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
                              className="pl-9 text-secondary"
                              title={`Show ${remainingChatCount} more`}
                              onClick={() =>
                                setFullyRevealedWorkspaceIds((current) =>
                                  new Set(current).add(workspace.id),
                                )
                              }
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </SidebarListGroup>
          ) : chats.isLoading ? (
            <SidebarListGroup
              title={
                <div className="flex items-center justify-between gap-2">
                  {groupHeading(chatViewTitle)}
                  {sidebarOrganizationMenu}
                </div>
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
                <div className="flex items-center justify-between gap-2">
                  {groupHeading(chatViewTitle)}
                  {sidebarOrganizationMenu}
                </div>
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
          ) : organized.chatSections.length === 0 ? (
            <SidebarListGroup
              title={
                <div className="flex items-center justify-between gap-2">
                  {groupHeading(chatViewTitle)}
                  {sidebarOrganizationMenu}
                </div>
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
                    <div className="flex items-center justify-between gap-2">
                      {groupHeading(group.label)}
                      {sidebarOrganizationMenu}
                    </div>
                  ) : (
                    group.label
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
