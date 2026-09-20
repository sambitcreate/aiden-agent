// Unknown-outcome reconciliation for `gh pr create`: adopt exactly one match,
// allow a safe retry on none, never guess on multiple, stay pending when the
// lookup itself is unavailable.

import assert from "node:assert/strict";
import test from "node:test";
import type { ChatPullRequestCreateIntent } from "../../renderer/shared/chat-pull-requests.js";
import {
  reconcilePullRequestCreate,
  intentMatchesRef,
  type ReconciliationGitHub,
} from "./pull-request-create-reconciliation.js";
import type { GitHubPullRequestListStatus, GitHubPullRequestSummary } from "./types.js";

const INTENT: ChatPullRequestCreateIntent = {
  operationId: "op-1",
  host: "github.com",
  repository: "owner/repo",
  headBranch: "feature/x",
  baseBranch: "main",
  expectedHeadSha: "a".repeat(40),
  title: "Add x",
  requestedAt: 1_700,
};

function summary(number: number, overrides: Partial<GitHubPullRequestSummary> = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/owner/repo/pull/${number}`,
    state: "open" as const,
    headBranch: "feature/x",
    baseBranch: "main",
    headSha: "a".repeat(40),
    checks: [],
    ...overrides,
  };
}

function github(list: GitHubPullRequestListStatus): ReconciliationGitHub {
  return {
    findForBranch: async () => list,
    getPullRequest: async () => ({
      availability: "no-pull-request",
      message: "not found",
    }),
  };
}

test("zero matching PRs means the create never landed — safe to retry", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({ availability: "ready", pullRequests: [] }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "none");
});

test("exactly one matching PR is adopted", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({ availability: "ready", pullRequests: [summary(42)] }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "adopted");
  if (outcome.kind === "adopted") assert.equal(outcome.pullRequest.number, 42);
});

test("multiple matching PRs are returned for the user instead of guessed", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({ availability: "ready", pullRequests: [summary(1), summary(2)] }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "multiple");
  if (outcome.kind === "multiple") {
    assert.deepEqual(
      outcome.candidates.map((candidate) => candidate.ref.number),
      [1, 2],
    );
  }
});

test("a matching branch but different head SHA is not adopted", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({
      availability: "ready",
      pullRequests: [summary(9, { headSha: "b".repeat(40) })],
    }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "none");
});

test("PRs on the same branch name in another repository do not match", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({
      availability: "ready",
      pullRequests: [
        summary(9, { url: "https://github.com/other/repo/pull/9" }),
        summary(10, { url: "https://github.com/owner/repo/pull/10" }),
      ],
    }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "adopted");
  if (outcome.kind === "adopted") assert.equal(outcome.pullRequest.number, 10);
});

test("an unavailable GitHub lookup keeps the intent pending", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({ availability: "unauthenticated", message: "gh auth login required" }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "unavailable");
});

test("intentMatchesRef compares host + repository only", () => {
  assert.equal(
    intentMatchesRef(INTENT, { host: "github.com", repository: "owner/repo", number: 7 }),
    true,
  );
  assert.equal(
    intentMatchesRef(INTENT, { host: "ghe.example.com", repository: "owner/repo", number: 7 }),
    false,
  );
});
