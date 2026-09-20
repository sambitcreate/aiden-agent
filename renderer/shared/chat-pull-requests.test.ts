// Chat ↔ pull request shared contract: canonical identity parsing and
// record normalization bounds.

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHAT_PULL_REQUEST_LINKS,
  canonicalGitHubPullRequestUrl,
  isSafeChatPullRequestChatId,
  normalizeChatPullRequestCreateIntent,
  normalizeChatPullRequestLink,
  normalizeGitHubHost,
  normalizeGitHubRepositoryIdentity,
  parseGitHubPullRequestUrl,
  pullRequestRefKey,
} from "./chat-pull-requests";

test("parseGitHubPullRequestUrl resolves canonical host/repository/number", () => {
  const parsed = parseGitHubPullRequestUrl("https://github.com/Owner/Repo/pull/123");
  assert.deepEqual(parsed, {
    host: "github.com",
    repository: "owner/repo",
    number: 123,
  });
});

test("parseGitHubPullRequestUrl accepts GitHub Enterprise hosts", () => {
  const parsed = parseGitHubPullRequestUrl("https://ghe.example.com/Team/Service/pull/9");
  assert.deepEqual(parsed, {
    host: "ghe.example.com",
    repository: "team/service",
    number: 9,
  });
});

test("parseGitHubPullRequestUrl tolerates the /pulls/ listing path shape", () => {
  assert.deepEqual(parseGitHubPullRequestUrl("https://github.com/o/r/pulls/7"), {
    host: "github.com",
    repository: "o/r",
    number: 7,
  });
});

test("parseGitHubPullRequestUrl rejects non-pull-request shapes", () => {
  const rejected = [
    "https://github.com/owner/repo",
    "https://github.com/owner/repo/pull/abc",
    "https://github.com/owner/repo/pull/123/extra",
    "https://github.com/owner/repo/pull/0",
    "https://github.com/owner/repo/issues/12",
    "git@github.com:owner/repo/pull/12",
    "javascript://github.com/owner/repo/pull/1",
    "https://user:pw@github.com/owner/repo/pull/12",
    "",
    "not a url",
  ];
  for (const url of rejected) {
    assert.equal(parseGitHubPullRequestUrl(url), undefined, url);
  }
});

test("normalizeGitHubRepositoryIdentity lowercases and drops .git", () => {
  assert.equal(normalizeGitHubRepositoryIdentity("Owner/Repo.GIT"), "owner/repo");
  assert.equal(normalizeGitHubRepositoryIdentity("owner/repo"), "owner/repo");
  assert.equal(normalizeGitHubRepositoryIdentity("a/b/c"), undefined);
  assert.equal(normalizeGitHubRepositoryIdentity("no-slash"), undefined);
  assert.equal(normalizeGitHubRepositoryIdentity("bad owner/repo"), undefined);
  assert.equal(normalizeGitHubRepositoryIdentity("/repo"), undefined);
});

test("normalizeGitHubHost lowercases and bounds hostnames", () => {
  assert.equal(normalizeGitHubHost("GitHub.COM"), "github.com");
  assert.equal(normalizeGitHubHost("bad host"), undefined);
  assert.equal(normalizeGitHubHost("-leading.com"), undefined);
});

test("canonicalGitHubPullRequestUrl round-trips a parsed ref", () => {
  const ref = parseGitHubPullRequestUrl("https://github.com/owner/repo/pull/5");
  assert.ok(ref);
  assert.equal(canonicalGitHubPullRequestUrl(ref), "https://github.com/owner/repo/pull/5");
});

test("pullRequestRefKey identifies (host, repository, number)", () => {
  assert.equal(
    pullRequestRefKey({ host: "github.com", repository: "owner/repo", number: 3 }),
    "github.com/owner/repo#3",
  );
});

test("normalizeChatPullRequestLink bounds and deduplicates fields", () => {
  const link = normalizeChatPullRequestLink({
    host: "GitHub.com",
    repository: "Owner/Repo",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    source: "manual",
    linkedAt: 123,
    snapshot: {
      title: "Ship it",
      state: "open",
      headBranch: "feature/x",
      baseBranch: "main",
      headSha: "ABC123",
      checksState: "passing",
      syncedAt: 99,
    },
  });
  assert.ok(link);
  assert.equal(link.host, "github.com");
  assert.equal(link.repository, "owner/repo");
  assert.equal(link.snapshot?.headSha, "abc123");
  assert.equal(link.snapshot?.state, "open");

  assert.equal(
    normalizeChatPullRequestLink({
      host: "github.com",
      repository: "o/r",
      number: -1,
      url: "x",
      linkedAt: 1,
    }),
    undefined,
  );
  assert.equal(
    normalizeChatPullRequestLink({
      host: "github.com",
      repository: "o/r",
      number: 1,
      url: "x",
      source: "bogus",
      linkedAt: 1,
    })?.source,
    "manual",
  );
});

test("normalizeChatPullRequestCreateIntent has no pull request number", () => {
  const intent = normalizeChatPullRequestCreateIntent({
    operationId: "op-1",
    host: "github.com",
    repository: "owner/repo",
    headBranch: "feature/x",
    baseBranch: "main",
    expectedHeadSha: "a".repeat(40),
    title: "Title",
    requestedAt: 10,
    number: 999,
  });
  assert.ok(intent);
  assert.equal("number" in intent, false);
  assert.equal(intent.expectedHeadSha, "a".repeat(40));
  // An unverifiable head SHA is dropped rather than persisted.
  const withoutSha = normalizeChatPullRequestCreateIntent({
    operationId: "op-2",
    host: "github.com",
    repository: "owner/repo",
    headBranch: "feature/x",
    baseBranch: "main",
    title: "Title",
    requestedAt: 10,
    expectedHeadSha: "not a sha!!",
  });
  assert.ok(withoutSha);
  assert.equal(withoutSha.expectedHeadSha, undefined);
  assert.equal(
    normalizeChatPullRequestCreateIntent({
      operationId: "bad op id",
      host: "github.com",
      repository: "owner/repo",
      headBranch: "feature/x",
      baseBranch: "main",
      title: "Title",
      requestedAt: 10,
    }),
    undefined,
  );
});

test("isSafeChatPullRequestChatId rejects path-shaped ids", () => {
  assert.equal(isSafeChatPullRequestChatId("chat-123"), true);
  assert.equal(isSafeChatPullRequestChatId("../escape"), false);
  assert.equal(isSafeChatPullRequestChatId("a/b"), false);
  assert.equal(isSafeChatPullRequestChatId(""), false);
});

test("link cap constant is sane", () => {
  assert.ok(MAX_CHAT_PULL_REQUEST_LINKS >= 16);
});
