// Chat-aware "which PR is current" resolution.
//
// `current` is a derived view — it never mutates durable links and never
// assumes chat ↔ branch ↔ PR is 1:1. Preference order:
//   1. linked open PR matching the workspace's repository + checked-out branch
//   2. linked open PR Aiden created
//   3. most recently linked open PR
//   4. most recently linked PR of any state
//   5. the workspace-branch PR discovered live via gh (not linked)
//   6. none

import type {
  ChatPullRequestCurrentReason,
  ChatPullRequestLink,
  ChatPullRequestView,
} from "../../renderer/shared/chat-pull-requests.js";

export interface PullRequestResolverContext {
  /** Workspace repository identity (canonical `owner/repo`) when known. */
  host?: string;
  repository?: string;
  /** Checked-out branch in the workspace, when known. */
  branch?: string;
  /** Live workspace-branch PR discovery result, when one exists. */
  discovered?: ChatPullRequestView;
}

export function pullRequestViewFromLink(link: ChatPullRequestLink): ChatPullRequestView {
  const snapshot = link.snapshot;
  return {
    host: link.host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    linked: true,
    source: link.source,
    linkedAt: link.linkedAt,
    ...(snapshot
      ? {
          title: snapshot.title,
          state: snapshot.state,
          ...(snapshot.isDraft ? { isDraft: true } : {}),
          headBranch: snapshot.headBranch,
          baseBranch: snapshot.baseBranch,
          ...(snapshot.headSha ? { headSha: snapshot.headSha } : {}),
          ...(snapshot.author ? { author: snapshot.author } : {}),
          ...(snapshot.reviewDecision !== undefined
            ? { reviewDecision: snapshot.reviewDecision }
            : {}),
          ...(snapshot.mergeable !== undefined ? { mergeable: snapshot.mergeable } : {}),
          ...(snapshot.checksState !== undefined ? { checksState: snapshot.checksState } : {}),
          syncedAt: snapshot.syncedAt,
        }
      : {}),
  };
}

export function resolveCurrentPullRequest(
  links: readonly ChatPullRequestLink[],
  context: PullRequestResolverContext,
): { pullRequest: ChatPullRequestView | undefined; reason: ChatPullRequestCurrentReason } {
  const byLinkedAtDesc = (a: ChatPullRequestLink, b: ChatPullRequestLink) =>
    b.linkedAt - a.linkedAt;
  const openLinks = links.filter((link) => link.snapshot?.state === "open");

  // 1. Open linked PR on the workspace's repository + current branch.
  if (context.branch && context.repository) {
    const matching = links
      .filter(
        (link) =>
          link.snapshot?.state === "open" &&
          link.snapshot.headBranch === context.branch &&
          link.repository === context.repository &&
          (!context.host || link.host === context.host),
      )
      .sort(byLinkedAtDesc)[0];
    if (matching) {
      return { pullRequest: pullRequestViewFromLink(matching), reason: "workspace-branch" };
    }
  }

  // 2. Open linked PR Aiden created for this chat.
  const created = openLinks.filter((link) => link.source === "created").sort(byLinkedAtDesc)[0];
  if (created) {
    return { pullRequest: pullRequestViewFromLink(created), reason: "created" };
  }

  // 3. Most recently linked open PR.
  const recentOpen = [...openLinks].sort(byLinkedAtDesc)[0];
  if (recentOpen) {
    return { pullRequest: pullRequestViewFromLink(recentOpen), reason: "recent-open" };
  }

  // 4. Most recently linked PR regardless of state.
  const recent = [...links].sort(byLinkedAtDesc)[0];
  if (recent) {
    return { pullRequest: pullRequestViewFromLink(recent), reason: "recent-linked" };
  }

  // 5. Workspace discovery (a PR exists for the checked-out branch, unlinked).
  if (context.discovered) {
    return {
      pullRequest: { ...context.discovered, linked: false },
      reason: "discovered",
    };
  }

  return { pullRequest: undefined, reason: "none" };
}
