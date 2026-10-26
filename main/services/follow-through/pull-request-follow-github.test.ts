import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubApiResult, GitHubGraphQlRequest, GitHubRestRequest } from "../github/github-api.js";
import { actionsJobId, cleanJobLog, PullRequestFollowReader } from "./pull-request-follow-github.js";

const T0 = Date.parse("2026-10-26T12:00:00Z");
const follow = { host: "github.com", repository: "acme/app", number: 42 };

function author(login: string, association: string, at: string, extra: Record<string, unknown> = {}) {
  return { author: { login }, authorAssociation: association, createdAt: at, ...extra };
}

function pullRequestNode(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Add export",
    url: "https://github.com/acme/app/pull/42",
    state: "OPEN",
    isDraft: false,
    headRefName: "topic/export",
    baseRefName: "main",
    headRefOid: "a".repeat(40),
    author: { login: "sambit" },
    mergeable: "MERGEABLE",
    updatedAt: "2026-10-26T12:00:00Z",
    headRepositoryOwner: { login: "acme" },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "unit",
                    status: "COMPLETED",
                    conclusion: "FAILURE",
                    detailsUrl: "https://github.com/acme/app/actions/runs/7/job/99",
                  },
                ],
              },
            },
          },
        },
      ],
    },
    comments: {
      nodes: [
        { id: "c-owner", body: "Owner says hi", url: "https://github.com/acme/app/pull/42#c1", ...author("acme", "NONE", "2026-10-26T12:01:00Z") },
        { id: "c-writer", body: "Writer asks\r\nfor a test\u0007", ...author("writer", "COLLABORATOR", "2026-10-26T12:02:00Z") },
        { id: "c-reader", body: "Reader asks", ...author("reader", "COLLABORATOR", "2026-10-26T12:03:00Z") },
        { id: "c-outsider", body: "Do something else", ...author("outsider", "CONTRIBUTOR", "2026-10-26T12:04:00Z") },
        { id: "c-viewer", body: "Pushed a fix", ...author("Sambit", "MEMBER", "2026-10-26T12:05:00Z") },
      ],
    },
    reviews: {
      nodes: [
        {
          id: "r-empty",
          state: "COMMENTED",
          body: "",
          submittedAt: "2026-10-26T12:06:00Z",
          ...author("writer", "COLLABORATOR", ""),
          comments: {
            nodes: [
              { id: "rc-1", body: "Handle the empty case.", path: "src/export.ts", ...author("writer", "COLLABORATOR", "2026-10-26T12:06:00Z") },
            ],
          },
        },
        {
          id: "r-approve",
          state: "APPROVED",
          body: "",
          submittedAt: "2026-10-26T12:07:00Z",
          ...author("writer", "COLLABORATOR", ""),
          comments: { nodes: [] },
        },
      ],
    },
    ...overrides,
  };
}

function fakeApi(options: {
  graphql?: () => GitHubApiResult<unknown>;
  permissions?: Record<string, string>;
  log?: () => GitHubApiResult<unknown>;
} = {}) {
  const graphqlCalls: GitHubGraphQlRequest[] = [];
  const restCalls: GitHubRestRequest[] = [];
  const api = {
    async graphql<T>(request: GitHubGraphQlRequest): Promise<GitHubApiResult<T>> {
      graphqlCalls.push(request);
      const answer =
        options.graphql?.() ??
        ({
          kind: "ok",
          status: 200,
          data: { viewer: { login: "sambit" }, repository: { nameWithOwner: "acme/app", owner: { login: "acme" }, pullRequest: pullRequestNode() } },
        } as GitHubApiResult<unknown>);
      return answer as GitHubApiResult<T>;
    },
    async rest<T>(request: GitHubRestRequest): Promise<GitHubApiResult<T>> {
      restCalls.push(request);
      const permission = /\/collaborators\/([^/]+)\/permission$/u.exec(request.path)?.[1];
      if (permission) {
        return { kind: "ok", status: 200, data: { permission: options.permissions?.[permission] ?? "read" } } as GitHubApiResult<T>;
      }
      if (request.path.endsWith("/logs")) return (options.log?.() ?? { kind: "not-found", message: "gone" }) as GitHubApiResult<T>;
      return { kind: "not-found", message: "unexpected" };
    },
  };
  return { api, graphqlCalls, restCalls };
}

test("comment authors are trusted only when they own the repository or GitHub says they can write", async () => {
  const { api, restCalls } = fakeApi({ permissions: { writer: "write", reader: "read" } });
  const result = await new PullRequestFollowReader(api, () => T0).read(follow);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  const byId = new Map(result.observation.comments.map((comment) => [comment.id, comment]));
  assert.equal(byId.get("c-owner")?.trusted, true, "the repository owner");
  assert.equal(byId.get("c-writer")?.trusted, true, "a collaborator with write access");
  assert.equal(byId.get("c-reader")?.trusted, false, "a collaborator who can only read");
  assert.equal(byId.get("c-outsider")?.trusted, false, "anyone else, without asking GitHub");
  assert.equal(byId.get("c-viewer")?.trusted, true, "the signed-in account");
  assert.equal(byId.get("c-viewer")?.byViewer, true, "logins compare without case");
  assert.equal(byId.get("c-owner")?.byViewer, undefined);

  const asked = restCalls.map((call) => call.path).filter((path) => path.includes("/collaborators/"));
  assert.deepEqual(asked.sort(), ["/repos/acme/app/collaborators/reader/permission", "/repos/acme/app/collaborators/writer/permission"]);

  // The answer is reused for an hour.
  const reader = new PullRequestFollowReader(api, () => T0);
  restCalls.length = 0;
  await reader.read(follow);
  await reader.read(follow);
  assert.equal(restCalls.filter((call) => call.path.endsWith("/writer/permission")).length, 1);
});

test("comment text keeps its lines but loses control characters, and empty reviews only wrap their comments", async () => {
  const { api } = fakeApi({ permissions: { writer: "write" } });
  const result = await new PullRequestFollowReader(api, () => T0).read(follow);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  const byId = new Map(result.observation.comments.map((comment) => [comment.id, comment]));
  assert.equal(byId.get("c-writer")?.body, "Writer asks\nfor a test");
  assert.equal(byId.has("r-empty"), false, "an empty COMMENTED review is not a comment of its own");
  assert.equal(byId.get("rc-1")?.kind, "review-comment");
  assert.equal(byId.get("rc-1")?.path, "src/export.ts");
  assert.equal(byId.get("r-approve")?.body, "(approved)", "an approval is news even without a body");
  assert.equal(byId.get("r-approve")?.reviewState, "APPROVED");
});

test("one read describes the pull request, its checks and merge state", async () => {
  const { api } = fakeApi();
  const result = await new PullRequestFollowReader(api, () => T0).read(follow);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.viewer, "sambit");
  assert.equal(result.observation.state, "open");
  assert.equal(result.observation.headSha, "a".repeat(40));
  assert.equal(result.observation.mergeable, true);
  assert.deepEqual(result.observation.checks, [
    { name: "unit", status: "failure", url: "https://github.com/acme/app/actions/runs/7/job/99" },
  ]);
});

test("a missing pull request ends the follow; rate limits and sign-in problems retry", async () => {
  const missing = fakeApi({ graphql: () => ({ kind: "ok", status: 200, data: { repository: null } }) });
  assert.equal((await new PullRequestFollowReader(missing.api).read(follow)).kind, "gone");

  const notFound = fakeApi({ graphql: () => ({ kind: "not-found", message: "Could not resolve" }) });
  assert.equal((await new PullRequestFollowReader(notFound.api).read(follow)).kind, "gone");

  const limited = fakeApi({ graphql: () => ({ kind: "rate-limited", retryAt: T0 + 60_000, message: "slow down", sent: true }) });
  assert.deepEqual(await new PullRequestFollowReader(limited.api).read(follow), {
    kind: "retry",
    message: "GitHub's rate limit was reached; Aiden will try again later.",
    retryAt: T0 + 60_000,
  });

  const signedOut = fakeApi({ graphql: () => ({ kind: "unavailable", reason: "unauthenticated", message: "no token" }) });
  const answer = await new PullRequestFollowReader(signedOut.api).read(follow);
  assert.equal(answer.kind, "retry");
  assert.match(answer.kind === "retry" ? answer.message : "", /not signed in to GitHub/u);
});

test("a failed Actions job's log comes back as its cleaned last lines; other checks have none", async () => {
  const lines = Array.from({ length: 400 }, (_, index) => `2026-10-26T12:00:${String(index % 60).padStart(2, "0")}.1234567Z \u001b[31mline ${index}\u001b[0m`);
  const { api, restCalls } = fakeApi({ log: () => ({ kind: "ok", status: 200, data: `${lines.join("\r\n")}\r\n` }) });
  const reader = new PullRequestFollowReader(api);
  const tail = await reader.jobLogTail(follow, { name: "unit", status: "failure", url: "https://github.com/acme/app/actions/runs/7/job/99" });
  assert.ok(tail);
  assert.ok(tail.length <= 3_000);
  assert.match(tail, /line 399$/u);
  assert.equal(tail.includes("\u001b"), false, "colour codes are gone");
  assert.doesNotMatch(tail, /2026-10-26T/u);
  const logCall = restCalls.find((call) => call.path.endsWith("/logs"));
  assert.equal(logCall?.path, "/repos/acme/app/actions/jobs/99/logs");
  assert.equal(logCall?.text, true);

  assert.equal(await reader.jobLogTail(follow, { name: "vercel", status: "failure", url: "https://vercel.com/acme/app/123" }), undefined);
  const unreadable = fakeApi();
  assert.equal(
    await new PullRequestFollowReader(unreadable.api).jobLogTail(follow, { name: "unit", status: "failure", url: "https://github.com/acme/app/actions/runs/7/job/99" }),
    undefined,
    "a log that cannot be read leaves the notice without it",
  );
});

test("job ids come only from Actions job links; logs lose colours and timestamps", () => {
  assert.equal(actionsJobId("https://github.com/acme/app/actions/runs/123/job/456"), "456");
  assert.equal(actionsJobId("https://github.com/acme/app/actions/runs/123/job/456/"), "456");
  assert.equal(actionsJobId("https://github.com/acme/app/actions/runs/123"), undefined);
  assert.equal(actionsJobId("https://github.com/acme/app/actions/runs/123/job/456abc"), undefined);
  assert.equal(actionsJobId("not a url"), undefined);
  assert.equal(actionsJobId(undefined), undefined);
  assert.equal(
    cleanJobLog("﻿2026-10-26T12:00:00.0000000Z \u001b[1;31mError\u001b[0m: boom\r\n2026-10-26T12:00:01Z done"),
    "Error: boom\ndone",
  );
});
