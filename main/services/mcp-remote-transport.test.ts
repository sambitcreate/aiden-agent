import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { McpClient, McpSessionExpiredError } from "@earendil-works/pi-mcp";
import { authorizeMcp, type OAuthClientProvider, type OAuthTokens } from "@earendil-works/pi-mcp/oauth";
import { GenerationBoundConnectionCache } from "./generation-bound-connection-cache.js";
import { createMcpRemoteTransport } from "./mcp-remote-transport.js";
import { callMcpTool } from "./mcp-tool-inventory.js";
import { mcpAuthorizationBinding, sessionAfterTokenInvalidation, sessionWithSavedMcpTokens, type McpOAuthSession } from "./mcp-oauth-session.js";
import { createBackgroundMcpOAuthProvider, McpOAuthRefreshUnavailableError, type McpOAuthRuntime } from "./mcp-oauth-provider-core.js";
import { McpOAuthOperationGate } from "./mcp-oauth-operation.js";
import { McpLiveStatusRegistry } from "./mcp-status-events.js";
import type { McpServer } from "./types.js";
import { createMcpFetchPolicy } from "./mcp-fetch-policy.js";

const serviceUrl = "https://mcp.example/mcp";
const initialized = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
  serverInfo: { name: "fixture", version: "1" },
};
const tools = [{ name: "example", inputSchema: { type: "object" } }];

async function until(predicate: () => boolean, attempts = 500) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail("MCP transport did not reach the expected state");
}

function harness(fetch: typeof globalThis.fetch, authProvider?: OAuthClientProvider) {
  const cache = new GenerationBoundConnectionCache<McpClient>();
  const errors: Error[] = [];
  let created = 0;
  const acquire = () => cache.getOrConnect(
    "server",
    () => {
      created += 1;
      const client = new McpClient({ name: "remote-regression", version: "1" });
      client.onError((error) => errors.push(error));
      return client;
    },
    async (client, isCurrent, onClosed) => {
      client.onClose(onClosed);
      await client.connect(createMcpRemoteTransport({
        serviceUrl, fetch, authProvider, isCurrent, onTerminalFailure: onClosed,
      }));
    },
    async (client) => client.close(),
  );
  return { cache, acquire, errors, created: () => created };
}

for (const stateful of [true, false]) {
  test(`HTTP ${stateful ? "session" : "stateless"} failure preserves transient errors and never replays calls`, async (t) => {
    let failure = 0;
    let calls = 0;
    const fixture = harness(async (_input, init) => {
      if (init?.method === "GET") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init?.body));
      if (request.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: request.id, result: initialized }, {
          headers: stateful ? { "mcp-session-id": "fixture-session" } : {},
        });
      }
      if (request.method === "tools/call") calls += 1;
      if (request.id === undefined) return new Response(null, { status: 202 });
      if (failure) return new Response("fixture failure", { status: failure });
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools } });
    });
    t.after(() => fixture.cache.disconnect("server"));
    const first = await fixture.acquire();
    assert.equal((await first.listTools()).length, 1);
    failure = 503;
    await assert.rejects(first.listTools(), /503|fixture failure/);
    assert.equal(await fixture.acquire(), first, "a temporary POST failure keeps the session");
    failure = 0;
    assert.equal((await first.listTools()).length, 1);
    failure = 404;
    await assert.rejects(first.callTool("example", {}));
    assert.equal(calls, 1, "the failed call is never replayed");
    failure = 0;
    const next = await fixture.acquire();
    assert.equal(next === first, !stateful, "only an established session's 404 proves session loss");
    assert.equal((await next.listTools()).length, 1);
    assert.equal(fixture.created(), stateful ? 2 : 1);
    assert.equal(calls, 1);
  });
}

for (const terminal of [true, false]) {
  test(`HTTP GET reconnect ${terminal ? "session loss evicts and cancels retries" : "transient failure keeps the session"}`, async (t) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let gets = 0;
    let failNextGet = false;
    const encoder = new TextEncoder();
    const fixture = harness(async (_input, init) => {
      if (init?.method === "GET") {
        gets += 1;
        if (failNextGet) {
          failNextGet = false;
          return new Response(null, { status: terminal ? 404 : 503 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(encoder.encode("retry: 1\n\n"));
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      const request = JSON.parse(String(init?.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: request.id,
        result: request.method === "initialize" ? initialized : { tools },
      }, { headers: { "mcp-session-id": "fixture-session" } });
    });
    t.after(() => fixture.cache.disconnect("server"));
    const first = await fixture.acquire();
    await until(() => gets === 1);
    failNextGet = true;
    stream.close();
    // Session loss is reported; a transient status is retried quietly.
    if (terminal) await until(() => fixture.errors.some((error) => error instanceof McpSessionExpiredError));
    else await until(() => gets === 3);
    const next = await fixture.acquire();
    assert.equal(next === first, !terminal);
    assert.equal((await next.listTools()).length, 1);
    assert.equal(fixture.created(), terminal ? 2 : 1);
    await until(() => gets === 3);
    await delay(20);
    assert.equal(gets, 3, "no abandoned old-session retry outlives terminal teardown");
    if (terminal) assert.equal(first.connectionState, "closed");
  });
}

test("HTTP tools/list POST succeeds on the same session after optional GET retries are exhausted", async (t) => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let gets = 0;
  const discoverySessions: Array<string | null> = [];
  const fixture = harness(async (_input, init) => {
    if (init?.method === "GET") {
      gets += 1;
      if (gets > 1) return new Response(null, { status: 503 });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode("retry: 1\n\n"));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    const request = JSON.parse(String(init?.body));
    if (request.id === undefined) return new Response(null, { status: 202 });
    if (request.method === "tools/list") {
      assert.equal(init?.method, "POST");
      discoverySessions.push(new Headers(init.headers).get("mcp-session-id"));
    }
    return Response.json({ jsonrpc: "2.0", id: request.id,
      result: request.method === "initialize" ? initialized : { tools },
    }, { headers: { "mcp-session-id": "retained-session" } });
  });
  t.after(() => fixture.cache.disconnect("server"));
  const first = await fixture.acquire();
  assert.equal((await first.listTools()).length, 1);
  await until(() => gets === 1);
  stream.close();
  await until(() => fixture.errors.some((error) => /stream dropped and could not be reopened/u.test(error.message)));
  assert.equal(gets, 6, "the optional GET stream made every retry before exhausting");
  const cached = await fixture.acquire();
  assert.equal(cached, first);
  assert.equal((await cached.listTools())[0].name, "example");
  assert.deepEqual(discoverySessions, ["retained-session", "retained-session"]);
  assert.equal(fixture.created(), 1, "no new initialization was needed for successful discovery");
  assert.equal(first.connectionState, "connected", "the session remains attached after optional stream exhaustion");
});

function authenticatedFixture(mode: "failed" | "successful" | "transient") {
  // A distinct grant per fixture: identical concurrent refreshes are shared process-wide.
  const store = { session: {
    authorizationBinding: mcpAuthorizationBinding(serviceUrl),
    tokens: { access_token: "old-token", refresh_token: `refresh-token-${mode}`, token_type: "Bearer" },
  } as McpOAuthSession };
  let rejectOldToken = false;
  let refreshFails = mode === "failed";
  let transient = mode === "transient";
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let receives = false;
  let gets = 0;
  let refreshes = 0;
  const encoder = new TextEncoder();
  const provider = storeBackedProvider(store);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) {
      return Response.json({ resource: serviceUrl, authorization_servers: ["https://auth.example"] });
    }
    if (url === "https://auth.example/token") {
      refreshes += 1;
      return refreshFails
        ? Response.json({ error: "server_error" }, { status: 503 })
        : Response.json({ access_token: "fresh-token", token_type: "Bearer" });
    }
    if (url.startsWith("https://auth.example")) {
      return Response.json({ issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token", response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"] });
    }
    const headers = new Headers(init?.headers);
    if (init?.method !== "POST") {
      gets += 1;
      if (rejectOldToken && headers.get("authorization") === "Bearer old-token") {
        return new Response(null, { status: 401, headers: {
          "www-authenticate": 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
        } });
      }
      if (rejectOldToken && transient) {
        transient = false;
        throw new TypeError("temporary stream fetch failure");
      }
      receives = true;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(encoder.encode("retry: 1\n\n"));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (rejectOldToken && headers.get("authorization") === "Bearer old-token") {
      return new Response(null, { status: 401 });
    }
    const request = JSON.parse(String(init?.body));
    const result = request.method === "initialize" ? initialized : { tools };
    if (request.id !== undefined) {
      return Response.json({ jsonrpc: "2.0", id: request.id, result }, {
        headers: { "mcp-session-id": "authenticated-session" },
      });
    }
    return new Response(null, { status: 202 });
  };
  return { provider, fetch, gets: () => gets, refreshes: () => refreshes, receives: () => receives,
    interrupt() { rejectOldToken = true; receives = false; stream.close(); },
    recoverAuthorization() { refreshFails = false; },
  };
}

for (const mode of ["failed", "successful", "transient"] as const) {
  test(`${mode} stream reauthentication keeps the cached client usable`, async (t) => {
    const remote = authenticatedFixture(mode);
    const fixture = harness(remote.fetch, remote.provider);
    t.after(() => fixture.cache.disconnect("server"));
    const first = await fixture.acquire();
    assert.equal((await first.listTools()).length, 1);
    remote.interrupt();
    if (mode === "failed") {
      // The refresh failed for a transient reason: the optional GET stream stops, the sign-in stays.
      await until(() => fixture.errors.some((error) => error instanceof McpOAuthRefreshUnavailableError));
      remote.recoverAuthorization();
    } else {
      await until(() => remote.receives(), 2500);
    }
    const next = await fixture.acquire();
    assert.equal(next, first, "only the optional stream failed; POSTs reauthenticate");
    assert.equal((await next.listTools())[0].name, "example");
    assert.equal(fixture.created(), 1);
    assert.ok(remote.refreshes() > 0, "the refresh ran through the adapted OAuth provider");
  });
}

const oauthServer: McpServer = { id: "server", name: "Fixture", transport: "http", url: serviceUrl, oauth: true, enabled: true };

/**
 * Aiden's real background provider over one shared session store (another
 * client may change `store.session` at any time). `beforeTokens` holds the
 * provider's third store read open: the token read of a direct refresh, after
 * the discovery and client reads.
 */
function storeBackedProvider(store: { session: McpOAuthSession }, beforeTokens?: () => Promise<void>) {
  store.session.clientInformation ??= { client_id: "fixture-client", redirect_uris: ["http://127.0.0.1:41432/callback"] };
  let reads = 0;
  const runtime: McpOAuthRuntime = {
    store: {
      async get() {
        const snapshot = structuredClone(store.session);
        reads += 1;
        if (reads === 3) await beforeTokens?.();
        return snapshot;
      },
      async set(_serverId, session) { store.session = structuredClone(session); },
      async clear() { store.session = {}; },
    },
    gate: new McpOAuthOperationGate(),
    status: new McpLiveStatusRegistry(),
    openBrowser: async () => { throw new Error("A background connection must not open a browser."); },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clientVersion: "test",
    loopback: { port: 41432, redirectUri: "http://127.0.0.1:41432/callback", timeoutMs: 1_000 },
    publish: (_serverId, operation) => operation(),
  };
  return createBackgroundMcpOAuthProvider(runtime, oauthServer);
}

/** Rotating authorization server: each refresh token works exactly once. */
function rotatingAuthority(grant: string) {
  let generation = 1;
  let expired = false;
  let refreshPosts = 0;
  let gate: Promise<void> = Promise.resolve();
  let release: () => void = () => {};
  const valid = () => `${grant}-access-${generation}`;
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response | undefined> => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) {
      return Response.json({ resource: serviceUrl, authorization_servers: ["https://auth.example"] });
    }
    if (url === "https://auth.example/token") {
      refreshPosts += 1;
      const presented = new URLSearchParams(String(init?.body)).get("refresh_token");
      await gate;
      if (presented !== `${grant}-refresh-${generation}`) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      generation += 1;
      return Response.json({ access_token: valid(), refresh_token: `${grant}-refresh-${generation}`, token_type: "Bearer" });
    }
    if (url.startsWith("https://auth.example")) {
      return Response.json({ issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token", response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"] });
    }
    return undefined;
  };
  return {
    fetch, valid, refreshPosts: () => refreshPosts,
    /** Only the newest access token works, and the first one stops working once expired. */
    accepts: (init?: RequestInit) => new Headers(init?.headers).get("authorization") === `Bearer ${valid()}` && !(expired && generation === 1),
    expire() { expired = true; },
    hold() { gate = new Promise((resolve) => { release = resolve; }); },
    release: () => release(),
    initialTokens: (): OAuthTokens => ({ access_token: valid(), refresh_token: `${grant}-refresh-${generation}`, token_type: "Bearer" }),
  };
}

test("concurrent 401s from separate clients share one rotating refresh and keep the saved tokens", async (t) => {
  const authority = rotatingAuthority("concurrent");
  const store = { session: { authorizationBinding: mcpAuthorizationBinding(serviceUrl), tokens: authority.initialTokens() } as McpOAuthSession };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const oauth = await authority.fetch(input, init);
    if (oauth) return oauth;
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (!authority.accepts(init)) {
      return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    const request = JSON.parse(String(init?.body));
    if (request.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize" ? initialized : { tools } });
  };
  const clients = [0, 1].map(() => new McpClient({ name: "refresh-regression", version: "1" }));
  t.after(() => Promise.all(clients.map((client) => client.close())));
  for (const client of clients) {
    await client.connect(createMcpRemoteTransport({ serviceUrl, fetch, authProvider: storeBackedProvider(store) }));
  }
  authority.expire();
  authority.hold();
  const listed = Promise.all(clients.map((client) => client.listTools()));
  await until(() => authority.refreshPosts() >= 1);
  await delay(20);
  authority.release();
  const results = await listed;
  assert.deepEqual(results.map((listedTools) => listedTools.length), [1, 1]);
  assert.equal(authority.refreshPosts(), 1, "both clients shared one refresh_token POST");
  assert.equal(store.session.tokens?.access_token, "concurrent-access-2");
  assert.equal(store.session.tokens?.refresh_token, "concurrent-refresh-2");
});

test("a stale invalid_grant never deletes tokens another client already rotated", async () => {
  const binding = mcpAuthorizationBinding(serviceUrl);
  const store = { session: { authorizationBinding: binding, tokens: { access_token: "stale-access", refresh_token: "stale-refresh", token_type: "Bearer" } } as McpOAuthSession };
  const provider = storeBackedProvider(store);
  let posts = 0;
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: serviceUrl, authorization_servers: ["https://auth.example"] });
    if (url === "https://auth.example/token") {
      posts += 1;
      const presented = new URLSearchParams(String(init?.body)).get("refresh_token");
      if (presented === "stale-refresh") {
        // Another client rotated first and saved its result while this request was in flight.
        store.session = sessionWithSavedMcpTokens(store.session, binding, { access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "Bearer" });
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      assert.equal(presented, "rotated-refresh");
      return Response.json({ access_token: "next-access", refresh_token: "next-refresh", token_type: "Bearer" });
    }
    return Response.json({ issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: "https://auth.example/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
  };
  assert.equal(await authorizeMcp(provider, { serverUrl: serviceUrl, fetch: fetchFn }), "AUTHORIZED");
  assert.equal(posts, 2);
  assert.equal(store.session.tokens?.access_token, "next-access");
  // Whereas the tokens a provider itself observed are still revocable.
  assert.equal(sessionAfterTokenInvalidation(store.session, { access_token: "next-access", refresh_token: "next-refresh" })?.tokens, undefined);
});

test("a delayed refresh holding a consumed token never rolls back tokens two later rotations saved", async () => {
  const authority = rotatingAuthority("delayed");
  const store = { session: { authorizationBinding: mcpAuthorizationBinding(serviceUrl), tokens: authority.initialTokens() } as McpOAuthSession };
  const fetchFn = createMcpFetchPolicy({
    serviceUrl,
    fetch: async (input, init) => (await authority.fetch(input, init)) ?? new Response(null, { status: 404 }),
  });
  let captured = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  // This client reads refresh token 1, then stalls before presenting it.
  const delayed = authorizeMcp(storeBackedProvider(store, async () => { captured = true; await held; }), { serverUrl: serviceUrl, fetch: fetchFn });
  await until(() => captured);
  // Meanwhile other clients rotate 1 -> 2 -> 3 and persist each result.
  assert.equal(await authorizeMcp(storeBackedProvider(store), { serverUrl: serviceUrl, fetch: fetchFn }), "AUTHORIZED");
  assert.equal(await authorizeMcp(storeBackedProvider(store), { serverUrl: serviceUrl, fetch: fetchFn }), "AUTHORIZED");
  assert.equal(store.session.tokens?.refresh_token, "delayed-refresh-3");
  release();
  assert.equal(await delayed, "AUTHORIZED");
  const latest = authority.initialTokens();
  assert.equal(store.session.tokens?.refresh_token, latest.refresh_token, "the stored refresh token is the authority's newest");
  assert.equal(store.session.tokens?.access_token, latest.access_token);
  // And it still works for the next rotation.
  const before = authority.refreshPosts();
  assert.equal(await authorizeMcp(storeBackedProvider(store), { serverUrl: serviceUrl, fetch: fetchFn }), "AUTHORIZED");
  assert.equal(authority.refreshPosts(), before + 1);
  assert.equal(store.session.tokens?.refresh_token, authority.initialTokens().refresh_token);
});

test("a request cancelled while its 401 refresh is pending is never re-sent", async (t) => {
  const authority = rotatingAuthority("cancelled");
  const store = { session: { authorizationBinding: mcpAuthorizationBinding(serviceUrl), tokens: authority.initialTokens() } as McpOAuthSession };
  const toolCalls: unknown[] = [];
  const cancellations: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const oauth = await authority.fetch(input, init);
    if (oauth) return oauth;
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    if (request.method === "tools/call") toolCalls.push(request.id);
    if (request.method === "notifications/cancelled") cancellations.push(request.params.requestId);
    if (!authority.accepts(init)) {
      return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    if (request.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize" ? initialized : { content: [] } });
  };
  const client = new McpClient({ name: "cancel-regression", version: "1" });
  client.onError(() => {});
  t.after(() => client.close());
  await client.connect(createMcpRemoteTransport({ serviceUrl, fetch, authProvider: storeBackedProvider(store) }));
  authority.expire();
  authority.hold();
  const controller = new AbortController();
  const call = callMcpTool(client, { name: "example", arguments: {} }, { signal: controller.signal });
  await until(() => authority.refreshPosts() >= 1);
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(call, /caller cancelled/u);
  authority.release();
  await until(() => cancellations.length >= 2);
  await delay(20);
  assert.equal(toolCalls.length, 1, "the cancelled tools/call reached the server only once, before the refresh");
  assert.equal(store.session.tokens?.access_token, authority.valid(), "refreshed tokens persist");
  // The connection itself remains usable after the refresh.
  assert.deepEqual((await client.callTool("example", {})).content, []);
});
