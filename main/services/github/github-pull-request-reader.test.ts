import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApi } from "./github-api.js";
import { FakeGitHub, type FakePullRequest } from "./github-fake-server.js";
import type { PullRequestQueryEntry } from "./github-pull-request-graphql.js";
import { BatchedPullRequestReader } from "./github-pull-request-reader.js";
import { GitHubRateLimitGate } from "./github-request-gate.js";
import { fixedCredentials, jsonResponse, recordingFetch } from "./github-test-fetch.js";

const T0 = Date.parse("2026-10-07T12:00:00Z");

function pr(number: number, overrides: Partial<FakePullRequest> = {}): FakePullRequest {
  return {
    repository: "acme/app",
    number,
    title: `Change ${number}`,
    state: "OPEN",
    headRefName: `topic/${number}`,
    baseRefName: "main",
    headRefOid: "a".repeat(40),
    headOwner: "acme",
    checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function setup(pullRequests: FakePullRequest[] = [pr(1), pr(2), pr(3)]) {
  let now = T0;
  const github = new FakeGitHub({ repositories: ["acme/app", "acme/other"], pullRequests, now: () => now });
  const enterprise = new FakeGitHub({ host: "ghe.example", repositories: ["corp/app"], pullRequests: [pr(9, { repository: "corp/app" })] });
  const recorded = recordingFetch((request, signal) =>
    (request.url.startsWith("https://ghe.example/") ? enterprise : github).responder(request, signal),
  );
  const api = new GitHubApi({
    credentials: fixedCredentials({ "github.com": "token-a", "ghe.example": "token-b" }),
    gate: new GitHubRateLimitGate({ now: () => now }),
    fetch: recorded.fetch,
    now: () => now,
  });
  const reader = new BatchedPullRequestReader({ api, now: () => now });
  return { reader, github, requests: recorded.requests, advance: (ms: number) => (now += ms) };
}

const number = (n: number, name = "app"): PullRequestQueryEntry => ({ kind: "number", owner: "acme", name, number: n });
const background = { operation: "test" };

test("reads issued together travel in one request per host", async () => {
  const { reader, requests } = setup();
  const results = await Promise.all([
    reader.read("github.com", number(1), background),
    reader.read("github.com", number(2), background),
    reader.read("github.com", { kind: "repository", owner: "acme", name: "other" }, background),
    reader.read("ghe.example", { kind: "number", owner: "corp", name: "app", number: 9 }, background),
  ]);

  assert.deepEqual(
    results.map((result) => (result.kind === "ok" ? (result.pullRequests[0]?.number ?? result.repository.nameWithOwner) : result.kind)),
    [1, 2, "acme/other", 9],
  );
  assert.deepEqual(requests.map((request) => new URL(request.url).host).sort(), ["api.github.com", "ghe.example"]);
});

test("identical reads in flight are asked once", async () => {
  const { reader, requests } = setup();
  await Promise.all([reader.read("github.com", number(1), background), reader.read("github.com", number(1), background)]);
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0]!.json?.variables ?? {}).sort(), ["n0", "o0", "p0"]);
});

test("answers are reused until they may have changed; interactive and new versions read again", async () => {
  const { reader, requests, advance } = setup();
  await reader.read("github.com", number(1), background);
  advance(30_000);
  await reader.read("github.com", number(1), background);
  assert.equal(requests.length, 1, "an open PR with settled checks is fresh for a minute");

  await reader.read("github.com", number(1), { ...background, interactive: true });
  assert.equal(requests.length, 2);

  advance(61_000);
  await reader.read("github.com", number(1), background);
  assert.equal(requests.length, 3);

  const head: PullRequestQueryEntry = { kind: "head", owner: "acme", name: "app", headBranch: "topic/1" };
  await reader.read("github.com", head, { ...background, version: "sha-1" });
  await reader.read("github.com", head, { ...background, version: "sha-1" });
  await reader.read("github.com", head, { ...background, version: "sha-2" });
  assert.equal(requests.length, 5);
});

test("running checks shorten how long an answer is reused", async () => {
  const { reader, requests, advance } = setup([pr(1, { checks: [{ name: "test", status: "IN_PROGRESS" }] })]);
  await reader.read("github.com", number(1), background);
  advance(20_000);
  await reader.read("github.com", number(1), background);
  assert.equal(requests.length, 2);
});

test("failures are never reused", async () => {
  const { reader, github, requests } = setup();
  github.script = () => jsonResponse({ message: "Server Error" }, 502);
  assert.equal((await reader.read("github.com", number(1), background)).kind, "failed");
  github.script = undefined;
  assert.equal((await reader.read("github.com", number(1), background)).kind, "ok");
  assert.equal(requests.length, 2);
});

test("a rate limit answers every read in the request with the retry time", async () => {
  const { reader, github } = setup();
  github.script = () => jsonResponse({ message: "You have exceeded a secondary rate limit." }, 403, { "retry-after": "120" });
  const results = await Promise.all([reader.read("github.com", number(1), background), reader.read("github.com", number(2), background)]);
  assert.deepEqual(
    results.map((result) => (result.kind === "rate-limited" ? result.retryAt : result.kind)),
    [T0 + 120_000, T0 + 120_000],
  );
});

test("one missing repository or pull request does not fail its neighbours", async () => {
  const { reader, requests } = setup();
  const [missingRepository, missingPullRequest, found] = await Promise.all([
    reader.read("github.com", { kind: "repository", owner: "acme", name: "gone" }, background),
    reader.read("github.com", number(404), background),
    reader.read("github.com", number(2), background),
  ]);
  assert.equal(missingRepository.kind, "not-found");
  assert.equal(missingPullRequest.kind, "not-found");
  assert.equal(found.kind === "ok" && found.pullRequests[0]?.number, 2);
  assert.equal(requests.length, 1);
});

test("a document-level error retries each read on its own", async () => {
  const { reader, github, requests } = setup();
  github.script = (request) =>
    Object.keys(request.json?.variables ?? {}).length > 3
      ? jsonResponse({ data: null, errors: [{ message: "Something went wrong while executing your query." }] })
      : undefined;
  const results = await Promise.all([reader.read("github.com", number(1), background), reader.read("github.com", number(2), background)]);
  assert.deepEqual(results.map((result) => result.kind), ["ok", "ok"]);
  assert.equal(requests.length, 3);
});

test("more than 25 reads are split across documents", async () => {
  const many = Array.from({ length: 30 }, (_, index) => pr(index + 1));
  const { reader, requests } = setup(many);
  const results = await Promise.all(many.map((entry) => reader.read("github.com", number(entry.number), background)));
  assert.ok(results.every((result) => result.kind === "ok"));
  assert.equal(requests.length, 2);
});

test("one caller abandoning a shared read leaves it running for the others", async () => {
  const { reader, requests } = setup();
  const controller = new AbortController();
  const abandoned = reader.read("github.com", number(1), { ...background, signal: controller.signal });
  const kept = reader.read("github.com", number(1), background);
  controller.abort();
  await assert.rejects(abandoned, /aborted/u);
  assert.equal((await kept).kind, "ok");
  assert.equal(requests.length, 1);
});
