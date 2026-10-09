// What a sidebar chat row says about its code context: the managed worktree it
// runs in and the pull request it is working on. Workspace rows no longer carry
// these — they belong to the chat that owns the branch.

import {
  parseGitHubPullRequestUrl,
  pullRequestRefKey,
  type ChatPullRequestView,
} from "../shared/chat-pull-requests";
import type { GitHubPullRequestChecksState, GitHubPullRequestSummary } from "./types";

export interface SidebarRowPullRequest {
  number: number;
  url: string;
  title?: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  /** Only meaningful while the PR is open and not a draft. */
  checksState?: GitHubPullRequestChecksState | null;
}

/** The discovered PR's `host/repository#number`, or nothing when its URL disagrees. */
function discoveredRefKey(discovered: GitHubPullRequestSummary): string | undefined {
  const ref = parseGitHubPullRequestUrl(discovered.url);
  return ref && ref.number === discovered.number ? pullRequestRefKey(ref) : undefined;
}

/**
 * The PR a chat row shows. A PR the chat linked wins over the one found on its
 * worktree branch, and a branch PR the chat unlinked never comes back. When
 * the linked and branch PRs are the same PR the branch read is live and
 * supplies state and checks, except that a merged PR never reads as open
 * again. Checks from a stored snapshot alone are left out: snapshots refresh
 * only when the chat's PR rail opens, so they can say "running" for days.
 */
export function sidebarRowPullRequest(
  linked: ChatPullRequestView | undefined,
  discovered: GitHubPullRequestSummary | undefined,
  dismissed: readonly string[] = [],
): SidebarRowPullRequest | undefined {
  const discoveredKey = discovered ? discoveredRefKey(discovered) : undefined;
  const live = discoveredKey && !dismissed.includes(discoveredKey) ? discovered : undefined;
  if (linked) {
    const same = live && discoveredKey === pullRequestRefKey(linked) ? live : undefined;
    const state = linked.state === "merged" ? "merged" : (same?.state ?? linked.state ?? "open");
    return {
      number: linked.number,
      url: linked.url,
      title: same?.title ?? linked.title,
      state,
      isDraft: Boolean(same ? same.isDraft : linked.isDraft),
      checksState: same?.checksState,
    };
  }
  if (!live) return undefined;
  return {
    number: live.number,
    url: live.url,
    title: live.title,
    state: live.state,
    isDraft: Boolean(live.isDraft),
    checksState: live.checksState,
  };
}

/** The checks state worth showing: closed, merged and draft PRs show none. */
export function rowPullRequestChecks(pullRequest: SidebarRowPullRequest): GitHubPullRequestChecksState | undefined {
  if (pullRequest.state !== "open" || pullRequest.isDraft) return undefined;
  return pullRequest.checksState ?? undefined;
}

export function rowPullRequestStateLabel(pullRequest: SidebarRowPullRequest): string {
  if (pullRequest.state === "merged") return "Merged";
  if (pullRequest.state === "closed") return "Closed";
  return pullRequest.isDraft ? "Draft" : "Open";
}

const CHECKS_LABELS: Record<GitHubPullRequestChecksState, string> = {
  passing: "checks passing",
  failing: "checks failing",
  pending: "checks running",
};

/** Accessible name, e.g. "Pull request #42, open, checks failing". */
export function rowPullRequestLabel(pullRequest: SidebarRowPullRequest): string {
  const checks = rowPullRequestChecks(pullRequest);
  return [
    `Pull request #${pullRequest.number}`,
    rowPullRequestStateLabel(pullRequest).toLowerCase(),
    checks ? CHECKS_LABELS[checks] : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

export function rowWorktreeLabel(branch: string): string {
  return `Worktree on ${branch}`;
}
