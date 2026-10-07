import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApi } from "./github/github-api.js";
import { FakeGitHub, type FakePullRequest } from "./github/github-fake-server.js";
import type { LocalGitHubRepository, LocalRepositoryResult } from "./github/github-local-repository.js";
import { DirectPullRequestReader } from "./github/github-pull-request-graphql.js";
import { GitHubRateLimitGate } from "./github/github-request-gate.js";
import { fixedCredentials, jsonResponse, recordingFetch } from "./github/github-test-fetch.js";
import {
  GitHubPullRequestService,
  dedupeGitHubChecks,
  githubCliEnvironment,
  normalizeGitHubCheckStatus,
  parseGitHubPullRequest,
  rollupGitHubChecksState,
} from "./github-pull-request.js";

test("normalizes GitHub status checks and conclusions", () => {
  assert.equal(
    normalizeGitHubCheckStatus({ status: "IN_PROGRESS" }),
    "pending",
  );
  assert.equal(
    normalizeGitHubCheckStatus({ conclusion: "SUCCESS" }),
    "success",
  );
  assert.equal(
    normalizeGitHubCheckStatus({ conclusion: "ACTION_REQUIRED" }),
    "action-required",
  );
  assert.equal(
    normalizeGitHubCheckStatus({ conclusion: "TIMED_OUT" }),
    "failure",
  );
  assert.equal(
    normalizeGitHubCheckStatus({ conclusion: "CANCELLED" }),
    "cancelled",
  );
  assert.equal(
    normalizeGitHubCheckStatus({ conclusion: "SKIPPED" }),
    "skipped",
  );
  assert.equal(normalizeGitHubCheckStatus({ state: "EXPECTED" }), "pending");
  assert.equal(normalizeGitHubCheckStatus({ conclusion: "STALE" }), "neutral");
});

test("dedupes rerun checks by workflow and check name while preserving row position", () => {
  const checks = dedupeGitHubChecks([
    {
      name: "test",
      workflowName: "CI",
      conclusion: "FAILURE",
      startedAt: "2026-01-01T00:00:00Z",
      detailsUrl: "https://example.test/old",
    },
    {
      name: "lint",
      workflowName: "CI",
      conclusion: "SUCCESS",
      startedAt: "2026-01-01T00:00:01Z",
    },
    {
      name: "test",
      workflowName: "CI",
      status: "IN_PROGRESS",
      startedAt: "2026-01-01T00:00:02Z",
      detailsUrl: "https://example.test/new",
    },
  ]);

  assert.deepEqual(
    checks.map((check) => [check.name, check.status, check.url]),
    [
      ["test", "pending", "https://example.test/new"],
      ["lint", "success", undefined],
    ],
  );
});

test("queued reruns replace older completed failures before timestamps regardless of rollup order", () => {
  const completedFailure = {
    name: "test",
    workflowName: "CI",
    conclusion: "FAILURE",
    completedAt: "2026-01-01T00:00:00Z",
  };
  const queuedRerun = {
    name: "test",
    workflowName: "CI",
    status: "QUEUED",
  };

  for (const rawChecks of [
    [completedFailure, queuedRerun],
    [queuedRerun, completedFailure],
  ]) {
    const checks = dedupeGitHubChecks(rawChecks);
    assert.deepEqual(
      checks.map((check) => [check.name, check.status]),
      [["test", "pending"]],
    );
  }
});

test("qualifies same-named checks from different workflows", () => {
  const checks = dedupeGitHubChecks([
    {
      name: "test",
      workflowName: "macOS",
      conclusion: "SUCCESS",
      startedAt: "2026-01-01T00:00:00Z",
    },
    {
      name: "test",
      workflowName: "Linux",
      conclusion: "FAILURE",
      startedAt: "2026-01-01T00:00:01Z",
    },
  ]);

  assert.deepEqual(
    checks.map((check) => check.name),
    ["macOS / test", "Linux / test"],
  );
  assert.equal(rollupGitHubChecksState(checks), "failing");
});

test("rollup treats no checks as absent and cancelled checks as non-passing", () => {
  assert.equal(rollupGitHubChecksState([]), null);
  assert.equal(
    rollupGitHubChecksState([{ name: "lint", status: "success" }]),
    "passing",
  );
  assert.equal(
    rollupGitHubChecksState([{ name: "lint", status: "action-required" }]),
    "pending",
  );
  assert.equal(
    rollupGitHubChecksState([{ name: "lint", status: "failure" }]),
    "failing",
  );
  assert.equal(
    rollupGitHubChecksState([{ name: "lint", status: "cancelled" }]),
    "failing",
  );
  assert.equal(
    rollupGitHubChecksState([
      { name: "lint", status: "success" },
      { name: "test", status: "cancelled" },
    ]),
    "failing",
  );
});

test("parses gh pr view statusCheckRollup into the renderer-safe summary", () => {
  const pr = parseGitHubPullRequest(
    JSON.stringify({
      number: 42,
      title: "Add source control checks",
      url: "https://github.com/acme/app/pull/42",
      state: "OPEN",
      isDraft: false,
      headRefName: "feature/source-control",
      baseRefName: "main",
      statusCheckRollup: {
        contexts: {
          nodes: [
            {
              name: "typecheck",
              conclusion: "SUCCESS",
              detailsUrl: "https://example.test/typecheck",
            },
            {
              context: "test",
              conclusion: "FAILURE",
              description: "Unit tests failed",
            },
          ],
        },
      },
    }),
  );

  assert.equal(pr.number, 42);
  assert.equal(pr.state, "open");
  assert.equal(pr.checksState, "failing");
  assert.deepEqual(
    pr.checks.map((check) => [
      check.name,
      check.status,
      check.description,
      check.url,
    ]),
    [
      ["typecheck", "success", undefined, "https://example.test/typecheck"],
      ["test", "failure", "Unit tests failed", undefined],
    ],
  );
});

test("parses flat statusCheckRollup contexts and drops unsafe URLs", () => {
  const pr = parseGitHubPullRequest(
    JSON.stringify({
      number: 43,
      title: "Flattened checks",
      url: "https://github.com/acme/app/pull/43",
      state: "OPEN",
      headRefName: "feature/flat",
      baseRefName: "main",
      statusCheckRollup: {
        contexts: [
          {
            name: "safe",
            conclusion: "SUCCESS",
            detailsUrl: "https://checks.example.test/run",
          },
          {
            name: "unsafe",
            conclusion: "FAILURE",
            detailsUrl: "javascript:alert(1)",
          },
          {
            name: "credentials",
            conclusion: "SUCCESS",
            detailsUrl: "https://user:pass@example.test/run",
          },
        ],
      },
    }),
  );

  assert.deepEqual(
    pr.checks.map((check) => [check.name, check.status, check.url]),
    [
      ["safe", "success", "https://checks.example.test/run"],
      ["unsafe", "failure", undefined],
      ["credentials", "success", undefined],
    ],
  );
});

test("sanitizes check text before dedupe keys and renderer output", () => {
  const checks = dedupeGitHubChecks([
    {
      workflowName: "A",
      name: "B\u0000C",
      conclusion: "FAILURE",
      startedAt: "2026-01-01T00:00:00Z",
    },
    {
      workflowName: "A\u0000B",
      name: "C",
      conclusion: "SUCCESS",
      startedAt: "2026-01-01T00:00:01Z",
    },
  ]);

  assert.deepEqual(
    checks.map((check) => [check.name, check.status]),
    [
      ["B C", "failure"],
      ["C", "success"],
    ],
  );
  assert.equal(rollupGitHubChecksState(checks), "failing");
});

test("rollup uses every check even when the renderer row list is capped", () => {
  const checks = Array.from({ length: 101 }, (_, index) => ({
    name: `check-${index}`,
    conclusion: index === 100 ? "FAILURE" : "SUCCESS",
  }));
  const pr = parseGitHubPullRequest(
    JSON.stringify({
      number: 44,
      title: "Many checks",
      url: "https://github.com/acme/app/pull/44",
      state: "OPEN",
      headRefName: "feature/many-checks",
      baseRefName: "main",
      statusCheckRollup: checks,
    }),
  );

  assert.equal(pr.checks.length, 100);
  assert.equal(pr.checksState, "failing");
});

const T0 = Date.parse("2026-10-07T12:00:00Z");

function pr(overrides: Partial<FakePullRequest> & Pick<FakePullRequest, "number">): FakePullRequest {
  return {
    repository: "acme/app",
    title: `Change ${overrides.number}`,
    state: "OPEN",
    headRefName: "feature/login",
    baseRefName: "main",
    headRefOid: "a".repeat(40),
    headOwner: "acme",
    checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    createdAt: T0 - overrides.number * 1_000,
    updatedAt: T0 - overrides.number * 1_000,
    ...overrides,
  };
}

function setup(options: {
  pullRequests?: FakePullRequest[];
  local?: Partial<LocalGitHubRepository> | LocalRepositoryResult;
  tokens?: Record<string, string>;
  runner?: ConstructorParameters<typeof GitHubPullRequestService>[0]["runner"];
} = {}) {
  let now = T0;
  const github = new FakeGitHub({ repositories: ["acme/app", "me/app"], pullRequests: options.pullRequests ?? [], now: () => now });
  const recorded = recordingFetch(github.responder);
  const gate = new GitHubRateLimitGate({ now: () => now });
  const api = new GitHubApi({
    credentials: fixedCredentials(options.tokens ?? { "github.com": "token-a" }),
    gate,
    fetch: recorded.fetch,
    now: () => now,
  });
  const local: LocalRepositoryResult =
    options.local && "ok" in options.local
      ? options.local
      : {
          ok: true,
          repository: {
            host: "github.com",
            owner: "acme",
            name: "app",
            branch: "feature/login",
            headBranch: "feature/login",
            headOwner: "acme",
            ...(options.local as Partial<LocalGitHubRepository> | undefined),
          },
        };
  const service = new GitHubPullRequestService({
    reader: new DirectPullRequestReader(api),
    repositories: { resolve: async () => local },
    resolveBinary: async () => "gh",
    ...(options.runner ? { runner: options.runner } : {}),
  });
  return { service, github, requests: recorded.requests, advance: (ms: number) => (now += ms) };
}

test("the current branch's pull request is read from GitHub's API without gh", async () => {
  const { service, requests } = setup({ pullRequests: [pr({ number: 7 })] });

  const status = await service.currentPullRequest("/repo");

  assert.equal(status.availability, "ready");
  assert.equal(status.pullRequest?.number, 7);
  assert.equal(status.pullRequest?.checksState, "passing");
  assert.equal(status.pullRequest?.url, "https://github.com/acme/app/pull/7");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.github.com/graphql");
  assert.equal(requests[0]!.headers.Authorization, "Bearer token-a");
  assert.deepEqual(requests[0]!.json?.variables, { o0: "acme", n0: "app", h0: "feature/login" });
});

test("current branch lookup ignores same-named branches from other forks and prefers open PRs", async () => {
  const { service } = setup({
    local: { headOwner: "me" },
    pullRequests: [
      pr({ number: 1, headOwner: "someone-else", createdAt: T0 }),
      pr({ number: 2, headOwner: "me", state: "CLOSED", createdAt: T0 - 10 }),
      pr({ number: 3, headOwner: "me", state: "OPEN", createdAt: T0 - 20 }),
    ],
  });
  assert.equal((await service.currentPullRequest("/repo")).pullRequest?.number, 3);
});

test("a branch with no pull request and a detached HEAD are both no-pull-request", async () => {
  const none = setup();
  assert.equal((await none.service.currentPullRequest("/repo")).availability, "no-pull-request");
  const detached = setup({ local: { branch: undefined, headBranch: undefined } });
  assert.equal((await detached.service.currentPullRequest("/repo")).availability, "no-pull-request");
  assert.equal(detached.requests.length, 0);
});

test("local repository failures surface without calling GitHub", async () => {
  const { service, requests } = setup({
    local: { ok: false, availability: "not-github", message: "This repository's remote is not hosted on GitHub." },
  });
  assert.deepEqual(await service.currentPullRequest("/repo"), {
    availability: "not-github",
    message: "This repository's remote is not hosted on GitHub.",
  });
  assert.equal(requests.length, 0);
});

test("a missing credential and a rejected credential map to unauthenticated", async () => {
  const missing = setup({ tokens: {} });
  assert.equal((await missing.service.currentPullRequest("/repo")).availability, "unauthenticated");
  assert.equal(missing.requests.length, 0);

  const rejected = setup();
  rejected.github.script = () => jsonResponse({ message: "Bad credentials" }, 401);
  const status = await rejected.service.currentPullRequest("/repo");
  assert.equal(status.availability, "unauthenticated");
  assert.match(status.message ?? "", /gh auth login --hostname github\.com/u);
});

test("a rate limit reports when reads resume and later reads wait for it locally", async () => {
  const { service, github, requests, advance } = setup({ pullRequests: [pr({ number: 7 })] });
  const resetSeconds = Math.floor((T0 + 15 * 60_000) / 1000);
  github.script = () =>
    jsonResponse({ message: "API rate limit exceeded" }, 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(resetSeconds),
    });

  const limited = await service.currentPullRequest("/repo");
  assert.equal(limited.availability, "rate-limited");
  assert.equal(limited.retryAt, resetSeconds * 1000);

  github.script = undefined;
  advance(60_000);
  const stillPaused = await service.getPullRequest("/repo", "acme/app", 7, undefined, { interactive: true });
  assert.equal(stillPaused.availability, "rate-limited");
  assert.equal(stillPaused.retryAt, resetSeconds * 1000);
  assert.equal(requests.length, 1);

  advance(15 * 60_000);
  assert.equal((await service.currentPullRequest("/repo")).availability, "ready");
  assert.equal(requests.length, 2);
});

test("explicit selectors read the named repository, including on enterprise hosts", async () => {
  const { service, requests } = setup({
    tokens: { "github.com": "token-a", "ghe.example": "token-b" },
    pullRequests: [pr({ number: 9, repository: "me/app" })],
  });

  const repository = await service.resolveRepository("/repo", undefined, "github.com/me/app");
  assert.deepEqual(repository, { availability: "ready", repository: { host: "github.com", nameWithOwner: "me/app" } });
  const found = await service.findForBranch("/repo", "feature/login", undefined, "github.com/me/app");
  assert.deepEqual(found.pullRequests?.map((entry) => entry.number), [9]);
  await service.getPullRequest("/repo", "ghe.example/acme/app", 1);
  assert.equal(requests.at(-1)!.url, "https://ghe.example/api/graphql");
  assert.equal(requests.at(-1)!.headers.Authorization, "Bearer token-b");
});

test("a pasted URL is read by its repository and number; unknown PRs are errors", async () => {
  const { service, requests } = setup({ pullRequests: [pr({ number: 7 })] });
  const found = await service.getPullRequestByUrl("/repo", "https://github.com/Acme/App/pull/7");
  assert.equal(found.pullRequest?.url, "https://github.com/acme/app/pull/7");
  const missing = await service.getPullRequestByUrl("/repo", "https://github.com/acme/app/pull/404");
  assert.deepEqual(missing, { availability: "error", message: "GitHub could not find pull request #404 in acme/app." });
  assert.equal((await service.getPullRequestByUrl("/repo", "not a url")).availability, "error");
  assert.equal((await service.getPullRequestByUrl("/repo", "https://unknown.example/acme/app/pull/7")).availability, "unauthenticated");
  assert.equal(requests.length, 2);
});

test("a truncated branch listing is unavailable for reconciliation", async () => {
  const { service } = setup({
    pullRequests: Array.from({ length: 30 }, (_, index) => pr({ number: index + 1, state: "CLOSED" })),
  });
  assert.equal((await service.findForBranch("/workspace", "feature/login")).availability, "error");
});

test("the chooser list filters by state and caps the page", async () => {
  const { service } = setup({
    pullRequests: [
      pr({ number: 1, headRefName: "a" }),
      pr({ number: 2, headRefName: "b", state: "MERGED" }),
      pr({ number: 3, headRefName: "c" }),
    ],
  });
  const open = await service.listPullRequests("/repo", { state: "open", limit: 1 });
  assert.deepEqual(open.pullRequests?.map((entry) => entry.number), [1]);
  const merged = await service.listPullRequests("/repo", { state: "merged", headBranch: "b" });
  assert.deepEqual(merged.pullRequests?.map((entry) => entry.number), [2]);
});

test("creation shells out to gh with the explicit repository and reads the PR back from the API", async () => {
  const calls: string[][] = [];
  const { service, github } = setup({
    runner: async (_cwd, args) => {
      calls.push(args);
      github.pullRequests.push(pr({ number: 12, repository: "me/app" }));
      return { stdout: "https://github.com/me/app/pull/12\n", stderr: "" };
    },
  });
  const result = await service.createPullRequest("/workspace", {
    title: "Title",
    headBranch: "feature/login",
    repository: "github.com/me/app",
  });
  assert.equal(result.kind, "created");
  assert.equal(result.kind === "created" && result.pullRequest.number, 12);
  assert.deepEqual(calls[0]!.slice(-2), ["-R", "github.com/me/app"]);
});

test("ambiguous create failures are unknown; missing tools are definite failures", async () => {
  const timedOut = setup({
    runner: async () => {
      throw Object.assign(new Error("Command failed: gh pr create"), { killed: true });
    },
  });
  assert.equal((await timedOut.service.createPullRequest("/repo", { title: "T" })).kind, "unknown");

  const missing = setup({
    runner: async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    },
  });
  const result = await missing.service.createPullRequest("/repo", { title: "T" });
  assert.equal(result.kind === "failed" && result.availability, "missing-tool");
});

test("create failures shown to the renderer drop credentials and workspace paths", async () => {
  const { service } = setup({
    runner: async () => {
      throw new Error(
        "Command failed: /opt/homebrew/bin/gh pr create in /Users/alice/project with https://alice:secret-token@example.test/repo?access_token=also-secret",
      );
    },
  });
  const result = await service.createPullRequest("/Users/alice/project", { title: "T" });
  assert.equal(result.kind, "unknown");
  assert.doesNotMatch(
    result.kind === "unknown" ? result.message : "",
    /secret-token|also-secret|\/Users\/alice\/project|\/opt\/homebrew\/bin\/gh/u,
  );
});

test("aborted reads reject instead of becoming GitHub errors", async () => {
  const { service } = setup({ pullRequests: [pr({ number: 7 })] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => service.currentPullRequest("/repo", controller.signal), /aborted/u);
});

test("GitHub CLI environment removes Git routing while preserving noninteractive auth lookup", () => {
  const previous = { ...process.env };
  try {
    process.env.GIT_DIR = "/tmp/wrong.git";
    process.env.GH_HOST = "github.example.test";
    process.env.GH_TOKEN = "kept-for-gh";
    const env = githubCliEnvironment();
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GH_HOST, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GH_TOKEN, "kept-for-gh");
  } finally {
    process.env = previous;
  }
});
