import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RefreshCw } from "lucide-react";
import { gitApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import type { GitCommitMode, GitReview } from "../lib/types";
import {
  Dialog,
  Button,
  Label,
  RadioGroup,
  RadioGroupItem,
  Textarea,
  toast,
} from "./ui";
import { cn } from "../lib/ui-utils";

function selectionDescription(review: GitReview, mode: GitCommitMode): string {
  if (mode === "staged") {
    return `${review.summary.stagedFiles} staged ${review.summary.stagedFiles === 1 ? "file" : "files"}; unstaged portions stay in the working tree.`;
  }
  return `${review.summary.fileCount} changed ${review.summary.fileCount === 1 ? "file" : "files"}, including untracked files.`;
}

export function GitCommitDialog({
  workspaceId,
  branch,
  review,
  blockedReason,
  open,
  onOpenChange,
  onBusyChange,
  onReviewChange,
  returnFocus,
}: {
  workspaceId: string;
  branch: string;
  review: GitReview | null;
  blockedReason: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onReviewChange: (review: GitReview) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = React.useState("");
  const [mode, setMode] = React.useState<GitCommitMode>("all");
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [needsRefresh, setNeedsRefresh] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const originWorkspaceRef = React.useRef<string | null>(null);
  const messageRef = React.useRef<HTMLTextAreaElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const invalidateGitState = React.useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.gitReview(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.git(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.gitBranches(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.gitPushCapability(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.gitComparisons(workspaceId) }),
      ]),
    [queryClient, workspaceId],
  );

  React.useEffect(() => {
    if (!open) {
      originWorkspaceRef.current = null;
      return;
    }
    if (originWorkspaceRef.current === null) {
      originWorkspaceRef.current = workspaceId;
      setMessage("");
      setMode(review && review.summary.stagedFiles > 0 ? "staged" : "all");
      setBusy(false);
      setRefreshing(false);
      setNeedsRefresh(false);
      setError(null);
      return;
    }
    if (originWorkspaceRef.current !== workspaceId && !busy) onOpenChange(false);
  }, [busy, onOpenChange, open, review, workspaceId]);

  const refreshReview = async () => {
    if (busy || refreshing) return;
    setRefreshing(true);
    try {
      const latest = await gitApi.review(workspaceId);
      queryClient.setQueryData(queryKeys.gitReview(workspaceId), latest);
      onReviewChange(latest);
      if (mode === "staged" && latest.summary.stagedFiles === 0) setMode("all");
      setNeedsRefresh(false);
      setError(null);
      requestAnimationFrame(() => {
        if (latest.commit.allowed) messageRef.current?.focus();
        else cancelRef.current?.focus();
      });
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Aiden could not refresh Review.");
    } finally {
      setRefreshing(false);
    }
  };

  const commit = async () => {
    const expectedSnapshot = review?.commit.snapshot;
    const trimmedMessage = message.trim();
    if (
      busy ||
      blockedReason ||
      !review?.commit.allowed ||
      !expectedSnapshot ||
      !trimmedMessage ||
      (mode === "staged" && review.summary.stagedFiles === 0)
    ) {
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setError(null);
    let closeAfterSuccess = false;
    try {
      const result = await gitApi.commit(workspaceId, {
        expectedSnapshot,
        message: trimmedMessage,
        mode,
      });
      await invalidateGitState();
      closeAfterSuccess = true;
      toast.success(`Committed “${result.subject}” to ${result.branch}.`);
      if (result.warning) toast.warning(result.warning);
    } catch (commitError) {
      const message = commitError instanceof Error ? commitError.message : "Aiden could not create the commit.";
      setError(message);
      setNeedsRefresh(true);
      void invalidateGitState();
    } finally {
      onBusyChange(false);
      setBusy(false);
      if (closeAfterSuccess) requestAnimationFrame(() => onOpenChange(false));
    }
  };

  const stagedUnavailable = !review || review.summary.stagedFiles === 0;
  const disabledReason = busy ? null : blockedReason ?? review?.commit.reason ?? null;
  const confirmDisabled =
    busy ||
    refreshing ||
    needsRefresh ||
    Boolean(disabledReason) ||
    !message.trim() ||
    !review?.commit.snapshot ||
    (mode === "staged" && stagedUnavailable);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
      title="Commit changes"
      description={
        <>
          Commit the reviewed snapshot to <span className="font-medium text-primary">{branch}</span>. Git hooks and
          signing settings apply; push stays separate.
        </>
      }
      confirmLabel={busy ? "Committing…" : "Commit"}
      confirmDisabled={confirmDisabled}
      confirmHidden={!review?.commit.allowed}
      cancelRef={cancelRef}
      dismissDisabled={busy}
      onConfirm={commit}
      returnFocus={returnFocus}
    >
      <div className="space-y-4" aria-busy={busy}>
        {review?.commit.allowed ? (
          <>
            <div>
              <Label htmlFor="environment-commit-message">Commit message</Label>
              <Textarea
                ref={messageRef}
                id="environment-commit-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Describe this change"
                maxLength={10_000}
                rows={3}
                autoFocus
                disabled={busy || refreshing}
                className="mt-1.5 max-h-40 min-h-20 resize-y"
              />
            </div>

            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value as GitCommitMode)}
              orientation="vertical"
              aria-label="Changes to include"
            >
              {(["staged", "all"] as const).map((option) => {
                const disabled = option === "staged" && stagedUnavailable;
                return (
                  <Label
                    key={option}
                    className={cn(
                      "items-start rounded-control border border-field px-3 py-2.5",
                      !disabled && "cursor-pointer hover:border-primary/30 hover:bg-list-hover",
                      disabled && "opacity-45",
                    )}
                  >
                    <RadioGroupItem value={option} disabled={disabled || busy} className="mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-regular text-primary">
                        {option === "staged" ? "Staged changes only" : "All current changes"}
                      </span>
                      <span className="mt-0.5 block text-small text-secondary">
                        {selectionDescription(review, option)}
                      </span>
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
          </>
        ) : null}

        {busy ? (
          <div className="flex items-center gap-2 rounded-control bg-status-accent-surface px-3 py-2 text-small text-status-accent" role="status">
            <RefreshCw className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            <span>Creating an immutable local commit…</span>
          </div>
        ) : disabledReason ? (
          <div className="flex items-start gap-2 rounded-control bg-status-warning-surface px-3 py-2 text-small text-status-warning" role="status">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{disabledReason}</span>
          </div>
        ) : error ? (
          <div className="rounded-control bg-status-red-surface px-3 py-2 text-small text-status-red" role="alert">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
            {needsRefresh ? (
              <Button
                type="button"
                variant="transparent"
                size="small"
                disabled={refreshing}
                onClick={() => void refreshReview()}
                className="mt-2 text-primary"
              >
                <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden="true" />
                {refreshing ? "Refreshing…" : "Refresh changes"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
