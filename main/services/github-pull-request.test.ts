import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubPullRequestService,
  dedupeGitHubChecks,
  githubCliEnvironment,
  normalizeGitHubCheckStatus,
  parseGitHubPullRequest,
  rollupGitHubChecksState,
} from "./github-pull-request.js";

test("normalizes GitHub status checks and conclusions", () => {
  assert.equal(normalizeGitHubCheckStatus({ status: "IN_PROGRESS" }), "pending");
  assert.equal(normalizeGitHubCheckStatus({ conclusion: "SUCCESS" }), "success");
  assert.equal(normalizeGitHubCheckStatus({ conclusion: "ACTION_REQUIRED" }), "action-required");
  assert.equal(normalizeGitHubCheckStatus({ conclusion: "TIMED_OUT" }), "failure");
  assert.equal(normalizeGitHubCheckStatus({ conclusion: "CANCELLED" }), "cancelled");
  assert.equal(normalizeGitHubCheckStatus({ conclusion: "SKIPPED" }), "skipped");
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

  assert.deepEqual(checks.map((check) => [check.name, check.status, check.url]), [
    ["test", "pending", "https://example.test/new"],
    ["lint", "success", undefined],
  ]);
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

  for (const rawChecks of [[completedFailure, queuedRerun], [queuedRerun, completedFailure]]) {
    const checks = dedupeGitHubChecks(rawChecks);
    assert.deepEqual(checks.map((check) => [check.name, check.status]), [["test", "pending"]]);
  }
});

test("qualifies same-named checks from different workflows", () => {
  const checks = dedupeGitHubChecks([
    { name: "test", workflowName: "macOS", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z" },
    { name: "test", workflowName: "Linux", conclusion: "FAILURE", startedAt: "2026-01-01T00:00:01Z" },
  ]);

  assert.deepEqual(checks.map((check) => check.name), ["macOS / test", "Linux / test"]);
  assert.equal(rollupGitHubChecksState(checks), "failing");
});

test("rollup treats no checks as absent instead of passing", () => {
  assert.equal(rollupGitHubChecksState([]), null);
  assert.equal(rollupGitHubChecksState([{ name: "lint", status: "success" }]), "passing");
  assert.equal(rollupGitHubChecksState([{ name: "lint", status: "action-required" }]), "pending");
  assert.equal(rollupGitHubChecksState([{ name: "lint", status: "failure" }]), "failing");
});

test("parses gh pr view statusCheckRollup into the renderer-safe summary", () => {
  const pr = parseGitHubPullRequest(JSON.stringify({
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
          { name: "typecheck", conclusion: "SUCCESS", detailsUrl: "https://example.test/typecheck" },
          { context: "test", conclusion: "FAILURE", description: "Unit tests failed" },
        ],
      },
    },
  }));

  assert.equal(pr.number, 42);
  assert.equal(pr.state, "open");
  assert.equal(pr.checksState, "failing");
  assert.deepEqual(pr.checks.map((check) => [check.name, check.status, check.description, check.url]), [
    ["typecheck", "success", undefined, "https://example.test/typecheck"],
    ["test", "failure", "Unit tests failed", undefined],
  ]);
});

test("parses flat statusCheckRollup contexts and drops unsafe URLs", () => {
  const pr = parseGitHubPullRequest(JSON.stringify({
    number: 43,
    title: "Flattened checks",
    url: "https://github.com/acme/app/pull/43",
    state: "OPEN",
    headRefName: "feature/flat",
    baseRefName: "main",
    statusCheckRollup: {
      contexts: [
        { name: "safe", conclusion: "SUCCESS", detailsUrl: "https://checks.example.test/run" },
        { name: "unsafe", conclusion: "FAILURE", detailsUrl: "javascript:alert(1)" },
        { name: "credentials", conclusion: "SUCCESS", detailsUrl: "https://user:pass@example.test/run" },
      ],
    },
  }));

  assert.deepEqual(pr.checks.map((check) => [check.name, check.status, check.url]), [
    ["safe", "success", "https://checks.example.test/run"],
    ["unsafe", "failure", undefined],
    ["credentials", "success", undefined],
  ]);
});

test("sanitizes check text before dedupe keys and renderer output", () => {
  const checks = dedupeGitHubChecks([
    { workflowName: "A", name: "B\u0000C", conclusion: "FAILURE", startedAt: "2026-01-01T00:00:00Z" },
    { workflowName: "A\u0000B", name: "C", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:01Z" },
  ]);

  assert.deepEqual(checks.map((check) => [check.name, check.status]), [
    ["B C", "failure"],
    ["C", "success"],
  ]);
  assert.equal(rollupGitHubChecksState(checks), "failing");
});

test("rollup uses every check even when the renderer row list is capped", () => {
  const checks = Array.from({ length: 101 }, (_, index) => ({
    name: `check-${index}`,
    conclusion: index === 100 ? "FAILURE" : "SUCCESS",
  }));
  const pr = parseGitHubPullRequest(JSON.stringify({
    number: 44,
    title: "Many checks",
    url: "https://github.com/acme/app/pull/44",
    state: "OPEN",
    headRefName: "feature/many-checks",
    baseRefName: "main",
    statusCheckRollup: checks,
  }));

  assert.equal(pr.checks.length, 100);
  assert.equal(pr.checksState, "failing");
});

test("service returns actionable availability states for common gh failures", async () => {
  const missing = new GitHubPullRequestService({
    runner: async () => {
      const error = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.deepEqual(await missing.currentPullRequest("/repo"), {
    availability: "missing-tool",
    message: "Install GitHub CLI, then run `gh auth login`.",
  });

  const noPr = new GitHubPullRequestService({
    runner: async () => {
      const error = new Error("no pull requests found for branch");
      throw error;
    },
  });
  assert.deepEqual(await noPr.currentPullRequest("/repo"), {
    availability: "no-pull-request",
    message: "No GitHub pull request is linked to the current branch.",
  });

  const unauthenticated = new GitHubPullRequestService({
    runner: async () => {
      throw new Error("authentication required; run gh auth login");
    },
  });
  assert.deepEqual(await unauthenticated.currentPullRequest("/repo"), {
    availability: "unauthenticated",
    message: "Run `gh auth login` on this Mac, then refresh source control.",
  });

  const unsupported = new GitHubPullRequestService({
    runner: async () => {
      throw new Error("unknown JSON field: statusCheckRollup; available fields are number,title");
    },
  });
  assert.deepEqual(await unsupported.currentPullRequest("/repo"), {
    availability: "unsupported",
    message: "Update GitHub CLI so Aiden can read pull request status.",
  });

  const nonGitHubRemote = new GitHubPullRequestService({
    runner: async () => {
      throw new Error(
        "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`",
      );
    },
  });
  assert.deepEqual(await nonGitHubRemote.currentPullRequest("/repo"), {
    availability: "not-github",
    message: "This repository's remote is not hosted on GitHub.",
  });
});

test("service redacts credentials and workspace paths from renderer-facing failures", async () => {
  const service = new GitHubPullRequestService({
    runner: async () => {
      throw new Error(
        "Command failed: /opt/homebrew/bin/gh pr view in /Users/alice/project with https://alice:secret-token@example.test/repo?access_token=also-secret&private_token=hidden",
      );
    },
  });

  const result = await service.currentPullRequest("/Users/alice/project");
  assert.equal(result.availability, "error");
  assert.ok(result.message?.includes("the workspace"));
  assert.ok(result.message?.includes("https://***@example.test/repo?access_token=***&private_token=***"));
  assert.doesNotMatch(result.message ?? "", /secret-token|also-secret|hidden|\/Users\/alice\/project|\/opt\/homebrew\/bin\/gh/u);
});

test("service reports subprocess timeouts with the configured timeout", async () => {
  const service = new GitHubPullRequestService({
    timeoutMs: 2_500,
    runner: async () => {
      const error = new Error("Command failed: gh pr view") as Error & { killed: boolean };
      error.killed = true;
      throw error;
    },
  });

  assert.deepEqual(await service.currentPullRequest("/repo"), {
    availability: "error",
    message: "GitHub CLI did not answer within 3 seconds.",
  });
});

test("service rethrows aborted reads instead of caching them as GitHub errors", async () => {
  const service = new GitHubPullRequestService({
    runner: async () => {
      const error = new Error("The operation was aborted") as Error & { code: string; name: string };
      error.code = "ABORT_ERR";
      error.name = "AbortError";
      throw error;
    },
  });

  await assert.rejects(() => service.currentPullRequest("/repo"), /aborted/u);
});

test("service resolves a GitHub CLI binary before invoking the runner", async () => {
  let observedBinary = "";
  const service = new GitHubPullRequestService({
    resolveBinary: async () => "/opt/homebrew/bin/gh",
    runner: async (_cwd, _args, options) => {
      observedBinary = options.binary;
      return {
        stderr: "",
        stdout: JSON.stringify({
          number: 1,
          title: "Ready",
          url: "https://github.com/acme/app/pull/1",
          state: "OPEN",
          headRefName: "feature/ready",
          baseRefName: "main",
          statusCheckRollup: [],
        }),
      };
    },
  });

  assert.equal((await service.currentPullRequest("/repo")).availability, "ready");
  assert.equal(observedBinary, "/opt/homebrew/bin/gh");
});

test("GitHub CLI environment removes Git routing while preserving noninteractive auth lookup", () => {
  const previous = { ...process.env };
  try {
    process.env.GIT_DIR = "/tmp/wrong.git";
    process.env.GIT_WORK_TREE = "/tmp/wrong-worktree";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_PARAMETERS = "'core.sshCommand=bad'";
    process.env.GIT_CONFIG_KEY_0 = "remote.origin.url";
    process.env.GIT_CONFIG_VALUE_0 = "https://example.test/repo";
    process.env.GH_TOKEN = "kept-for-gh";
    const env = githubCliEnvironment();
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_WORK_TREE, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.LANG, "C");
    assert.equal(env.LC_ALL, "C");
    assert.equal(env.GH_TOKEN, "kept-for-gh");
  } finally {
    process.env = previous;
  }
});
