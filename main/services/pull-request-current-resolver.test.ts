// Current-PR precedence for a chat: workspace-branch match wins, created-by-
// Aiden beats recency, merged/closed links fall through to recency, unlinked
// workspace discovery is the last resort. Resolution never mutates links.

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChatPullRequestLink,
  ChatPullRequestView,
} from "../../renderer/shared/chat-pull-requests.js";
import { resolveCurrentPullRequest } from "./pull-request-current-resolver.js";

function link(
  number: number,
  overrides: Partial<ChatPullRequestLink> & {
    state?: "open" | "closed" | "merged";
    headBranch?: string;
  } = {},
): ChatPullRequestLink {
  const { state = "open", headBranch = `branch-${number}`, repository, ...rest } = overrides;
  return {
    host: "github.com",
    repository: repository ?? "owner/repo",
    number,
    url: `https://github.com/${repository ?? "owner/repo"}/pull/${number}`,
    source: "manual",
    linkedAt: number * 100,
    snapshot: {
      title: `PR ${number}`,
      state,
      headBranch,
      baseBranch: "main",
      syncedAt: 50,
    },
    ...rest,
  };
}

function discovered(number: number): ChatPullRequestView {
  return {
    host: "github.com",
    repository: "owner/repo",
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    linked: false,
    title: "Discovered",
    state: "open",
    headBranch: "feature/x",
    baseBranch: "main",
  };
}

test("a linked open PR on the checked-out branch beats every recency rule", () => {
  const links = [
    link(5, { source: "created", linkedAt: 500 }), // more recent + created, wrong branch
    link(3, { headBranch: "feature/x" }),
  ];
  const resolved = resolveCurrentPullRequest(links, {
    host: "github.com",
    repository: "owner/repo",
    branch: "feature/x",
  });
  assert.equal(resolved.reason, "workspace-branch");
  assert.equal(resolved.pullRequest?.number, 3);
});

test("an open PR Aiden created wins over a more recent manual open link", () => {
  const links = [link(9, { linkedAt: 900 }), link(4, { source: "created", linkedAt: 100 })];
  const resolved = resolveCurrentPullRequest(links, { branch: "unrelated" });
  assert.equal(resolved.reason, "created");
  assert.equal(resolved.pullRequest?.number, 4);
});

test("most recently linked open PR wins when nothing matches the workspace", () => {
  const links = [link(1, { linkedAt: 100 }), link(2, { linkedAt: 200 })];
  const resolved = resolveCurrentPullRequest(links, {});
  assert.equal(resolved.reason, "recent-open");
  assert.equal(resolved.pullRequest?.number, 2);
});

test("a merged or closed link still beats workspace discovery", () => {
  const links = [link(1, { state: "merged" })];
  const resolved = resolveCurrentPullRequest(links, {
    repository: "owner/repo",
    branch: "feature/x",
    discovered: discovered(99),
  });
  assert.equal(resolved.reason, "recent-linked");
  assert.equal(resolved.pullRequest?.number, 1);
});

test("with no links the discovered workspace PR is current but stays unlinked", () => {
  const resolved = resolveCurrentPullRequest([], {
    repository: "owner/repo",
    branch: "feature/x",
    discovered: discovered(7),
  });
  assert.equal(resolved.reason, "discovered");
  assert.equal(resolved.pullRequest?.linked, false);
});

test("no links and no discovery resolves to none", () => {
  const resolved = resolveCurrentPullRequest([], { branch: "main" });
  assert.equal(resolved.reason, "none");
  assert.equal(resolved.pullRequest, undefined);
});

test("a branch switch changes current without mutating durable links", () => {
  const links = [link(1, { headBranch: "feature/x" }), link(2, { headBranch: "feature/y" })];
  const before = JSON.stringify(links);
  const onX = resolveCurrentPullRequest(links, {
    repository: "owner/repo",
    branch: "feature/x",
  });
  const onY = resolveCurrentPullRequest(links, {
    repository: "owner/repo",
    branch: "feature/y",
  });
  assert.equal(onX.pullRequest?.number, 1);
  assert.equal(onY.pullRequest?.number, 2);
  assert.equal(JSON.stringify(links), before);
});

test("a linked PR in another repository is not a workspace match", () => {
  const links = [link(1, { repository: "other/repo", headBranch: "feature/x" })];
  const resolved = resolveCurrentPullRequest(links, {
    repository: "owner/repo",
    branch: "feature/x",
  });
  assert.equal(resolved.reason, "recent-open");
  assert.equal(resolved.pullRequest?.number, 1);
});
