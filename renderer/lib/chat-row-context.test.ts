import assert from "node:assert/strict";
import test from "node:test";
import type { ChatPullRequestView } from "../shared/chat-pull-requests";
import { rowPullRequestLabel, sidebarRowPullRequest } from "./chat-row-context";
import type { GitHubPullRequestSummary } from "./types";

function linked(number: number, overrides: Partial<ChatPullRequestView> = {}): ChatPullRequestView {
  return {
    host: "github.com",
    repository: "owner/repo",
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    linked: true,
    title: `Linked ${number}`,
    state: "open",
    headBranch: "feature/x",
    checksState: "pending",
    ...overrides,
  };
}

function discovered(number: number, overrides: Partial<GitHubPullRequestSummary> = {}): GitHubPullRequestSummary {
  return {
    number,
    title: `Branch ${number}`,
    url: `https://github.com/owner/repo/pull/${number}`,
    state: "open",
    headBranch: "feature/x",
    baseBranch: "main",
    checksState: "failing",
    checks: [],
    ...overrides,
  };
}

test("a chat with neither a linked nor a branch PR shows no PR", () => {
  assert.equal(sidebarRowPullRequest(undefined, undefined), undefined);
});

test("a branch PR the chat unlinked does not come back", () => {
  assert.equal(sidebarRowPullRequest(undefined, discovered(12), ["github.com/owner/repo#12"]), undefined);
  assert.equal(
    sidebarRowPullRequest(undefined, discovered(13), ["github.com/owner/repo#12"])?.number,
    13,
  );
});

test("the branch read refreshes a linked PR's state and checks when it is the same PR", () => {
  const row = sidebarRowPullRequest(linked(12), discovered(12, { isDraft: true }));
  assert.equal(row?.number, 12);
  assert.equal(row?.checksState, "failing");
  assert.equal(row?.isDraft, true);
  assert.equal(row?.title, "Branch 12");
});

test("a different PR on the worktree branch never replaces the chat's linked PR", () => {
  const row = sidebarRowPullRequest(linked(12), discovered(30));
  assert.equal(row?.number, 12);
  assert.equal(row?.title, "Linked 12");
});

test("the same number in another repository is a different PR", () => {
  const row = sidebarRowPullRequest(
    linked(12, { repository: "other-org/lib", url: "https://github.com/other-org/lib/pull/12" }),
    discovered(12, { state: "closed", title: "Unrelated" }),
  );
  assert.equal(row?.state, "open");
  assert.equal(row?.title, "Linked 12");
});

test("checks from a stored snapshot alone are not shown, since they may be stale", () => {
  const row = sidebarRowPullRequest(linked(12, { checksState: "pending" }), undefined);
  assert.equal(rowPullRequestLabel(row!), "Pull request #12, open");
});

test("a merged linked PR stays merged even if a stale branch read says open", () => {
  const row = sidebarRowPullRequest(linked(12, { state: "merged" }), discovered(12));
  assert.equal(row?.state, "merged");
  assert.equal(rowPullRequestLabel(row!), "Pull request #12, merged");
});

test("without a linked PR the worktree branch PR is shown", () => {
  const row = sidebarRowPullRequest(undefined, discovered(7, { checksState: "passing" }));
  assert.equal(rowPullRequestLabel(row!), "Pull request #7, open, checks passing");
});

test("labels only mention checks for open, ready PRs", () => {
  assert.equal(
    rowPullRequestLabel(sidebarRowPullRequest(linked(3, { isDraft: true }), undefined)!),
    "Pull request #3, draft",
  );
  assert.equal(
    rowPullRequestLabel(sidebarRowPullRequest(linked(3, { state: "closed" }), undefined)!),
    "Pull request #3, closed",
  );
  assert.equal(
    rowPullRequestLabel(sidebarRowPullRequest(linked(3, { checksState: null }), undefined)!),
    "Pull request #3, open",
  );
});
