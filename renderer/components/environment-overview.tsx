import * as React from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Binary,
  Check,
  ChevronRight,
  Folder,
  GitCompareArrows,
  GitBranch,
  GitCommitHorizontal,
  Monitor,
  SquareArrowOutUpRight,
  UploadCloud,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Text,
  toast,
} from "./ui";
import {
  ChatPullRequestStateIcon,
  chatPullRequestStateLabel,
} from "./chat-pull-requests";
import { useLinkOpener } from "../lib/link-opener";
import { GitBranchPicker } from "./git-branch-picker";
import { GitCommitDialog } from "./git-commit-dialog";
import { GitPushDialog } from "./git-push-dialog";
import { usePreferredEditor } from "./open-in-editor-picker";
import { workspacesApi } from "../lib/ipc";
import { useChatCurrentPullRequest, useGitInfo, useGitPushCapability, useGitReview } from "../lib/queries";
import { truncatePathMiddle } from "../lib/truncate-path";
import { cn } from "../lib/ui-utils";
import type { GitPushCapability, GitReview, GitReviewSummary, Workspace } from "../lib/types";
import type { ChatPullRequestView } from "../shared/chat-pull-requests";

/** Shared Quick View row: Aiden list-row density (see SidebarListItem). */
const ROW =
  "grid min-h-9 w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-control px-2.5 text-left text-regular text-primary outline-none transition-colors duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45";

const numberFormatter = new Intl.NumberFormat();

function ChangesMeta({ summary }: { summary: GitReviewSummary }) {
  if (summary.fileCount === 0) {
    return (
      <span className="flex items-center gap-1.5 text-small text-support-green">
        <Check className="size-3.5" aria-hidden="true" />
        Clean
      </span>
    );
  }
  const partial = summary.unavailableStats > 0;
  const detail = partial
    ? `Known line totals exclude ${summary.unavailableStats} ${summary.unavailableStats === 1 ? "file" : "files"}.`
    : undefined;
  return (
    <span
      className="flex items-center gap-2 font-mono text-small tabular-nums"
      title={detail}
      aria-label={`${numberFormatter.format(summary.additions)} known additions, ${numberFormatter.format(summary.deletions)} known deletions${partial ? `. Line totals exclude ${summary.unavailableStats} ${summary.unavailableStats === 1 ? "file" : "files"}` : ""}`}
    >
      {partial ? <Binary className="size-3.5 text-tertiary" aria-hidden="true" /> : null}
      <span className="text-support-green">+{numberFormatter.format(summary.additions)}</span>
      <span className="text-support-red">−{numberFormatter.format(summary.deletions)}</span>
    </span>
  );
}


const IS_MAC = typeof navigator !== "undefined" && /Mac/u.test(navigator.userAgent);

/** Character budget for the Folder row's parent path; the row truncates visually as well. */
const PARENT_PATH_LENGTH = 32;

/** Display only: the folder's parent with a macOS or Linux home folder shortened to `~`. */
function parentFolderLabel(folderPath: string): string {
  const trimmed = folderPath.replace(/[\\/]+$/u, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = cut > 0 ? trimmed.slice(0, cut) : cut === 0 ? "/" : trimmed;
  const home = parent.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u, "~");
  return truncatePathMiddle(home, PARENT_PATH_LENGTH);
}

/**
 * Reveals the workspace folder in the system file manager (Finder on macOS, Files elsewhere).
 * Failures surface as a toast; `show` never throws.
 */
export function useShowWorkspaceFolder(workspace: Workspace): { label: string; show: () => void } {
  const workspaceId = workspace.id;
  const show = React.useCallback(() => {
    void workspacesApi.openFolder(workspaceId).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Couldn't open this folder.");
    });
  }, [workspaceId]);
  return { label: `Show ${workspace.name} in ${IS_MAC ? "Finder" : "Files"}`, show };
}

function FolderRow({
  workspace,
  onBrowseFiles,
  browseDisabled,
}: {
  workspace: Workspace;
  onBrowseFiles: () => void;
  browseDisabled: boolean;
}) {
  const { preferredEditor, openPreferredEditor } = usePreferredEditor(workspace.id, workspace.folderPath, {
    silentDiscoveryErrors: true,
  });
  if (!workspace.folderPath) return null;
  const disabled = workspace.permission === "none";
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onBrowseFiles}
        disabled={disabled || browseDisabled}
        aria-label={`Browse files in ${workspace.name}`}
        title={workspace.folderPath}
        className={cn(ROW, "min-w-0 flex-1")}
      >
        <Folder className="size-4.5 text-secondary" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {workspace.name}
          <span className="text-tertiary"> · {parentFolderLabel(workspace.folderPath)}</span>
        </span>
      </button>
      {preferredEditor ? (
        <Button
          variant="transparent"
          size="small"
          iconOnly
          disabled={disabled}
          onClick={() => void openPreferredEditor()}
          aria-label={`Open in ${preferredEditor.label}`}
          title={`Open in ${preferredEditor.label}`}
          className="shrink-0 [&_svg]:size-3.5"
        >
          <SquareArrowOutUpRight aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

function workspaceAvailable(workspace: Workspace | undefined): workspace is Workspace {
  return Boolean(workspace?.folderPath) && workspace?.permission !== "none";
}

function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/** Spoken summary of the working tree, shared by the Changes row and its collapsed header. */
function changesSummaryLabel(summary: GitReviewSummary): string {
  if (summary.fileCount === 0) return "working tree is clean";
  const excluded = summary.unavailableStats > 0
    ? `, line totals exclude ${fileCountLabel(summary.unavailableStats)}`
    : "";
  return `${fileCountLabel(summary.fileCount)}, ${summary.additions} known additions, ${summary.deletions} known deletions${excluded}`;
}

function RowSkeleton() {
  return (
    <div
      className="grid min-h-9 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5"
      role="status"
      aria-busy="true"
      aria-label="Branch, loading repository status"
    >
      <span className="size-4 animate-pulse rounded bg-control" aria-hidden="true" />
      <span className="h-2.5 w-24 animate-pulse rounded-pill bg-control" aria-hidden="true" />
      <span className="h-2.5 w-20 animate-pulse rounded-pill bg-control" aria-hidden="true" />
    </div>
  );
}

/** Shown in place of Quick View's sections when the workspace has no readable folder. */
export function QuickViewUnavailable({ workspace }: { workspace: Workspace | undefined }) {
  if (!workspace?.folderPath) {
    return (
      <EmptyState
        placement="inline"
        className="min-h-48"
        title="No workspace folder"
        description="Choose a local workspace to see its environment, changes, and branch."
      />
    );
  }
  if (workspace.permission === "none") {
    return (
      <EmptyState
        placement="inline"
        className="min-h-48"
        title="File access is off"
        description="Change this workspace from No Access to inspect its local environment."
      />
    );
  }
  return null;
}

/** Collapsed Changes header: line totals or Clean, or null until a repository's review loads. */
export function useChangesSummary(
  workspaceId: string | undefined,
  active: boolean,
): { node: React.ReactNode; label: string } | null {
  const review = useGitReview(workspaceId, active);
  if (!review.data?.isRepo) return null;
  return {
    node: <ChangesMeta summary={review.data.summary} />,
    label: changesSummaryLabel(review.data.summary),
  };
}

/**
 * Whether Quick View shows the Changes card: a Git repository with working changes, commits
 * ahead of the last-fetched upstream, or a pull request for this chat. Reads the same queries
 * as ChangesRows, so it adds no polling of its own. Pass `active` false for a closed Quick View
 * or a workspace without file access; disabled queries send nothing.
 */
export function useChangesVisibility(
  workspaceId: string | undefined,
  chatId: string | undefined,
  active: boolean,
): boolean {
  const review = useGitReview(workspaceId, active);
  const push = useGitPushCapability(workspaceId, active);
  const currentPullRequest = useChatCurrentPullRequest(chatId, active);
  if (!review.data?.isRepo) return false;
  const pullRequest = chatId ? currentPullRequest.data?.pullRequest ?? null : null;
  return review.data.summary.fileCount > 0 || (push.data?.ahead ?? 0) > 0 || pullRequest !== null;
}

/** Collapsed Environment header: the current branch, or Local outside Git. */
export function useEnvironmentSummary(
  workspace: Workspace | undefined,
): { node: React.ReactNode; label: string } | null {
  const available = workspaceAvailable(workspace);
  const git = useGitInfo(available ? workspace.id : undefined);
  if (!available || !git.data) return null;
  const label = git.data.isRepo
    ? git.data.detached
      ? "Detached HEAD"
      : git.data.branch ?? "Local"
    : "Local";
  return {
    node: <span className="min-w-0 truncate text-small text-tertiary">{label}</span>,
    label,
  };
}

export function EnvironmentRows({
  workspace,
  mutationBlockedReason,
  onGitOperationBusyChange,
  onCreateWorktree,
  onBrowseFiles,
  toolsDisabled = false,
}: {
  workspace: Workspace;
  /** Accepted for parity with ChangesRows; Git info polls on its own schedule. */
  active: boolean;
  mutationBlockedReason: string | null;
  onGitOperationBusyChange: (busy: boolean) => void;
  onCreateWorktree?: (branchName: string) => Promise<void>;
  /** Opens the Files tool on this workspace (Folder row). */
  onBrowseFiles: () => void;
  /** Disables the row that opens a tool, e.g. while a Git operation is in flight. */
  toolsDisabled?: boolean;
}) {
  const git = useGitInfo(workspace.id);
  const branchLabel = git.data?.detached ? "Detached HEAD" : git.data?.branch;
  const localDetail = workspace.managedWorktree ? "Isolated worktree" : "Runs on this device";
  const accessLabel = workspace.permission === "full" ? "Full access" : "Ask first";

  return (
    <div className="flex flex-col">
      {workspace.folderPath ? <FolderRow workspace={workspace} onBrowseFiles={onBrowseFiles} browseDisabled={toolsDisabled} /> : null}

      <div
        className="grid min-h-9 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5"
        title={`${workspace.name} · ${localDetail} · ${accessLabel}`}
      >
        <Monitor className="size-4.5 text-secondary" aria-hidden="true" />
        <span className="min-w-0 truncate text-regular text-primary">Local</span>
        <span className="max-w-52 truncate text-small text-tertiary">{localDetail}</span>
      </div>

      {git.isLoading && !git.data ? (
        <RowSkeleton />
      ) : git.data?.isRepo && branchLabel ? (
        <GitBranchPicker
          workspaceId={workspace.id}
          branch={branchLabel}
          disabled={Boolean(mutationBlockedReason)}
          disabledReason={mutationBlockedReason ?? undefined}
          triggerVariant="overview"
          detached={git.data.detached}
          unborn={git.data.unborn}
          onCreateWorktree={onCreateWorktree}
          onBusyChange={onGitOperationBusyChange}
          worktreeDescription="Creates a separate workspace and keeps this checkout unchanged."
        />
      ) : (
        <div
          className={cn(
            "grid min-h-9 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5",
            git.error && "text-support-red",
          )}
        >
          <GitBranch className="size-4.5 text-secondary" aria-hidden="true" />
          <span className="min-w-0 truncate text-regular text-primary">Branch</span>
          <span className="max-w-52 truncate text-small text-tertiary">
            {git.error ? "Unavailable" : "Not a Git repository"}
          </span>
        </div>
      )}
    </div>
  );
}

/** The chat's pull request, shown only once one exists; opens it on GitHub. */
function PullRequestRow({ view }: { view: ChatPullRequestView }) {
  const { openLink } = useLinkOpener();
  const state = chatPullRequestStateLabel(view);
  return (
    <button
      type="button"
      onClick={() => openLink(view.url)}
      aria-label={`Pull request #${view.number}, ${state}. Opens on GitHub`}
      className={ROW}
    >
      <span className="flex size-4.5 items-center justify-center" aria-hidden="true">
        <ChatPullRequestStateIcon view={view} />
      </span>
      <span className="min-w-0 truncate">
        #{view.number} {view.title || view.headBranch}
      </span>
      <span className="text-small text-tertiary">{state}</span>
    </button>
  );
}

export function ChangesRows({
  workspace,
  chatId,
  active,
  mutationBlockedReason,
  onGitOperationBusyChange,
  onOpenReview,
  toolsDisabled = false,
  onDialogOpenChange,
}: {
  workspace: Workspace;
  /** Chat presented for this workspace; binds post-push PR detection/linking. */
  chatId?: string;
  active: boolean;
  mutationBlockedReason: string | null;
  onGitOperationBusyChange: (busy: boolean) => void;
  onOpenReview: (mode: "changes" | "compare") => void;
  /** Disables the rows that open the Changes tool, e.g. while a Git operation is in flight. */
  toolsDisabled?: boolean;
  /** Reports whether the commit or push dialog is open, so the owner can keep these rows mounted. */
  onDialogOpenChange?: (open: boolean) => void;
}) {
  const [commitOpen, setCommitOpen] = React.useState(false);
  const [commitReview, setCommitReview] = React.useState<GitReview | null>(null);
  const [pushOpen, setPushOpen] = React.useState(false);
  const [pushCapability, setPushCapability] = React.useState<GitPushCapability | null>(null);
  const changesButtonRef = React.useRef<HTMLButtonElement>(null);
  const gitActionButtonRef = React.useRef<HTMLButtonElement>(null);
  const available = workspaceAvailable(workspace);
  const review = useGitReview(workspace.id, active && available);
  const push = useGitPushCapability(workspace.id, active && available);
  const git = useGitInfo(workspace.id);
  const currentPullRequest = useChatCurrentPullRequest(chatId, active);
  const pullRequest = chatId ? currentPullRequest.data?.pullRequest ?? null : null;
  const branchLabel = git.data?.detached
    ? "Detached HEAD"
    : git.data?.branch ?? review.data?.branch;
  const reviewError = review.error instanceof Error ? review.error.message : null;
  const pushError = push.error instanceof Error
    ? push.error.message
    : push.error
      ? "Aiden could not load the push state."
      : null;
  const isRepo = Boolean(review.data?.isRepo || git.data?.isRepo);
  const dialogOpen = commitOpen || pushOpen;
  React.useEffect(() => {
    onDialogOpenChange?.(dialogOpen);
  }, [dialogOpen, onDialogOpenChange]);
  React.useEffect(() => () => onDialogOpenChange?.(false), [onDialogOpenChange]);
  const knownNotRepo = !isRepo && (review.data?.isRepo === false || git.data?.isRepo === false);

  if (!available || knownNotRepo) return null;

  const changesLabel = review.isLoading && !review.data
    ? "Changes, loading working tree status"
    : reviewError && !review.data
      ? `Changes unavailable, ${reviewError}`
      : review.data?.isRepo
        ? `Changes, ${changesSummaryLabel(review.data.summary)}`
        : "Changes, loading working tree status";
  const fileCount = review.data?.summary.fileCount ?? 0;
  const ahead = push.data?.ahead ?? 0;
  const returnFocus = () => {
    const trigger = gitActionButtonRef.current;
    return trigger?.isConnected && !trigger.disabled ? trigger : changesButtonRef.current;
  };

  return (
    <>
      <div className="flex flex-col">
        <button
          ref={changesButtonRef}
          type="button"
          onClick={() => onOpenReview("changes")}
          disabled={toolsDisabled}
          aria-label={changesLabel}
          aria-busy={review.isFetching}
          className={ROW}
        >
          <GitCompareArrows className="size-4.5 text-secondary" aria-hidden="true" />
          <span className="min-w-0 truncate">Changes</span>
          {reviewError && !review.data ? (
            <span className="flex items-center gap-1.5 text-small text-support-red" title={reviewError}>
              <AlertCircle className="size-3.5" aria-hidden="true" />
              Unavailable
            </span>
          ) : review.data?.isRepo ? (
            <ChangesMeta summary={review.data.summary} />
          ) : (
            <span className="h-2.5 w-20 animate-pulse rounded-pill bg-control" aria-label="Loading changes" />
          )}
        </button>

        {isRepo ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                ref={gitActionButtonRef}
                type="button"
                disabled={Boolean(mutationBlockedReason)}
                aria-label={`Commit or push${fileCount ? `, ${fileCount} changed ${fileCount === 1 ? "file" : "files"}` : ""}${ahead ? `, ${ahead} commits ahead of the last-fetched upstream` : ""}`}
                title={mutationBlockedReason ?? "Commit local changes or push the current branch"}
                className={ROW}
              >
                <GitCommitHorizontal className="size-4.5 text-secondary" aria-hidden="true" />
                <span className="min-w-0 truncate">Commit or push</span>
                <span className="flex max-w-52 items-center gap-1.5 truncate text-small text-tertiary">
                  {fileCount ? fileCountLabel(fileCount) : null}
                  {fileCount && ahead ? <span aria-hidden="true">·</span> : null}
                  {ahead ? `↑${ahead}` : null}
                  {!fileCount && !ahead ? <ChevronRight className="size-3.5" aria-hidden="true" /> : null}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem
                disabled={!review.data}
                onSelect={() => {
                  setCommitReview(review.data ?? null);
                  setCommitOpen(true);
                }}
                className="items-start py-2"
              >
                <GitCommitHorizontal className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block">Commit changes</span>
                  <span className="mt-0.5 block text-small text-tertiary">
                    {review.data?.commit.allowed
                      ? `${review.data.summary.fileCount} reviewed ${review.data.summary.fileCount === 1 ? "file" : "files"}`
                      : review.data?.commit.reason
                        ?? (reviewError ? "Review unavailable · open Changes to retry" : "Loading Review…")}
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!push.data && !pushError}
                onSelect={() => {
                  if (push.data) {
                    setPushCapability(push.data);
                    setPushOpen(true);
                  } else {
                    void push.refetch();
                  }
                }}
                title={pushError ?? undefined}
                className="items-start py-2"
              >
                <UploadCloud className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block">Push branch</span>
                  <span className="mt-0.5 block text-small text-tertiary">
                    {pushError && !push.data
                      ? "Push state unavailable · select to retry"
                      : pushError
                        ? "Last push snapshot · refresh failed"
                        : push.data?.allowed
                          ? `${push.data.suggestedRemote ?? "remote"}/${push.data.destinationBranch ?? push.data.branch}`
                          : push.data?.reason ?? (push.isLoading ? "Loading push state…" : "Push unavailable")}
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {isRepo ? (
          <button
            type="button"
            onClick={() => onOpenReview("compare")}
            disabled={toolsDisabled}
            aria-label="Compare branch using local and last-fetched references"
            className={ROW}
          >
            <GitCompareArrows className="size-4.5 text-secondary" aria-hidden="true" />
            <span className="min-w-0 truncate">Compare branch</span>
            <ArrowUpRight className="size-3.5 text-tertiary" aria-hidden="true" />
          </button>
        ) : null}

        {pullRequest ? <PullRequestRow view={pullRequest} /> : null}
      </div>

      {mutationBlockedReason ? (
        <Text as="p" variant="small" color="tertiary" className="mt-2 px-2.5" role="status">
          {mutationBlockedReason}
        </Text>
      ) : review.data?.isRepo && review.data.summary.fileCount > 0 && !review.data.commit.allowed ? (
        <Text as="p" variant="small" className="mt-2 px-2.5 text-support-warning" role="status">
          {review.data.commit.reason ?? "Refresh Review before committing these changes."}
        </Text>
      ) : reviewError && review.data ? (
        <Text as="p" variant="small" className="mt-2 px-2.5 text-support-warning" role="status">
          Refresh failed. Showing the last changes snapshot.
        </Text>
      ) : pushError ? (
        <Text as="p" variant="small" className="mt-2 px-2.5 text-support-warning" role="status">
          {push.data ? "Push refresh failed. The last local snapshot is shown." : `Push state unavailable: ${pushError}`}
        </Text>
      ) : null}

      <GitCommitDialog
        workspaceId={workspace.id}
        branch={commitReview?.branch ?? branchLabel ?? "current branch"}
        review={commitReview}
        blockedReason={mutationBlockedReason}
        open={commitOpen}
        onOpenChange={setCommitOpen}
        onBusyChange={onGitOperationBusyChange}
        onReviewChange={setCommitReview}
        returnFocus={returnFocus}
      />
      <GitPushDialog
        workspaceId={workspace.id}
        chatId={chatId}
        capability={pushCapability}
        blockedReason={mutationBlockedReason}
        open={pushOpen}
        onOpenChange={setPushOpen}
        onBusyChange={onGitOperationBusyChange}
        onCapabilityChange={setPushCapability}
        returnFocus={returnFocus}
      />
    </>
  );
}
