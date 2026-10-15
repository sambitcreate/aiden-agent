import {
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { ChatSidebarPullRequests } from "../shared/chat-pull-requests";
import {
  rowPullRequestChecks,
  rowPullRequestLabel,
  rowWorktreeLabel,
  sidebarRowPullRequest,
  type SidebarRowPullRequest,
} from "../lib/chat-row-context";
import { useGitPullRequestStatus } from "../lib/queries";
import type { Workspace } from "../lib/types";
import { cn } from "../lib/ui-utils";

const GLYPH = "inline-flex size-5 items-center justify-center";

type PullRequestTone = "failing" | "pending" | "passing" | "neutral";

const TONE_CLASS: Record<PullRequestTone, string> = {
  failing: "text-status-red",
  pending: "text-status-warning",
  passing: "text-status-green",
  neutral: "text-tertiary",
};

/** Only a confirmed check result earns a color; no checks reads as neutral, not passing. */
function pullRequestTone(pullRequest: SidebarRowPullRequest): PullRequestTone {
  return rowPullRequestChecks(pullRequest) ?? "neutral";
}

function PullRequestIcon({ pullRequest }: { pullRequest: SidebarRowPullRequest }) {
  const className = "size-3.5";
  if (pullRequest.state === "merged") return <GitMerge className={className} aria-hidden="true" />;
  if (pullRequest.state === "closed") return <GitPullRequestClosed className={className} aria-hidden="true" />;
  if (pullRequest.isDraft) return <GitPullRequestDraft className={className} aria-hidden="true" />;
  return <GitPullRequest className={className} aria-hidden="true" />;
}

/**
 * Informational code-context glyphs for a chat row. They sit inside the row's
 * button, so they are images with accessible names rather than controls; the
 * PR rail in the chat holds the interactive details.
 */
export function ChatRowContext({
  worktreeBranch,
  pullRequest,
}: {
  worktreeBranch?: string;
  pullRequest?: SidebarRowPullRequest;
}) {
  return (
    <>
      {worktreeBranch ? (
        <span
          role="img"
          aria-label={rowWorktreeLabel(worktreeBranch)}
          title={rowWorktreeLabel(worktreeBranch)}
          data-chat-row-worktree="true"
          className={cn(GLYPH, "text-tertiary")}
        >
          <GitBranch className="size-3.5" aria-hidden="true" />
        </span>
      ) : null}
      {pullRequest ? (
        <span
          role="img"
          aria-label={rowPullRequestLabel(pullRequest)}
          title={pullRequest.title ? `${rowPullRequestLabel(pullRequest)}\n${pullRequest.title}` : rowPullRequestLabel(pullRequest)}
          data-chat-row-pull-request={pullRequest.state}
          data-tone={pullRequestTone(pullRequest)}
          className={cn(GLYPH, TONE_CLASS[pullRequestTone(pullRequest)])}
        >
          <PullRequestIcon pullRequest={pullRequest} />
        </span>
      ) : null}
    </>
  );
}

/**
 * Resolves a chat row's context. The linked PR and dismissed refs come from
 * the sidebar's cache-only bulk read. Only rows the caller marks `live` (those
 * inside an expanded workspace group) also read their managed worktree's
 * branch PR from GitHub, which the query cache shares across every chat in
 * that worktree; a merged linked PR needs no live read at all.
 */
export function ChatRowContextGlyphs({
  workspace,
  pullRequests,
  live,
}: {
  workspace?: Workspace;
  pullRequests?: ChatSidebarPullRequests;
  live: boolean;
}) {
  const worktree = workspace?.managedWorktree;
  const linked = pullRequests?.pullRequest;
  const readsBranch = Boolean(
    live &&
      worktree &&
      workspace?.folderPath &&
      workspace.permission !== "none" &&
      linked?.state !== "merged",
  );
  const status = useGitPullRequestStatus(workspace?.id, readsBranch);
  const pullRequest = sidebarRowPullRequest(
    linked,
    readsBranch ? status.data?.pullRequest : undefined,
    pullRequests?.dismissed,
  );
  return <ChatRowContext worktreeBranch={worktree?.branch} pullRequest={pullRequest} />;
}
