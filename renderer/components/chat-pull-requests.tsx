// Chat ↔ pull request surface: the chip in the composer context bar and the
// rail listing a chat's linked PRs, plus the link and create dialogs shared by
// the rail and the post-push flow. Links are durable chat state resolved in
// the main process; this file only renders bounded views.

import * as React from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  Textarea,
  toast,
} from "./ui";
import { pullRequestsApi } from "../lib/ipc";
import type {
  ChatPullRequestPendingCreate,
  ChatPullRequestRef,
  ChatPullRequestView,
} from "../shared/chat-pull-requests";
import {
  queryKeys,
  useChatCurrentPullRequest,
  useChatPullRequestCandidates,
  useChatPullRequestPending,
  useChatPullRequests,
  useGitBranches,
} from "../lib/queries";
import { cn } from "../lib/ui-utils";

export function openPullRequestExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function chatPullRequestRef(view: ChatPullRequestView): ChatPullRequestRef {
  return { host: view.host, repository: view.repository, number: view.number };
}

export function chatPullRequestChecksTone(state: ChatPullRequestView["checksState"]): string {
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

export function chatPullRequestChecksLabel(
  state: ChatPullRequestView["checksState"],
): string | null {
  switch (state) {
    case "passing":
      return "Checks passing";
    case "failing":
      return "Checks failing";
    case "pending":
      return "Checks pending";
    default:
      return null;
  }
}

function stateLabel(view: ChatPullRequestView): string {
  if (view.state === "merged") return "Merged";
  if (view.state === "closed") return "Closed";
  if (view.isDraft) return "Draft";
  return "Open";
}

export function ChatPullRequestStateIcon({ view }: { view: ChatPullRequestView }) {
  const className = "size-3.5 shrink-0";
  if (view.state === "merged") {
    return <GitMerge className={cn(className, "text-secondary")} aria-hidden="true" />;
  }
  if (view.state === "closed") {
    return <GitPullRequestClosed className={cn(className, "text-secondary")} aria-hidden="true" />;
  }
  if (view.isDraft) {
    return <GitPullRequestDraft className={cn(className, "text-secondary")} aria-hidden="true" />;
  }
  return <GitPullRequest className={cn(className, "text-status-green")} aria-hidden="true" />;
}

function sourceHint(view: ChatPullRequestView): string | null {
  switch (view.source) {
    case "created":
      return "Created from Aiden";
    case "branch-discovered":
      return "Detected after push";
    default:
      return null;
  }
}

function samePullRequestRef(a: ChatPullRequestRef, b: ChatPullRequestRef): boolean {
  return a.host === b.host && a.repository === b.repository && a.number === b.number;
}

function PullRequestRow({
  chatId,
  view,
  current,
  onChanged,
}: {
  chatId: string;
  view: ChatPullRequestView;
  current: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState<"refresh" | "unlink" | null>(null);
  const checkSummary = chatPullRequestChecksLabel(view.checksState);
  return (
    <li className="flex min-w-0 items-start gap-2 rounded-control px-2 py-2">
      <ChatPullRequestStateIcon view={view} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-small-strong text-primary">
            #{view.number}
            {view.title ? ` ${view.title}` : ""}
          </span>
          {current ? (
            <span className="shrink-0 rounded-control bg-status-accent-surface px-1.5 py-0.5 text-mini text-accent">
              Current
            </span>
          ) : null}
          {!view.linked ? (
            <span className="shrink-0 rounded-control bg-control px-1.5 py-0.5 text-mini text-secondary">
              Not linked
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-small text-tertiary">
          <span className="truncate">
            {view.repository ? `${view.repository} · ` : ""}
            {view.headBranch ?? "?"} → {view.baseBranch ?? "?"}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-small">
          {checkSummary ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-control px-1.5 py-0.5",
                chatPullRequestChecksTone(view.checksState),
              )}
            >
              {checkSummary}
            </span>
          ) : (
            <span className="text-tertiary">{stateLabel(view)}</span>
          )}
          {sourceHint(view) ? (
            <span className="truncate text-tertiary">{sourceHint(view)}</span>
          ) : null}
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label={`Actions for pull request #${view.number}`}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => openPullRequestExternal(view.url)}>
            <ExternalLink aria-hidden="true" />
            Open on GitHub
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openPullRequestExternal(`${view.url}/checks`)}>
            <CheckCircle2 aria-hidden="true" />
            View checks
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={busy !== null}
            onSelect={() => {
              setBusy("refresh");
              void pullRequestsApi
                .refresh(chatId, chatPullRequestRef(view))
                .then(onChanged)
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : "Refresh failed."),
                )
                .finally(() => setBusy(null));
            }}
          >
            {busy === "refresh" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            Refresh
          </DropdownMenuItem>
          {view.linked ? (
            <DropdownMenuItem
              disabled={busy !== null}
              onSelect={() => {
                setBusy("unlink");
                void pullRequestsApi
                  .unlink(chatId, chatPullRequestRef(view))
                  .then(onChanged)
                  .catch((error: unknown) =>
                    toast.error(error instanceof Error ? error.message : "Unlink failed."),
                  )
                  .finally(() => setBusy(null));
              }}
            >
              {busy === "unlink" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <GitPullRequestClosed aria-hidden="true" />
              )}
              Unlink from chat
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function PendingCreateRow({
  chatId,
  pending,
  onChanged,
}: {
  chatId: string;
  pending: ChatPullRequestPendingCreate;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const candidates = pending.candidates ?? [];
  return (
    <div className="mb-2 rounded-control bg-status-warning-surface px-2.5 py-2" role="status">
      <p className="flex items-center gap-1.5 text-small-strong text-status-warning">
        <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
        PR creation needs review
      </p>
      <p className="mt-0.5 truncate text-small text-secondary">
        {pending.intent.title} · {pending.intent.headBranch} → {pending.intent.baseBranch}
      </p>
      {candidates.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {candidates.map((candidate) => (
            <li key={`${candidate.ref.repository}#${candidate.ref.number}`}>
              <button
                type="button"
                disabled={busy}
                className="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left text-small text-primary outline-none transition-colors hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline-none"
                onClick={() => {
                  setBusy(true);
                  void pullRequestsApi
                    .adopt(chatId, pending.intent.operationId, candidate.ref)
                    .then(() => {
                      toast.success(`Linked pull request #${candidate.ref.number}.`);
                      onChanged();
                    })
                    .catch((error: unknown) =>
                      toast.error(
                        error instanceof Error ? error.message : "Could not link the pull request.",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                <GitPullRequest
                  className="size-3.5 shrink-0 text-status-green"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">
                  #{candidate.ref.number} {candidate.title}
                </span>
                <span className="shrink-0 text-mini text-tertiary">Use this PR</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-small text-tertiary">
          Aiden is still checking whether GitHub created the pull request.
        </p>
      )}
    </div>
  );
}

export function PullRequestLinkDialog({
  chatId,
  open,
  onOpenChange,
  onLinked,
}: {
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked?: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [linking, setLinking] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const candidates = useChatPullRequestCandidates(chatId, open);

  React.useEffect(() => {
    if (open) {
      setUrl("");
      setError(null);
    }
  }, [open]);

  const link = async (promise: Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await promise;
      if (result.ok) {
        setUrl("");
        onOpenChange(false);
        onLinked?.();
        toast.success("Pull request linked to this chat.");
        return;
      }
      setError(result.message ?? "The pull request could not be linked.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The pull request could not be linked.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
      title="Link pull request"
      description="Paste a GitHub pull request URL, or choose one from the workspace repository."
      confirmLabel={busy ? "Linking…" : "Link"}
      confirmDisabled={!url.trim() || busy}
      busy={busy}
      onConfirm={() => void link(pullRequestsApi.link(chatId, { url: url.trim() }))}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="chat-pr-link-url">Pull request URL</Label>
          <Input
            id="chat-pr-link-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/owner/repo/pull/123"
            autoFocus
            disabled={busy}
            className="mt-1.5"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        {error ? (
          <div
            className="flex items-start gap-2 rounded-control bg-status-red-surface px-3 py-2 text-small text-status-red"
            role="alert"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        <div>
          <p className="mb-1.5 text-small-strong text-secondary">Open pull requests</p>
          {candidates.isLoading ? (
            <p className="flex items-center gap-1.5 py-2 text-small text-tertiary">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Loading pull requests…
            </p>
          ) : candidates.data?.availability !== "ready" ? (
            <p className="py-1 text-small text-tertiary">
              {candidates.data?.message ?? "Pull requests are not available for this workspace."}
            </p>
          ) : candidates.data.pullRequests.length === 0 ? (
            <p className="py-1 text-small text-tertiary">No open pull requests found.</p>
          ) : (
            <ul className="flex max-h-64 flex-col overflow-y-auto">
              {candidates.data.pullRequests.map((candidate) => {
                const key = `${candidate.host}/${candidate.repository}#${candidate.number}`;
                return (
                  <li key={key} className="flex min-w-0 items-center gap-2 px-2 py-1.5">
                    <ChatPullRequestStateIcon view={candidate} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-small-strong text-primary">
                        #{candidate.number}
                        {candidate.title ? ` ${candidate.title}` : ""}
                      </p>
                      <p className="truncate text-small text-tertiary">
                        {candidate.repository} · {candidate.headBranch} → {candidate.baseBranch}
                      </p>
                    </div>
                    {candidate.linked ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-control bg-status-green-surface px-1.5 py-0.5 text-mini text-status-green">
                        <Check className="size-3" aria-hidden="true" />
                        Linked
                      </span>
                    ) : (
                      <Button
                        variant="muted"
                        size="small"
                        disabled={linking !== null}
                        onClick={() => {
                          setLinking(key);
                          void link(
                            pullRequestsApi.linkRef(
                              chatId,
                              chatPullRequestRef(candidate),
                              "manual",
                            ),
                          ).finally(() => setLinking(null));
                        }}
                      >
                        {linking === key ? "Linking…" : "Link"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function PullRequestCreateDialog({
  chatId,
  workspaceId,
  headBranch,
  expectedHeadSha,
  defaultTitle,
  open,
  onOpenChange,
  onCreated,
}: {
  chatId: string;
  workspaceId: string;
  headBranch: string;
  expectedHeadSha?: string;
  defaultTitle?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (view: ChatPullRequestView) => void;
}) {
  const [title, setTitle] = React.useState(defaultTitle ?? "");
  const [baseBranch, setBaseBranch] = React.useState("");
  const [body, setBody] = React.useState("");
  const [draft, setDraft] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const branches = useGitBranches(workspaceId, open);

  React.useEffect(() => {
    if (open) {
      setTitle(defaultTitle ?? "");
      setBaseBranch("");
      setBody("");
      setDraft(false);
      setError(null);
    }
  }, [open, defaultTitle]);

  React.useEffect(() => {
    if (!open || baseBranch) return;
    const fallback =
      branches.data?.defaultBranch ??
      branches.data?.remoteBranches
        .find((name) => name.endsWith("/main") || name.endsWith("/master"))
        ?.split("/")
        .slice(1)
        .join("/");
    if (fallback) setBaseBranch(fallback);
  }, [open, baseBranch, branches.data]);

  const baseOptions = React.useMemo(() => {
    const names = new Set<string>();
    for (const name of branches.data?.branches ?? []) names.add(name);
    for (const remote of branches.data?.remoteBranches ?? []) {
      const short = remote.split("/").slice(1).join("/");
      if (short) names.add(short);
    }
    if (baseBranch) names.add(baseBranch);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [branches.data, baseBranch]);

  const create = async () => {
    const trimmedTitle = title.trim();
    if (busy || !trimmedTitle || !baseBranch || !headBranch) return;
    setBusy(true);
    setError(null);
    try {
      const result = await pullRequestsApi.create(chatId, {
        workspaceId,
        title: trimmedTitle,
        body: body.trim() || undefined,
        baseBranch,
        headBranch,
        expectedHeadSha,
        draft,
      });
      switch (result.kind) {
        case "created":
          onOpenChange(false);
          onCreated?.(result.pullRequest);
          toast.success(`Pull request #${result.pullRequest.number} created and linked.`);
          return;
        case "ambiguous":
          setError(
            "GitHub reported more than one matching pull request — choose it under Pull Requests in the composer.",
          );
          return;
        case "pending":
          setError(result.message);
          return;
        default:
          setError(result.message);
          return;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The pull request could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
      title="Create pull request"
      description={
        <>
          Open a pull request for <span className="font-medium text-primary">{headBranch}</span>.
          The new PR is linked to this chat automatically.
        </>
      }
      confirmLabel={
        busy ? "Creating…" : draft ? "Create draft pull request" : "Create pull request"
      }
      confirmDisabled={!title.trim() || !baseBranch || busy || !headBranch}
      busy={busy}
      onConfirm={() => void create()}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="chat-pr-create-title">Title</Label>
          <Input
            id="chat-pr-create-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add a title"
            autoFocus
            disabled={busy}
            className="mt-1.5"
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
          <div>
            <Label htmlFor="chat-pr-create-base">Base branch</Label>
            <Select value={baseBranch} onValueChange={setBaseBranch} disabled={busy}>
              <SelectTrigger id="chat-pr-create-base" className="mt-1.5" aria-label="Base branch">
                <SelectValue placeholder="Choose base branch" />
              </SelectTrigger>
              <SelectContent>
                {baseOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Label className="items-center gap-2 pb-2">
            <Switch
              checked={draft}
              onCheckedChange={setDraft}
              disabled={busy}
              aria-label="Create as draft"
            />
            <span className="text-small text-secondary">{draft ? "Draft" : "Ready"}</span>
          </Label>
        </div>
        <div>
          <Label htmlFor="chat-pr-create-body">Description</Label>
          <Textarea
            id="chat-pr-create-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Optional description"
            rows={4}
            disabled={busy}
            maxLength={65536}
            className="mt-1.5 max-h-48 min-h-20 resize-y"
          />
        </div>
        {error ? (
          <div
            className="flex items-start gap-2 rounded-control bg-status-red-surface px-3 py-2 text-small text-status-red"
            role="alert"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * Optional remote-status footer for Environment → Review: a link to the chat's
 * resolved current PR, keeping local review and GitHub state separate.
 */
export function ChatPullRequestReviewFooter({ chatId }: { chatId?: string }) {
  const current = useChatCurrentPullRequest(chatId, Boolean(chatId));
  const view = current.data?.pullRequest;
  if (!view) return null;
  const checks = chatPullRequestChecksLabel(view.checksState);
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-separator px-3 py-2">
      <span className="flex min-w-0 items-center gap-1.5 text-small text-secondary">
        <ChatPullRequestStateIcon view={view} />
        <span className="truncate">
          PR #{view.number}
          {checks ? ` · ${checks}` : ` · ${stateLabel(view)}`}
        </span>
      </span>
      <button
        type="button"
        className="shrink-0 rounded-control px-1.5 py-0.5 text-small text-accent outline-none transition-colors hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline-none"
        onClick={() => openPullRequestExternal(view.url)}
      >
        View pull request →
      </button>
    </div>
  );
}

/**
 * The composer chip: "Pull Requests · N" / "N open · M linked", opening the rail.
 */
export function ChatPullRequestsChip({ chatId }: { chatId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const links = useChatPullRequests(chatId);
  const current = useChatCurrentPullRequest(chatId);
  // Always on: pending create intents surface on the chip even before the rail opens.
  const pending = useChatPullRequestPending(chatId, true);

  const invalidate = React.useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.chatPullRequests(chatId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chatCurrentPullRequest(chatId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chatPullRequestPending(chatId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chatPullRequestCandidates(chatId) }),
    ]);
  }, [queryClient, chatId]);

  // Opening the rail refreshes linked snapshots from GitHub.
  React.useEffect(() => {
    if (!open) return;
    void pullRequestsApi
      .refresh(chatId)
      .then(invalidate)
      .catch(() => undefined);
  }, [open, chatId, invalidate]);

  const views = links.data?.links ?? [];
  const openCount = views.filter((view) => view.state === "open").length;
  const currentView = current.data?.pullRequest;
  const rows = React.useMemo(() => {
    const merged = [...views];
    if (currentView && !merged.some((v) => samePullRequestRef(v, currentView))) {
      merged.push(currentView);
    }
    return merged;
  }, [views, currentView]);

  const chipLabel =
    views.length === 0
      ? "Pull Requests"
      : openCount > 0
        ? `⑂ ${openCount} open · ${views.length} linked`
        : `Pull Requests · ${views.length}`;

  const pendingCount = pending.data?.length ?? 0;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="transparent"
            size="small"
            className="h-7 shrink-0 gap-1.5 px-2 text-secondary"
            aria-label={`${chipLabel} for this chat`}
          >
            <GitPullRequest className="size-4 shrink-0" aria-hidden="true" />
            <span className="max-w-[14rem] truncate">{chipLabel}</span>
            {pendingCount > 0 ? (
              <span className="size-1.5 rounded-full bg-status-warning" aria-hidden="true" />
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[22rem] p-0"
          aria-label="Pull requests linked to this chat"
        >
          <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
            <Text as="h3" variant="small-strong" color="secondary">
              Pull requests
            </Text>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              aria-label="Link an existing pull request"
              onClick={() => setLinkOpen(true)}
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
          <div className="max-h-80 overflow-y-auto px-1.5 pb-2">
            {pending.data?.map((entry) => (
              <PendingCreateRow
                key={entry.intent.operationId}
                chatId={chatId}
                pending={entry}
                onChanged={invalidate}
              />
            ))}
            {rows.length === 0 ? (
              <p className="px-2 py-3 text-small text-tertiary">
                No pull requests are linked to this chat yet.
              </p>
            ) : (
              <ul className="flex flex-col">
                {rows.map((view) => (
                  <PullRequestRow
                    key={`${view.host}/${view.repository}#${view.number}`}
                    chatId={chatId}
                    view={view}
                    current={Boolean(
                      currentView && samePullRequestRef(view, chatPullRequestRef(currentView)),
                    )}
                    onChanged={invalidate}
                  />
                ))}
              </ul>
            )}
          </div>
          {currentView ? (
            <div className="flex items-center justify-between gap-2 border-t border-separator px-3 py-2">
              <span className="truncate text-small text-tertiary">
                PR #{currentView.number}
                {chatPullRequestChecksLabel(currentView.checksState)
                  ? ` · ${chatPullRequestChecksLabel(currentView.checksState)?.toLowerCase()}`
                  : ""}
              </span>
              <Button
                variant="transparent"
                size="small"
                className="shrink-0 gap-1 px-1.5 text-accent"
                onClick={() => openPullRequestExternal(currentView.url)}
              >
                View pull request
                <ExternalLink className="size-3" aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      <PullRequestLinkDialog
        chatId={chatId}
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onLinked={invalidate}
      />
    </>
  );
}
