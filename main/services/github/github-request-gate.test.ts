import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubApi } from "./github-api.js";
import { withRateLimitSelection } from "./github-graphql-budget.js";
import { GitHubRateLimitGate } from "./github-request-gate.js";
import {
  fixedCredentials,
  hangUntilAborted,
  jsonResponse,
  recordingFetch,
  type ScriptedResponder,
} from "./github-test-fetch.js";

const T0 = Date.parse("2026-10-07T12:00:00Z");

function clock(start = T0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

function rateLimitBody(remaining: number, limit = 5_000, cost = 1, resetAt = T0 + 3_600_000) {
  return { data: { viewer: { login: "octo" }, rateLimit: { cost, limit, remaining, resetAt: new Date(resetAt).toISOString() } } };
}

function harness(responder: ScriptedResponder, start = T0) {
  const time = clock(start);
  const logs: string[] = [];
  const gate = new GitHubRateLimitGate({ now: time.now, log: (line) => logs.push(line) });
  const recorded = recordingFetch(responder);
  const api = new GitHubApi({
    credentials: fixedCredentials({ "github.com": "token-a", "ghe.example.com": "token-b" }),
    gate,
    fetch: recorded.fetch,
    now: time.now,
  });
  return { api, gate, time, logs, requests: recorded.requests };
}

const read = (operation = "viewer", interactive = false) => ({
  host: "github.com",
  operation,
  interactive,
  query: "query Viewer { viewer { login } }",
});

describe("GitHub rate-limit gate", () => {
  it("sends nothing in the background until GitHub's retry time after a secondary limit", async () => {
    let limited = true;
    const { api, time, requests } = harness(() =>
      limited
        ? jsonResponse({ message: "You have exceeded a secondary rate limit." }, 403, { "retry-after": "90" })
        : jsonResponse({ id: 1 }),
    );

    const first = await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    assert.equal(first.kind, "rate-limited");
    assert.equal(first.kind === "rate-limited" && first.retryAt, T0 + 90_000);

    time.advance(60_000);
    const refused = await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    assert.deepEqual(
      refused.kind === "rate-limited" ? { retryAt: refused.retryAt, sent: refused.sent } : refused,
      { retryAt: T0 + 90_000, sent: false },
    );
    assert.equal(requests.length, 1, "a paused scope must not reach GitHub");

    limited = false;
    time.advance(30_001);
    const resumed = await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    assert.equal(resumed.kind, "ok");
    assert.equal(requests.length, 2);
  });

  it("backs off from one minute and doubles when GitHub names no retry time", async () => {
    const { api, gate, time } = harness(() => jsonResponse({ message: "API rate limit exceeded" }, 429));

    await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    assert.equal(gate.governor.pausedUntil("github.com:token-a"), T0 + 60_000);

    time.advance(60_001);
    await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    assert.equal(gate.governor.pausedUntil("github.com:token-a"), time.now() + 120_000);
  });

  it("lets an interactive request through a pause without lifting it for background work", async () => {
    let limited = true;
    const { api, time, requests } = harness(() =>
      limited ? jsonResponse({ message: "API rate limit exceeded" }, 429) : jsonResponse({ id: 1 }),
    );
    await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    limited = false;
    time.advance(10_000);

    const clicked = await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app", interactive: true });
    assert.equal(clicked.kind, "ok");
    const background = await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    assert.equal(background.kind === "rate-limited" && background.sent, false);
    assert.equal(requests.length, 2);
  });

  it("does not clear a newer pause when an older request succeeds late", async () => {
    const releases: Array<() => void> = [];
    let call = 0;
    const { api, gate } = harness(
      () =>
        new Promise<Response>((resolve) => {
          call += 1;
          const response = call === 1 ? jsonResponse({ id: 1 }) : jsonResponse({ message: "rate limit" }, 429);
          releases.push(() => resolve(response));
        }),
    );
    const slow = api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    const limited = api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    await new Promise((resolve) => setImmediate(resolve));
    releases[1]?.();
    await limited;
    releases[0]?.();
    await slow;
    assert.equal(gate.governor.pausedUntil("github.com:token-a"), T0 + 60_000);
  });

  it("pauses each host and credential independently", async () => {
    const { api, requests } = harness((request) =>
      request.url.startsWith("https://api.github.com")
        ? jsonResponse({ message: "rate limit" }, 429)
        : jsonResponse({ id: 1 }),
    );
    await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    const enterprise = await api.rest({ host: "ghe.example.com", operation: "repo", path: "/repos/acme/app" });
    assert.equal(enterprise.kind, "ok");
    assert.equal(requests.length, 2);
  });

  it("asks GitHub for the point budget inside read queries but not mutations", async () => {
    const { api, requests } = harness(() => jsonResponse(rateLimitBody(4_000)));
    await api.graphql(read());
    await api.graphql({ host: "github.com", operation: "mutate", query: "mutation M { addStar(input: {}) { clientMutationId } }" });
    assert.match(requests[0]?.json?.query ?? "", /rateLimit\s*\{\s*cost limit remaining resetAt\s*\}/u);
    assert.doesNotMatch(requests[1]?.json?.query ?? "", /rateLimit/u);
  });

  it("keeps the last 10% of the GraphQL budget for interactive reads", async () => {
    const { api, requests } = harness(() => jsonResponse(rateLimitBody(500)));
    await api.graphql(read());

    const background = await api.graphql(read());
    assert.equal(background.kind, "rate-limited");
    assert.equal(background.kind === "rate-limited" && background.sent, false);
    assert.equal(background.kind === "rate-limited" && background.retryAt, T0 + 3_600_000);
    assert.equal(requests.length, 1);

    const interactive = await api.graphql(read("viewer", true));
    assert.equal(interactive.kind, "ok");
    assert.equal(requests.length, 2);
  });

  it("reserves an operation's observed cost so concurrent background reads cannot overspend", async () => {
    const releases: Array<() => void> = [];
    const { api, requests } = harness(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(jsonResponse(rateLimitBody(540, 5_000, 20))));
        }),
    );
    const first = api.graphql(read("batch"));
    await new Promise((resolve) => setImmediate(resolve));
    releases.shift()?.();
    await first;

    const results = Promise.all([api.graphql(read("batch")), api.graphql(read("batch")), api.graphql(read("batch"))]);
    await new Promise((resolve) => setImmediate(resolve));
    releases.splice(0).forEach((release) => release());
    const outcomes = (await results).map((result) => result.kind);
    assert.equal(requests.length, 3, "only two 20-point reads fit above the 500-point reserve");
    assert.deepEqual(outcomes.sort(), ["ok", "ok", "rate-limited"]);
  });

  it("ignores a reading from an earlier window that arrives late", async () => {
    let body = rateLimitBody(4_000, 5_000, 1, T0 + 3_600_000);
    const { api, gate } = harness(() => jsonResponse(body));
    await api.graphql(read());
    body = rateLimitBody(100, 5_000, 1, T0 - 1);
    await api.graphql(read());
    assert.equal(gate.budget.snapshot("github.com:token-a")?.remaining, 4_000);
  });

  it("treats a GraphQL RATE_LIMITED answer as spent until reset", async () => {
    const reset = Math.floor((T0 + 1_800_000) / 1000);
    const { api, requests } = harness(() =>
      jsonResponse(
        { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user." }] },
        200,
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      ),
    );
    const first = await api.graphql(read());
    assert.equal(first.kind === "rate-limited" && first.retryAt, reset * 1000);
    const second = await api.graphql(read());
    assert.equal(second.kind === "rate-limited" && second.sent, false);
    assert.equal(requests.length, 1);
  });

  it("releases a reservation when the caller aborts", async () => {
    let hang = false;
    const { api, requests } = harness((_request, signal) =>
      hang ? hangUntilAborted(signal) : jsonResponse(rateLimitBody(520, 5_000, 20)),
    );
    await api.graphql(read("batch"));
    hang = true;
    const controller = new AbortController();
    const pending = api.graphql({ ...read("batch"), signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });

    hang = false;
    const next = await api.graphql(read("batch"));
    assert.equal(next.kind, "ok", "the aborted request's points must be returned to the budget");
    assert.equal(requests.length, 3);
  });

  it("accounts usage per operation without exposing credentials", async () => {
    const { api, gate, time, logs } = harness((request) =>
      request.json ? jsonResponse(rateLimitBody(4_990, 5_000, 3)) : jsonResponse({ message: "rate limit" }, 429),
    );
    await api.graphql(read("pr.summary.batch"));
    await api.graphql(read("pr.summary.batch"));
    await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });
    await api.rest({ host: "github.com", operation: "repo", path: "/repos/acme/app" });

    const snapshot = gate.ledger.snapshot();
    assert.deepEqual(snapshot.totals, { requests: 3, points: 6, rateLimited: 1, refusals: 1 });
    const batch = snapshot.operations.find((usage) => usage.operation === "pr.summary.batch");
    assert.equal(batch?.requests, 2);
    assert.equal(snapshot.scopes[0]?.host, "github.com");
    assert.ok(!JSON.stringify(snapshot).includes("token-a"));

    assert.equal(logs.length, 0);
    time.advance(10 * 60_000);
    await api.graphql(read("pr.summary.batch"));
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /pr\.summary\.batch=3/u);
    assert.ok(!logs[0]?.includes("token-a"));
  });
});

describe("withRateLimitSelection", () => {
  it("adds the selection to the operation, not to fragments", () => {
    const query = "fragment F on PullRequest { number } query Q($n: Int!) { repository(owner: \"a\", name: \"b\") { pullRequest(number: $n) { ...F } } }";
    const amended = withRateLimitSelection(query);
    assert.match(amended, /fragment F on PullRequest \{ number \}/u);
    assert.match(amended, /\}\s+rateLimit \{ cost limit remaining resetAt \}\s*\}$/u);
  });

  it("leaves queries that already select it alone", () => {
    const query = "query { rateLimit { remaining } viewer { login } }";
    assert.equal(withRateLimitSelection(query), query);
  });
});
