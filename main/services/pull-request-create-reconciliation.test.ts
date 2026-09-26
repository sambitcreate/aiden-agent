// Unknown-outcome reconciliation for `gh pr create`: adopt exactly one match,
// report absence without proving non-creation, never guess on multiple, stay pending when the
// lookup itself is unavailable.

import assert from "node:assert/strict";
import test from "node:test";
import type { ChatPullRequestCreateIntent } from "../../renderer/shared/chat-pull-requests.js";
import {
  reconcilePullRequestCreate,
  intentMatchesRef,
  type ReconciliationGitHub,
} from "./pull-request-create-reconciliation.js";
import type {
  GitHubPullRequestListStatus,
  GitHubPullRequestSummary,
} from "./types.js";

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

function summary(
  number: number,
  overrides: Partial<GitHubPullRequestSummary> = {},
) {
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

test("zero matching PRs reports only that the lookup currently has no candidates", async () => {
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
    github: github({
      availability: "ready",
      pullRequests: [summary(1), summary(2)],
    }),
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

test("a matching branch with an advanced head stays unresolved", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({
      availability: "ready",
      pullRequests: [summary(9, { headSha: "b".repeat(40) })],
    }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "multiple");
});

test("a matching head branch targeting another base branch is not adopted", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({
      availability: "ready",
      pullRequests: [summary(9, { baseBranch: "release" })],
    }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "none");
});

test("a candidate whose head SHA cannot be read stays unresolved for the user", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({
      availability: "ready",
      pullRequests: [summary(9, { headSha: undefined })],
    }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "multiple");
  if (outcome.kind === "multiple") {
    assert.deepEqual(
      outcome.candidates.map((candidate) => candidate.ref.number),
      [9],
    );
  }
});

test("a verified match is not adopted while a sibling's head SHA is unreadable", async () => {
  const outcome = await reconcilePullRequestCreate({
    github: github({
      availability: "ready",
      pullRequests: [summary(1), summary(9, { headSha: undefined })],
    }),
    cwd: "/work",
    intent: INTENT,
  });
  // The unreadable PR could itself be the timed-out create — the user picks.
  assert.equal(outcome.kind, "multiple");
  if (outcome.kind === "multiple") {
    assert.deepEqual(
      outcome.candidates.map((candidate) => candidate.ref.number),
      [1, 9],
    );
  }
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
    github: github({
      availability: "unauthenticated",
      message: "gh auth login required",
    }),
    cwd: "/work",
    intent: INTENT,
  });
  assert.equal(outcome.kind, "unavailable");
});

test("intentMatchesRef compares host + repository only", () => {
  assert.equal(
    intentMatchesRef(INTENT, {
      host: "github.com",
      repository: "owner/repo",
      number: 7,
    }),
    true,
  );
  assert.equal(
    intentMatchesRef(INTENT, {
      host: "ghe.example.com",
      repository: "owner/repo",
      number: 7,
    }),
    false,
  );
});

test("malformed expectations stay unavailable without querying GitHub", async () => {
  const outcome = await reconcilePullRequestCreate({
    cwd: "/other-repo",
    intent: { ...INTENT, expectedHeadSha: "invalid" },
    github: {
      ...github({ availability: "ready", pullRequests: [summary(1)] }),
      findForBranch: async () => {
        throw new Error("must not query");
      },
    },
  });
  assert.equal(outcome.kind, "unavailable");
});

test("reconciliation pins its lookup to the durable repository after workspace changes", async () => {
  const outcome = await reconcilePullRequestCreate({
    cwd: "/other-repo",
    intent: INTENT,
    github: {
      ...github({ availability: "ready", pullRequests: [] }),
      findForBranch: async (_cwd, _branch, _signal, repository) => {
        assert.equal(repository, "github.com/owner/repo");
        return { availability: "ready", pullRequests: [summary(1)] };
      },
    },
  });
  assert.equal(outcome.kind, "adopted");
});
