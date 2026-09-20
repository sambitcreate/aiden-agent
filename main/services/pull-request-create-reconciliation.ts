// Unknown-outcome reconciliation for `gh pr create`.
//
// GitHub can apply the create even when the CLI result never made it back —
// timeout, kill, crash between the mutation and persisting the link. Every
// create first records a durable intent in the per-chat store; when the CLI
// outcome is unknown we query GitHub for `repository + exact head branch` and
// adopt (one match), clear for a safe retry (zero), or hand the candidates
// back for the user to pick (multiple). Never a blind second `gh pr create`.

import {
  canonicalGitHubPullRequestUrl,
  parseGitHubPullRequestUrl,
  type ChatPullRequestCreateIntent,
  type ChatPullRequestRef,
} from "../../renderer/shared/chat-pull-requests.js";
import type { GitHubPullRequestService, GitHubPullRequestSummary } from "./github-pull-request.js";

export interface PullRequestCreateCandidate {
  ref: ChatPullRequestRef;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  headSha?: string;
}

export type PullRequestCreateReconciliation =
  | { kind: "adopted"; pullRequest: GitHubPullRequestSummary }
  | { kind: "none" }
  | { kind: "multiple"; candidates: PullRequestCreateCandidate[] }
  | { kind: "unavailable"; message: string };

function matchesIntent(
  intent: ChatPullRequestCreateIntent,
  summary: GitHubPullRequestSummary,
): boolean {
  const ref = parseGitHubPullRequestUrl(summary.url);
  if (!ref) return false;
  if (ref.repository !== intent.repository || ref.host !== intent.host) return false;
  if (summary.headBranch !== intent.headBranch) return false;
  // When we recorded the exact head SHA we pushed, a PR whose head still points
  // at that commit is ours; a different head means someone else's PR on the
  // same branch name — not adoptable.
  if (intent.expectedHeadSha && summary.headSha && summary.headSha !== intent.expectedHeadSha) {
    return false;
  }
  return true;
}

function toCandidate(summary: GitHubPullRequestSummary): PullRequestCreateCandidate | undefined {
  const ref = parseGitHubPullRequestUrl(summary.url);
  if (!ref) return undefined;
  return {
    ref,
    url: summary.url || canonicalGitHubPullRequestUrl(ref),
    title: summary.title,
    state: summary.state,
    ...(summary.headSha ? { headSha: summary.headSha } : {}),
  };
}

export type ReconciliationGitHub = Pick<
  GitHubPullRequestService,
  "findForBranch" | "getPullRequest"
>;

/**
 * Query GitHub for pull requests the unknown-outcome create may have produced.
 * Pure query + classification: persisting links and clearing the intent are
 * the caller's job once the caller knows the outcome.
 */
export async function reconcilePullRequestCreate(options: {
  github: ReconciliationGitHub;
  cwd: string;
  intent: ChatPullRequestCreateIntent;
  signal?: AbortSignal;
}): Promise<PullRequestCreateReconciliation> {
  const { github, cwd, intent, signal } = options;
  const found = await github.findForBranch(cwd, intent.headBranch, signal);
  if (found.availability !== "ready" || !found.pullRequests) {
    return {
      kind: "unavailable",
      message:
        found.message ?? "Could not check GitHub for the pull request that may have been created.",
    };
  }
  const matching = found.pullRequests.filter((summary) => matchesIntent(intent, summary));
  if (matching.length === 0) return { kind: "none" };
  // A closed/merged match on the branch is still adoption-worthy — the create
  // may have landed and the PR changed state meanwhile.
  if (matching.length === 1) return { kind: "adopted", pullRequest: matching[0] };
  const candidates = matching
    .map(toCandidate)
    .filter((candidate): candidate is PullRequestCreateCandidate => candidate !== undefined);
  return { kind: "multiple", candidates };
}

/** Whether a candidate ref belongs to the repository the intent targets. */
export function intentMatchesRef(
  intent: ChatPullRequestCreateIntent,
  ref: ChatPullRequestRef,
): boolean {
  return intent.host === ref.host && intent.repository === ref.repository;
}
