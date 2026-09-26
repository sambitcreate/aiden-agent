import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  GitPullRequest,
  RefreshCw,
  UploadCloud,
} from "lucide-react";
import { gitApi, pullRequestsApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import type { GitPushCapability, GitPushResult } from "../lib/types";
import type { ChatPullRequestDetectResult } from "../shared/chat-pull-requests";
import {
  ChatPullRequestStateIcon,
  PullRequestCreateDialog,
  chatPullRequestChecksLabel,
  chatPullRequestRef,
  openPullRequestExternal,
} from "./chat-pull-requests";
import {
  Button,
  Dialog,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from "./ui";

export function GitPushDialog({
  workspaceId,
  chatId,
  capability,
  blockedReason,
  open,
  onOpenChange,
  onBusyChange,
  onCapabilityChange,
  returnFocus,
}: {
  workspaceId: string;
  /** Chat bound to the pane — enables post-push PR detection/linking. */
  chatId?: string;
  capability: GitPushCapability | null;
  blockedReason: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onCapabilityChange: (capability: GitPushCapability) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const queryClient = useQueryClient();
  const [remote, setRemote] = React.useState("");
  const [destinationBranch, setDestinationBranch] = React.useState("");
  const [setUpstream, setSetUpstream] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [needsRefresh, setNeedsRefresh] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pushedResult, setPushedResult] = React.useState<GitPushResult | null>(
    null,
  );
  const [detect, setDetect] =
    React.useState<ChatPullRequestDetectResult | null>(null);
  const [detecting, setDetecting] = React.useState(false);
  const [linkedRefs, setLinkedRefs] = React.useState<string[]>([]);
  const [createOpen, setCreateOpen] = React.useState(false);
  const originWorkspaceRef = React.useRef<string | null>(null);
  const destinationRef = React.useRef<HTMLInputElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const invalidateGitState = React.useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.gitReview(workspaceId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.git(workspaceId) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.gitBranches(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.gitPushCapability(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.gitPullRequestStatus(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.gitComparisons(workspaceId),
        }),
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
      const nextRemote =
        capability?.suggestedRemote ?? capability?.remotes[0] ?? "";
      const nextDestination =
        capability?.destinationBranch ?? capability?.branch ?? "";
      setRemote(nextRemote);
      setDestinationBranch(nextDestination);
      setSetUpstream(
        capability?.upstream !== `${nextRemote}/${nextDestination}`,
      );
      setBusy(false);
      setRefreshing(false);
      setNeedsRefresh(false);
      setError(null);
      setPushedResult(null);
      setDetect(null);
      setDetecting(false);
      setLinkedRefs([]);
      setCreateOpen(false);
      return;
    }
    if (originWorkspaceRef.current !== workspaceId && !busy)
      onOpenChange(false);
  }, [busy, capability, onOpenChange, open, workspaceId]);

  const refreshCapability = async () => {
    if (busy || refreshing) return;
    setRefreshing(true);
    try {
      const latest = await gitApi.pushCapability(workspaceId);
      queryClient.setQueryData(
        queryKeys.gitPushCapability(workspaceId),
        latest,
      );
      onCapabilityChange(latest);
      if (!latest.remotes.includes(remote))
        setRemote(latest.suggestedRemote ?? latest.remotes[0] ?? "");
      if (!destinationBranch)
        setDestinationBranch(latest.destinationBranch ?? latest.branch ?? "");
      setNeedsRefresh(false);
      setError(null);
      requestAnimationFrame(() => {
        if (latest.allowed) destinationRef.current?.focus();
        else cancelRef.current?.focus();
      });
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Aiden could not refresh the push state.",
      );
    } finally {
      setRefreshing(false);
    }
  };

  const detectPullRequests = React.useCallback(
    async (result: GitPushResult) => {
      if (!chatId) return;
      if (!result.pullRequestRepository) {
        setDetect({
          availability: "unsupported",
          matches: [],
          refreshed: [],
          message:
            "This push destination cannot be identified for GitHub pull requests. Link an existing PR by URL from the composer.",
        });
        return;
      }
      setDetecting(true);
      try {
        const outcome = await pullRequestsApi.detectAfterPush(chatId, {
          workspaceId,
          headBranch: result.destinationBranch,
          expectedHeadSha: result.commit,
          repository: result.pullRequestRepository,
        });
        setDetect(outcome);
        if (chatId) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.chatPullRequests(chatId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.chatCurrentPullRequest(chatId),
          });
        }
      } catch {
        setDetect(null);
      } finally {
        setDetecting(false);
      }
    },
    [chatId, queryClient, workspaceId],
  );

  const push = async (thenCreate = false) => {
    const expectedHead = capability?.expectedHead;
    const expectedBranch = capability?.branch;
    const expectedRemoteIdentity = capability?.remoteIdentities[remote];
    const destination = destinationBranch.trim();
    if (
      busy ||
      blockedReason ||
      !capability?.allowed ||
      !expectedBranch ||
      !expectedHead ||
      !expectedRemoteIdentity ||
      !remote ||
      !destination ||
      needsRefresh
    ) {
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await gitApi.push(workspaceId, {
        destinationBranch: destination,
        expectedBranch,
        expectedHead,
        expectedRemoteIdentity,
        remote,
        setUpstream,
      });
      await invalidateGitState();
      toast.success(
        `Pushed ${result.branch} to ${result.remote}/${result.destinationBranch}.`,
      );
      if (result.warning) toast.warning(result.warning);
      if (chatId) {
        // Keep the dialog open: the pushed branch may already have a PR to
        // link, or the user asked to create one.
        setPushedResult(result);
        setLinkedRefs([]);
        setDetect(null);
        void detectPullRequests(result);
        if (thenCreate && result.pullRequestRepository) setCreateOpen(true);
      } else {
        requestAnimationFrame(() => onOpenChange(false));
      }
    } catch (pushError) {
      setError(
        pushError instanceof Error
          ? pushError.message
          : "Aiden could not push this branch.",
      );
      setNeedsRefresh(true);
      void invalidateGitState();
    } finally {
      onBusyChange(false);
      setBusy(false);
    }
  };

  const linkDetected = async (
    view: ChatPullRequestDetectResult["matches"][number],
  ) => {
    if (!chatId) return;
    const ref = chatPullRequestRef(view);
    try {
      const linked = await pullRequestsApi.linkRef(
        chatId,
        ref,
        "branch-discovered",
      );
      if (!linked.ok) {
        toast.error(linked.message ?? "The pull request could not be linked.");
        return;
      }
      setLinkedRefs((current) => [
        ...current,
        `${ref.host}/${ref.repository}#${ref.number}`,
      ]);
      toast.success(`Linked pull request #${ref.number} to this chat.`);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chatPullRequests(chatId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chatCurrentPullRequest(chatId),
      });
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "The pull request could not be linked.",
      );
    }
  };

  const disabledReason = busy
    ? null
    : (blockedReason ?? capability?.reason ?? null);
  const confirmDisabled =
    busy ||
    refreshing ||
    needsRefresh ||
    Boolean(disabledReason) ||
    !capability?.branch ||
    !capability?.expectedHead ||
    !capability?.remoteIdentities[remote] ||
    !remote ||
    !destinationBranch.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
      title={pushedResult ? "Pushed" : "Push branch"}
      description={
        pushedResult ? (
          "Link the pull request for this branch, or create one."
        ) : (
          <>
            Push the reviewed{" "}
            <span className="font-medium text-primary">
              {capability?.branch ?? "current branch"}
            </span>{" "}
            commit. Aiden uses a normal non-force push and does not fetch first.
          </>
        )
      }
      confirmLabel={busy ? "Pushing…" : "Push"}
      confirmDisabled={confirmDisabled}
      confirmHidden={!capability?.allowed || pushedResult !== null}
      cancelRef={cancelRef}
      dismissDisabled={busy}
      onConfirm={() => void push()}
      returnFocus={returnFocus}
    >
      <div className="space-y-4" aria-busy={busy}>
        {pushedResult ? (
          <div className="space-y-3">
            <div
              className="flex items-center gap-2 rounded-control bg-status-green-surface px-3 py-2 text-small text-status-green"
              role="status"
            >
              <Check className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">
                Pushed {pushedResult.branch} to {pushedResult.remote}/
                {pushedResult.destinationBranch}.
              </span>
            </div>
            {detecting ? (
              <div
                className="flex items-center gap-2 rounded-control bg-well px-3 py-2 text-small text-secondary"
                role="status"
              >
                <RefreshCw
                  className="size-4 shrink-0 animate-spin"
                  aria-hidden="true"
                />
                <span>Checking GitHub for a pull request on this branch…</span>
              </div>
            ) : detect ? (
              detect.matches.length > 0 || detect.refreshed.length > 0 ? (
                <div className="space-y-1.5">
                  {detect.refreshed.map((view) => (
                    <button
                      key={`${view.host}/${view.repository}#${view.number}`}
                      type="button"
                      className="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left outline-none transition-colors hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline-none"
                      onClick={() => openPullRequestExternal(view.url)}
                    >
                      <ChatPullRequestStateIcon view={view} />
                      <span className="min-w-0 flex-1 truncate text-small text-primary">
                        PR #{view.number}
                        {view.title ? ` · ${view.title}` : ""}
                      </span>
                      <span className="shrink-0 text-mini text-tertiary">
                        {chatPullRequestChecksLabel(view.checksState) ??
                          "Linked"}
                      </span>
                    </button>
                  ))}
                  {detect.matches.map((view) => {
                    const ref = chatPullRequestRef(view);
                    const key = `${ref.host}/${ref.repository}#${ref.number}`;
                    const linked = linkedRefs.includes(key);
                    return (
                      <div
                        key={key}
                        className="flex min-w-0 items-center gap-2 rounded-control px-2 py-1.5"
                      >
                        <ChatPullRequestStateIcon view={view} />
                        <span className="min-w-0 flex-1 truncate text-small text-primary">
                          PR #{view.number}
                          {view.title ? ` · ${view.title}` : ""}
                        </span>
                        {linked ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-control bg-status-green-surface px-1.5 py-0.5 text-mini text-status-green">
                            <Check className="size-3" aria-hidden="true" />
                            Linked
                          </span>
                        ) : (
                          <Button
                            variant="muted"
                            size="small"
                            onClick={() => void linkDetected(view)}
                          >
                            Link PR
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 rounded-control bg-well px-3 py-2">
                  <span className="min-w-0 text-small text-secondary">
                    {detect.availability === "ready"
                      ? `No pull request exists for ${pushedResult.destinationBranch} yet.`
                      : (detect.message ??
                        "Aiden could not check GitHub for a pull request.")}
                  </span>
                  {detect.availability === "ready" ? (
                    <Button
                      variant="muted"
                      size="small"
                      className="shrink-0 gap-1"
                      onClick={() => setCreateOpen(true)}
                    >
                      <GitPullRequest className="size-3.5" aria-hidden="true" />
                      Create pull request
                    </Button>
                  ) : null}
                </div>
              )
            ) : null}
          </div>
        ) : capability?.allowed ? (
          <>
            <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3">
              <div>
                <Label htmlFor="environment-push-remote">Remote</Label>
                <Select
                  value={remote}
                  onValueChange={setRemote}
                  disabled={busy || refreshing}
                >
                  <SelectTrigger
                    id="environment-push-remote"
                    className="mt-1.5"
                    aria-label="Push remote"
                  >
                    <SelectValue placeholder="Choose remote" />
                  </SelectTrigger>
                  <SelectContent>
                    {capability.remotes.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="environment-push-destination">
                  Destination branch
                </Label>
                <Input
                  ref={destinationRef}
                  id="environment-push-destination"
                  value={destinationBranch}
                  onChange={(event) => setDestinationBranch(event.target.value)}
                  disabled={busy || refreshing}
                  className="mt-1.5"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
            </div>

            <Label className="items-center justify-between rounded-control border border-field px-3 py-2.5">
              <span className="min-w-0 pr-3">
                <span className="block text-regular text-primary">
                  Remember as upstream
                </span>
                <span className="mt-0.5 block text-small text-secondary">
                  Future ahead/behind counts use the last-fetched tracking ref.
                  Aiden still never fetches implicitly.
                </span>
              </span>
              <Switch
                checked={setUpstream}
                onCheckedChange={setSetUpstream}
                disabled={busy || refreshing}
                aria-label="Remember destination as upstream"
                className="shrink-0"
              />
            </Label>

            <div className="rounded-control bg-well px-3 py-2 text-small text-secondary">
              Pre-push hooks and configured Git authentication may run. Force
              push and submodule recursion are never used.
            </div>

            {chatId ? (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="muted"
                  size="small"
                  className="gap-1.5"
                  disabled={confirmDisabled}
                  onClick={() => void push(true)}
                >
                  <GitPullRequest className="size-3.5" aria-hidden="true" />
                  Push & create pull request
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {busy ? (
          <div
            className="flex items-center gap-2 rounded-control bg-status-accent-surface px-3 py-2 text-small text-status-accent"
            role="status"
          >
            <UploadCloud className="size-4 shrink-0" aria-hidden="true" />
            <span>
              Pushing the frozen commit… Workspace switching and dismissal stay
              locked.
            </span>
          </div>
        ) : disabledReason ? (
          <div
            className="flex items-start gap-2 rounded-control bg-status-warning-surface px-3 py-2 text-small text-status-warning"
            role="status"
          >
            <AlertCircle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>{disabledReason}</span>
          </div>
        ) : error ? (
          <div
            className="rounded-control bg-status-red-surface px-3 py-2 text-small text-status-red"
            role="alert"
          >
            <div className="flex items-start gap-2">
              <AlertCircle
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span>{error}</span>
            </div>
            {needsRefresh ? (
              <Button
                type="button"
                variant="transparent"
                size="small"
                disabled={refreshing}
                onClick={() => void refreshCapability()}
                className="mt-2 text-primary"
              >
                <RefreshCw
                  className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
                  aria-hidden="true"
                />
                {refreshing ? "Refreshing…" : "Refresh branch state"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {chatId && pushedResult ? (
        <PullRequestCreateDialog
          chatId={chatId}
          workspaceId={workspaceId}
          headBranch={pushedResult.destinationBranch}
          expectedHeadSha={pushedResult.commit}
          repository={pushedResult.pullRequestRepository}
          defaultTitle={pushedResult.destinationBranch}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() => {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.chatPullRequests(chatId),
            });
            void queryClient.invalidateQueries({
              queryKey: queryKeys.chatCurrentPullRequest(chatId),
            });
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}
