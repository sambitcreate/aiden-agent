import * as React from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Binary,
  Check,
  ChevronRight,
  GitCompareArrows,
  GitBranch,
  GitCommitHorizontal,
  Monitor,
  UploadCloud,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Text,
} from "./ui";
import { GitBranchPicker } from "./git-branch-picker";
import { GitCommitDialog } from "./git-commit-dialog";
import { GitPushDialog } from "./git-push-dialog";
import { useGitInfo, useGitPushCapability, useGitReview } from "../lib/queries";
import { cn } from "../lib/ui-utils";
import type { GitPushCapability, GitReview, GitReviewSummary, Workspace } from "../lib/types";

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
}: {
  workspace: Workspace;
  /** Accepted for parity with ChangesRows; Git info polls on its own schedule. */
  active: boolean;
  mutationBlockedReason: string | null;
  onGitOperationBusyChange: (busy: boolean) => void;
  onCreateWorktree?: (branchName: string) => Promise<void>;
  /** Wired to the Folder row in Task 4. */
  onBrowseFiles: () => void;
}) {
  const git = useGitInfo(workspace.id);
  const branchLabel = git.data?.detached ? "Detached HEAD" : git.data?.branch;
  const localDetail = workspace.managedWorktree ? "Isolated worktree" : "Runs on this device";
  const accessLabel = workspace.permission === "full" ? "Full access" : "Ask first";

  return (
    <div className="flex flex-col">
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

export function ChangesRows({
  workspace,
  chatId,
  active,
  mutationBlockedReason,
  onGitOperationBusyChange,
  onOpenReview,
}: {
  workspace: Workspace;
  /** Chat presented for this workspace; binds post-push PR detection/linking. */
  chatId?: string;
  active: boolean;
  mutationBlockedReason: string | null;
  onGitOperationBusyChange: (busy: boolean) => void;
  onOpenReview: (mode: "changes" | "compare") => void;
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
            aria-label="Compare branch using local and last-fetched references"
            className={ROW}
          >
            <GitCompareArrows className="size-4.5 text-secondary" aria-hidden="true" />
            <span className="min-w-0 truncate">Compare branch</span>
            <ArrowUpRight className="size-3.5 text-tertiary" aria-hidden="true" />
          </button>
        ) : null}
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
