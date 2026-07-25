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

function RowSkeleton() {
  return (
    <div
      className="grid min-h-11 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-2"
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

export function EnvironmentOverview({
  workspace,
  active,
  presentation = "panel",
  mutationBlockedReason,
  onGitOperationBusyChange,
  onOpenReview,
  onCreateWorktree,
}: {
  workspace: Workspace | undefined;
  active: boolean;
  presentation?: "panel" | "card";
  mutationBlockedReason: string | null;
  onGitOperationBusyChange: (busy: boolean) => void;
  onOpenReview: (mode: "changes" | "compare") => void;
  onCreateWorktree?: (branchName: string) => Promise<void>;
}) {
  const [commitOpen, setCommitOpen] = React.useState(false);
  const [commitReview, setCommitReview] = React.useState<GitReview | null>(null);
  const [pushOpen, setPushOpen] = React.useState(false);
  const [pushCapability, setPushCapability] = React.useState<GitPushCapability | null>(null);
  const changesButtonRef = React.useRef<HTMLButtonElement>(null);
  const gitActionButtonRef = React.useRef<HTMLButtonElement>(null);
  const available = Boolean(workspace?.folderPath) && workspace?.permission !== "none";
  const review = useGitReview(workspace?.id, active && available);
  const push = useGitPushCapability(workspace?.id, active && available);
  const git = useGitInfo(workspace?.id);
  const branchLabel = git.data?.detached
    ? "Detached HEAD"
    : git.data?.branch ?? review.data?.branch;
  const reviewError = review.error instanceof Error ? review.error.message : null;
  const pushError = push.error instanceof Error
    ? push.error.message
    : push.error
      ? "Aiden could not load the push state."
      : null;
  const compact = presentation === "card";

  if (!workspace?.folderPath) {
    return (
      <EmptyState
        placement={compact ? "inline" : undefined}
        className={compact ? "min-h-48" : "h-full"}
        title="No workspace folder"
        description="Choose a local workspace to see its environment, changes, and branch."
      />
    );
  }
  if (workspace.permission === "none") {
    return (
      <EmptyState
        placement={compact ? "inline" : undefined}
        className={compact ? "min-h-48" : "h-full"}
        title="File access is off"
        description="Change this workspace from No Access to inspect its local environment."
      />
    );
  }

  const localDetail = workspace.managedWorktree ? "Isolated worktree" : "Runs on this Mac";
  const accessLabel = workspace.permission === "full" ? "Full access" : "Ask first";
  const changesLabel = review.isLoading && !review.data
    ? "Changes, loading working tree status"
    : reviewError && !review.data
      ? `Changes unavailable, ${reviewError}`
      : review.data?.isRepo
        ? review.data.summary.fileCount === 0
          ? "Changes, working tree is clean"
          : `Changes, ${review.data.summary.fileCount} ${review.data.summary.fileCount === 1 ? "file" : "files"}, ${review.data.summary.additions} known additions, ${review.data.summary.deletions} known deletions${review.data.summary.unavailableStats > 0 ? `, line totals exclude ${review.data.summary.unavailableStats} ${review.data.summary.unavailableStats === 1 ? "file" : "files"}` : ""}`
        : "Changes, not a Git repository";

  return (
    <>
      <div className={cn("h-full overflow-y-auto", compact ? "px-3 pb-3" : "px-4 py-5")}>
      <section aria-label="Environment overview" className={cn("mx-auto w-full", !compact && "max-w-lg")}>
        {!compact ? (
          <div className="mb-3 px-2">
            <Text as="h2" variant="strong" truncate title={workspace.folderPath}>
              {workspace.name}
            </Text>
            <Text as="p" variant="small" color="tertiary" className="mt-0.5">
              {accessLabel}
            </Text>
          </div>
        ) : null}

        <div className="flex flex-col">
          <button
            ref={changesButtonRef}
            type="button"
            onClick={() => onOpenReview("changes")}
            aria-label={changesLabel}
            aria-busy={review.isFetching}
            className="grid min-h-11 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 rounded-control px-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none"
          >
            <GitCompareArrows className="size-4.5 text-secondary" aria-hidden="true" />
            <span className="min-w-0 truncate text-regular text-primary">Changes</span>
            {review.isLoading && !review.data ? (
              <span className="h-2.5 w-20 animate-pulse rounded-pill bg-control" aria-label="Loading changes" />
            ) : reviewError && !review.data ? (
              <span className="flex items-center gap-1.5 text-small text-support-red" title={reviewError}>
                <AlertCircle className="size-3.5" aria-hidden="true" />
                Unavailable
              </span>
            ) : review.data?.isRepo ? (
              <ChangesMeta summary={review.data.summary} />
            ) : (
              <span className="text-small text-tertiary">Not a Git repository</span>
            )}
          </button>

          <div
            className="grid min-h-11 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-2"
            title={`${workspace.name} · ${localDetail} · ${accessLabel}`}
          >
            <Monitor className="size-4.5 text-secondary" aria-hidden="true" />
            <span className="min-w-0 truncate text-regular text-primary">Local</span>
            <span className="max-w-52 truncate text-small text-tertiary">{localDetail}</span>
          </div>

          {git.isLoading && !git.data ? (
            <RowSkeleton />
          ) : git.data?.isRepo && branchLabel ? (
            <div>
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
            </div>
          ) : (
            <div
              className={cn(
                "grid min-h-11 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-2",
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

          {review.data?.isRepo || git.data?.isRepo ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  ref={gitActionButtonRef}
                  type="button"
                  disabled={Boolean(mutationBlockedReason)}
                  aria-label={`Commit or push${review.data?.summary.fileCount ? `, ${review.data.summary.fileCount} changed ${review.data.summary.fileCount === 1 ? "file" : "files"}` : ""}${push.data?.ahead ? `, ${push.data.ahead} commits ahead of the last-fetched upstream` : ""}`}
                  title={mutationBlockedReason ?? "Commit local changes or push the current branch"}
                  className="grid min-h-11 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 rounded-control px-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
                >
                  <GitCommitHorizontal className="size-4.5 text-secondary" aria-hidden="true" />
                  <span className="min-w-0 truncate text-regular text-primary">Commit or push</span>
                  <span className="flex max-w-52 items-center gap-1.5 truncate text-small text-tertiary">
                    {review.data?.summary.fileCount
                      ? `${review.data.summary.fileCount} ${review.data.summary.fileCount === 1 ? "file" : "files"}`
                      : null}
                    {review.data?.summary.fileCount && push.data?.ahead ? <span aria-hidden="true">·</span> : null}
                    {push.data?.ahead ? `↑${push.data.ahead}` : null}
                    {!review.data?.summary.fileCount && !push.data?.ahead ? <ChevronRight className="size-3.5" aria-hidden="true" /> : null}
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

          {review.data?.isRepo || git.data?.isRepo ? (
            <button
              type="button"
              onClick={() => onOpenReview("compare")}
              aria-label="Compare branch using local and last-fetched references"
              className="grid min-h-11 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 rounded-control px-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none"
            >
              <GitCompareArrows className="size-4.5 text-secondary" aria-hidden="true" />
              <span className="min-w-0 truncate text-regular text-primary">Compare branch</span>
              <ArrowUpRight className="size-3.5 text-tertiary" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {mutationBlockedReason ? (
          <Text as="p" variant="small" color="tertiary" className="mt-3 px-2" role="status">
            {mutationBlockedReason}
          </Text>
        ) : review.data?.isRepo && review.data.summary.fileCount > 0 && !review.data.commit.allowed ? (
          <Text as="p" variant="small" className="mt-3 px-2 text-support-warning" role="status">
            {review.data.commit.reason ?? "Refresh Review before committing these changes."}
          </Text>
        ) : reviewError && review.data ? (
          <Text as="p" variant="small" className="mt-3 px-2 text-support-warning" role="status">
            Refresh failed. Showing the last changes snapshot.
          </Text>
        ) : pushError ? (
          <Text as="p" variant="small" className="mt-3 px-2 text-support-warning" role="status">
            {push.data ? "Push refresh failed. The last local snapshot is shown." : `Push state unavailable: ${pushError}`}
          </Text>
        ) : null}
        </section>
      </div>
      <GitCommitDialog
        workspaceId={workspace.id}
        branch={commitReview?.branch ?? branchLabel ?? "current branch"}
        review={commitReview}
        blockedReason={mutationBlockedReason}
        open={commitOpen}
        onOpenChange={setCommitOpen}
        onBusyChange={onGitOperationBusyChange}
        onReviewChange={setCommitReview}
        returnFocus={() => {
          const trigger = gitActionButtonRef.current;
          return trigger?.isConnected && !trigger.disabled ? trigger : changesButtonRef.current;
        }}
      />
      <GitPushDialog
        workspaceId={workspace.id}
        capability={pushCapability}
        blockedReason={mutationBlockedReason}
        open={pushOpen}
        onOpenChange={setPushOpen}
        onBusyChange={onGitOperationBusyChange}
        onCapabilityChange={setPushCapability}
        returnFocus={() => {
          const trigger = gitActionButtonRef.current;
          return trigger?.isConnected && !trigger.disabled ? trigger : changesButtonRef.current;
        }}
      />
    </>
  );
}
