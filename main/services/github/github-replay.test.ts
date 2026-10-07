// A scripted 30-minute desktop session against a fake GitHub. The gh-based
// implementation this replaced made 73 GitHub calls for the same session
// (52 `gh pr view`, 9 `gh repo view`, 8 `gh pr view N`, 4 `gh pr list`),
// measured by running this scenario over it with a counting gh runner.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatPullRequestService } from "../chat-pull-request-service.js";
import { ChatPullRequestStore } from "../chat-pull-request-store.js";
import { GitHubPullRequestService } from "../github-pull-request.js";
import { GitHubApi } from "./github-api.js";
import { FakeGitHub, type FakePullRequest } from "./github-fake-server.js";
import type { LocalRepositoryResult } from "./github-local-repository.js";
import { BatchedPullRequestReader } from "./github-pull-request-reader.js";
import {
  REPLAY_CHATS,
  REPLAY_WORKSPACES,
  ReplayWorld,
  runReplaySession,
  type ReplayPullRequest,
} from "./github-replay-scenario.js";
import { GitHubRateLimitGate } from "./github-request-gate.js";
import { fixedCredentials, recordingFetch } from "./github-test-fetch.js";

const GH_BASELINE_CALLS = 73;
const GH_BASELINE_NOTIFICATIONS = 4;

function fakePullRequest(entry: ReplayPullRequest): FakePullRequest {
  return {
    repository: entry.repository,
    number: entry.number,
    title: entry.title,
    state: "OPEN",
    headRefName: entry.headBranch,
    baseRefName: "main",
    headRefOid: entry.headSha,
    headOwner: "acme",
    checks: [
      entry.checks === "pending"
        ? { name: "ci", status: "IN_PROGRESS" }
        : { name: "ci", status: "COMPLETED", conclusion: entry.checks === "passing" ? "SUCCESS" : "FAILURE" },
    ],
    createdAt: entry.number,
    updatedAt: entry.number,
  };
}

test("a 30-minute session makes at least 70% fewer GitHub calls than the gh implementation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const world = new ReplayWorld();
  let time = 0;
  const clock = { now: () => time, set: (ms: number) => void (time = ms) };
  const github = new FakeGitHub({
    repositories: [...new Set(REPLAY_WORKSPACES.map((workspace) => workspace.repository))],
    now: clock.now,
  });
  const recorded = recordingFetch((request, signal) => {
    github.pullRequests.splice(0, Infinity, ...[...world.pullRequests.values()].map(fakePullRequest));
    return github.responder(request, signal);
  });
  const api = new GitHubApi({
    credentials: fixedCredentials({ "github.com": "token-a" }),
    gate: new GitHubRateLimitGate({ now: clock.now }),
    fetch: recorded.fetch,
    now: clock.now,
  });
  const pullRequests = new GitHubPullRequestService({
    reader: new BatchedPullRequestReader({ api, now: clock.now }),
    repositories: {
      resolve: async (folder): Promise<LocalRepositoryResult> => {
        const workspace = world.workspaceForFolder(folder);
        if (!workspace) return { ok: false, availability: "not-repo", message: "not a repository" };
        const [owner, name] = workspace.repository.split("/") as [string, string];
        return {
          ok: true,
          repository: {
            host: "github.com",
            owner,
            name,
            branch: workspace.branch,
            headBranch: workspace.branch,
            headOwner: "acme",
            headSha: world.pushed.get(workspace.id)!,
          },
        };
      },
    },
  });

  let notifications = 0;
  let listener: ((chatId: string) => void) | undefined;
  const store = new ChatPullRequestStore(() => directory);
  const service = new ChatPullRequestService({
    store,
    github: pullRequests,
    gitInfo: async (folder) => ({ isRepo: true, branch: world.workspaceForFolder(folder)?.branch }),
    chatWorkspaceId: async (chatId) => REPLAY_CHATS.find((chat) => chat.id === chatId)?.workspaceId,
    workspaceFolderPath: async (id) => world.workspace(id).folder,
    onChanged: (chatId) => {
      notifications += 1;
      listener?.(chatId);
    },
  });
  for (const chat of REPLAY_CHATS) {
    const workspace = world.workspace(chat.workspaceId);
    for (const number of chat.links) {
      const entry = world.pullRequest(workspace.repository, number)!;
      await store.link(chat.id, {
        host: "github.com",
        repository: workspace.repository,
        number,
        url: `https://github.com/${workspace.repository}/pull/${number}`,
        source: "manual",
        linkedAt: 1,
        snapshot: {
          title: entry.title,
          state: "open",
          headBranch: entry.headBranch,
          baseBranch: "main",
          headSha: entry.headSha,
          reviewDecision: null,
          mergeable: true,
          checksState: "passing",
          syncedAt: 1,
        },
      });
    }
  }

  const result = await runReplaySession({
    world,
    clock,
    backend: {
      service,
      sidebarStatus: (folder) => pullRequests.currentPullRequest(folder),
      githubCalls: () => recorded.requests.length,
    },
    notifications: () => notifications,
    onNotify: (next) => {
      listener = next;
    },
  });

  t.diagnostic(`GitHub calls: ${GH_BASELINE_CALLS} -> ${result.githubCalls}; notifications: ${GH_BASELINE_NOTIFICATIONS} -> ${result.notifications}`);
  assert.ok(
    result.githubCalls <= GH_BASELINE_CALLS * 0.3,
    `expected at most ${Math.floor(GH_BASELINE_CALLS * 0.3)} calls, made ${result.githubCalls}`,
  );
  // The pushes and the failed check still reach the chats that show them.
  assert.ok(result.notifications >= 1);
  const failing = (await service.list("chat-four")).links.find((link) => link.number === 222);
  assert.equal(failing?.checksState, "failing");
});
