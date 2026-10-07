import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApi, type GitHubApiResult } from "./github-api.js";
import { GitHubCredentialSource } from "./github-credentials.js";
import { fixedCredentials, jsonResponse, recordingFetch } from "./github-test-fetch.js";

const NOW = Date.parse("2026-10-07T20:00:00Z");

function api(responder: Parameters<typeof recordingFetch>[0], tokens = { "github.com": "dotcom-token" } as Record<string, string>) {
  const recorded = recordingFetch(responder);
  const credentials = fixedCredentials(tokens);
  const client = new GitHubApi({ credentials, fetch: recorded.fetch, now: () => NOW });
  return { client, credentials, ...recorded };
}

const read = { operation: "test.read" } as const;

test("requests reach the API root for github.com, GHE.com and GHES", async () => {
  const { client, requests } = api(() => jsonResponse({ data: { viewer: { login: "me" } } }), {
    "github.com": "a",
    "acme.ghe.com": "b",
    "github.acme.test": "c",
  });
  await client.rest({ ...read, host: "github.com", path: "/repos/acme/app" });
  await client.rest({ ...read, host: "acme.ghe.com", path: "/repos/acme/app" });
  await client.rest({ ...read, host: "github.acme.test", path: "/repos/acme/app" });
  await client.graphql({ ...read, host: "github.com", query: "query { viewer { login } }" });
  await client.graphql({ ...read, host: "acme.ghe.com", query: "query { viewer { login } }" });
  await client.graphql({ ...read, host: "github.acme.test", query: "query { viewer { login } }" });
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://api.github.com/repos/acme/app",
      "https://api.acme.ghe.com/repos/acme/app",
      "https://github.acme.test/api/v3/repos/acme/app",
      "https://api.github.com/graphql",
      "https://api.acme.ghe.com/graphql",
      "https://github.acme.test/api/graphql",
    ],
  );
  assert.equal(requests[0].headers["X-GitHub-Api-Version"], "2022-11-28");
});

test("each host's token is only ever sent to that host", async () => {
  const { client, requests } = api(() => jsonResponse({}), {
    "github.com": "dotcom-secret",
    "github.acme.test": "enterprise-secret",
  });
  await client.rest({ ...read, host: "github.acme.test", path: "/repos/acme/app" });
  await client.rest({ ...read, host: "github.com", path: "/repos/acme/app" });
  for (const request of requests) {
    const host = new URL(request.url).hostname;
    const expected = host === "api.github.com" ? "dotcom-secret" : "enterprise-secret";
    assert.equal(request.headers.Authorization, `Bearer ${expected}`);
  }
  await assert.rejects(
    () => client.rest({ ...read, host: "github.com", path: "//evil.test/steal" }),
    /relative/u,
  );
  await assert.rejects(
    () => client.rest({ ...read, host: "github.com", path: "https://evil.test/x" }),
    /relative/u,
  );
  assert.equal(requests.length, 2);
});

test("a credential issued for another host is refused before sending", async () => {
  const recorded = recordingFetch(() => jsonResponse({}));
  const client = new GitHubApi({
    fetch: recorded.fetch,
    credentials: {
      resolve: async () => ({
        ok: true,
        credential: { host: "github.com", token: "dotcom-secret", fingerprint: "x", source: "environment" },
      }),
      invalidate: () => undefined,
    },
  });
  const result = await client.rest({ ...read, host: "github.acme.test", path: "/repos/a/b" });
  assert.equal(result.kind, "unavailable");
  assert.equal(recorded.requests.length, 0);
});

test("rate limits are recognized in every shape GitHub uses, with the right retry time", async () => {
  const resetSeconds = NOW / 1000 + 600;
  const cases: Array<[string, () => Response, number | undefined]> = [
    ["429 with retry-after seconds", () => jsonResponse({ message: "Too many" }, 429, { "retry-after": "60" }), NOW + 60_000],
    [
      "403 with remaining 0",
      () => jsonResponse({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetSeconds),
      }),
      resetSeconds * 1000,
    ],
    [
      "403 with an HTTP-date retry-after",
      () => jsonResponse({ message: "slow down" }, 403, { "retry-after": new Date(NOW + 120_000).toUTCString() }),
      NOW + 120_000,
    ],
    [
      "403 secondary rate limit without headers",
      () => jsonResponse({ message: "You have exceeded a secondary rate limit." }, 403),
      undefined,
    ],
  ];
  for (const [name, respond, retryAt] of cases) {
    const { client } = api(respond);
    const result = await client.rest({ ...read, host: "github.com", path: "/repos/a/b" });
    assert.equal(result.kind, "rate-limited", name);
    assert.equal(result.kind === "rate-limited" ? result.retryAt : "none", retryAt, name);
  }
});

test("GraphQL rate limits are recognized from typed, header and untyped errors", async () => {
  const resetSeconds = NOW / 1000 + 300;
  const responses = [
    jsonResponse({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user." }] }, 200, {
      "x-ratelimit-reset": String(resetSeconds),
      "x-ratelimit-remaining": "0",
    }),
    jsonResponse({ data: null, errors: [{ message: "Something went wrong" }] }, 200, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(resetSeconds),
    }),
    jsonResponse({ errors: [{ message: "API rate limit already exceeded for user ID 1." }] }, 200),
  ];
  for (const response of responses) {
    const { client } = api(() => response);
    const result = await client.graphql({ ...read, host: "github.com", query: "query { viewer { login } }" });
    assert.equal(result.kind, "rate-limited");
  }
});

test("a permission 403 is a failure, not a rate limit", async () => {
  const { client } = api(() => jsonResponse({ message: "Resource not accessible by integration" }, 403, { "x-ratelimit-remaining": "4999" }));
  const result = await client.rest({ ...read, host: "github.com", path: "/repos/a/b" });
  assert.deepEqual(result, { kind: "failed", status: 403, message: "Resource not accessible by integration" });
});

test("304 is a success only when the request was conditional", async () => {
  const { client } = api(() => new Response(null, { status: 304, headers: { etag: '"abc"' } }));
  const conditional = await client.rest({ ...read, host: "github.com", path: "/repos/a/b/pulls/1", ifNoneMatch: '"abc"' });
  assert.deepEqual(conditional, { kind: "not-modified", etag: '"abc"' });
  const unconditional = await client.rest({ ...read, host: "github.com", path: "/repos/a/b/pulls/1" });
  assert.equal(unconditional.kind, "failed");
});

test("GraphQL errors fail with GitHub's message; NOT_FOUND keeps partial data", async () => {
  const { client } = api((request) =>
    request.json?.query?.includes("partial")
      ? jsonResponse({ data: { a: { id: 1 }, b: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest." }] })
      : jsonResponse({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }),
  );
  const failed = await client.graphql({ ...read, host: "github.com", query: "query { x }" });
  assert.deepEqual(failed, { kind: "failed", status: 200, message: "Resource not accessible" });
  const partial = await client.graphql<{ a: unknown; b: unknown }>({ ...read, host: "github.com", query: "query partial { x }" });
  assert.equal(partial.kind, "not-found");
  assert.deepEqual(partial.kind === "not-found" ? partial.data : undefined, { a: { id: 1 }, b: null });
});

test("a 401 drops the token so the next request asks the credential source again", async () => {
  let issued = 0;
  const recorded = recordingFetch((request) =>
    request.headers.Authorization === "Bearer token-1"
      ? jsonResponse({ message: "Bad credentials" }, 401)
      : jsonResponse({ full_name: "a/b" }),
  );
  const credentials = new GitHubCredentialSource({ env: () => ({}), ghAuthToken: async () => `token-${++issued}` });
  const client = new GitHubApi({ credentials, fetch: recorded.fetch });
  const refused = await client.rest({ ...read, host: "github.com", path: "/repos/a/b" });
  assert.equal(refused.kind, "unauthorized");
  const retried = await client.rest({ ...read, host: "github.com", path: "/repos/a/b" });
  assert.equal(retried.kind, "ok");
  assert.deepEqual(recorded.requests.map((request) => request.headers.Authorization), ["Bearer token-1", "Bearer token-2"]);
});

test("a missing credential is reported without contacting GitHub", async () => {
  const { client, requests } = api(() => jsonResponse({}), {});
  const result = await client.rest({ ...read, host: "github.com", path: "/repos/a/b" });
  assert.deepEqual(result, { kind: "unavailable", reason: "unauthenticated", message: "Sign in." });
  assert.equal(requests.length, 0);
});

test("oversized responses and timeouts fail without hanging", async () => {
  const big = recordingFetch(() => new Response("x".repeat(2_048)));
  const capped = new GitHubApi({ credentials: fixedCredentials({ "github.com": "t" }), fetch: big.fetch, maxResponseBytes: 1_024 });
  assert.equal((await capped.rest({ ...read, host: "github.com", path: "/x" })).kind, "failed");

  const slow = new GitHubApi({
    credentials: fixedCredentials({ "github.com": "t" }),
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
      ),
  });
  const result = await slow.rest({ ...read, host: "github.com", path: "/x" });
  assert.equal(result.kind, "failed");
  assert.match(result.kind === "failed" ? result.message : "", /did not answer/u);
});

test("a caller abort rejects instead of becoming a GitHub failure", async () => {
  const controller = new AbortController();
  const client = new GitHubApi({
    credentials: fixedCredentials({ "github.com": "t" }),
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        setTimeout(() => controller.abort(), 5);
      }),
  });
  await assert.rejects(() => client.rest({ ...read, host: "github.com", path: "/x", signal: controller.signal }), /aborted/u);
});

test("no more than eight requests are in flight at once", async () => {
  let active = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const client = new GitHubApi({
    credentials: fixedCredentials({ "github.com": "t" }),
    fetch: () =>
      new Promise<Response>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        release.push(() => {
          active -= 1;
          resolve(jsonResponse({}));
        });
      }),
  });
  const all: Array<Promise<GitHubApiResult<unknown>>> = [];
  for (let index = 0; index < 12; index += 1) all.push(client.rest({ ...read, host: "github.com", path: `/x/${index}` }));
  while (release.length < 8) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(peak, 8);
  while (release.length > 0) {
    release.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const results = await Promise.all(all);
  assert.equal(results.filter((result) => result.kind === "ok").length, 12);
  assert.equal(peak, 8);
});
