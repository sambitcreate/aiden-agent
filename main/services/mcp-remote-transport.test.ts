import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { GenerationBoundConnectionCache } from "./generation-bound-connection-cache.js";
import { createMcpRemoteTransport } from "./mcp-remote-transport.js";
import { observeSseReauthentication } from "./mcp-sse-auth-lifecycle.js";

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
  assert.fail("SDK transport did not reach the expected state");
}

function harness(transport: "http" | "sse", fetch: typeof globalThis.fetch, authProvider?: OAuthClientProvider) {
  const cache = new GenerationBoundConnectionCache<Client>();
  const errors: Error[] = [];
  let created = 0;
  const acquire = () => cache.getOrConnect(
    "server",
    () => {
      created += 1;
      const client = new Client({ name: "remote-regression", version: "1" });
      client.onerror = (error) => errors.push(error);
      return client;
    },
    async (client, isCurrent, onClosed) => {
      client.onclose = onClosed;
      await client.connect(createMcpRemoteTransport({
        transport, serviceUrl, fetch, authProvider, isCurrent, onTerminalFailure: onClosed,
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
    const fixture = harness("http", async (_input, init) => {
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
    assert.equal((await first.listTools()).tools.length, 1);
    failure = 503;
    await assert.rejects(first.listTools(), /503|fixture failure/);
    assert.equal(await fixture.acquire(), first, "a temporary POST failure keeps the session");
    failure = 0;
    assert.equal((await first.listTools()).tools.length, 1);
    failure = 404;
    await assert.rejects(first.callTool({ name: "example", arguments: {} }));
    assert.equal(calls, 1, "the failed call is never replayed");
    failure = 0;
    const next = await fixture.acquire();
    assert.equal(next === first, !stateful, "only an established session's 404 proves session loss");
    assert.equal((await next.listTools()).tools.length, 1);
    assert.equal(fixture.created(), stateful ? 2 : 1);
    assert.equal(calls, 1);
  });
}

function sseFixture() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let gets = 0;
  let stopNext: number | undefined;
  const encoder = new TextEncoder();
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    if (init?.method !== "POST") {
      gets += 1;
      if (stopNext) {
        const status = stopNext;
        stopNext = undefined;
        return new Response(null, { status, headers: { "content-type": "text/plain" } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(encoder.encode("retry: 1\nevent: endpoint\ndata: /messages\n\n"));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    const request = JSON.parse(String(init?.body));
    if (request.id !== undefined) {
      const result = request.method === "initialize" ? initialized : { tools };
      stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n\n`));
    }
    return new Response(null, { status: 202 });
  };
  return {
    fetch, gets: () => gets,
    interrupt(status?: number) { stopNext = status; stream.close(); },
  };
}

for (const status of [204, 200, undefined]) {
  const terminal = status !== undefined;
  test(`SSE ${terminal ? `terminal ${status} response evicts` : "recoverable EOF retains"} the owning cached client`, async (t) => {
    const remote = sseFixture();
    const fixture = harness("sse", remote.fetch);
    t.after(() => fixture.cache.disconnect("server"));
    const first = await fixture.acquire();
    assert.equal((await first.listTools()).tools.length, 1);
    remote.interrupt(status);
    await until(() => remote.gets() === 2);
    if (terminal) {
      await until(() => fixture.errors.some((error) => error instanceof SseError && error.code === status));
    } else {
      await until(() => fixture.errors.some((error) => error instanceof SseError && error.code === undefined));
    }
    const next = await fixture.acquire();
    assert.equal(next === first, !terminal);
    assert.equal((await next.listTools()).tools.length, 1);
    assert.equal(fixture.created(), terminal ? 2 : 1);
  });
}

for (const terminal of [true, false]) {
  test(`HTTP GET reconnect ${terminal ? "session loss evicts and cancels retries" : "transient failure keeps the session"}`, async (t) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let gets = 0;
    let failNextGet = false;
    const encoder = new TextEncoder();
    const fixture = harness("http", async (_input, init) => {
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
    await until(() => fixture.errors.some((error) => error instanceof StreamableHTTPError));
    if (!terminal) await until(() => gets === 3);
    const next = await fixture.acquire();
    assert.equal(next === first, !terminal);
    assert.equal((await next.listTools()).tools.length, 1);
    assert.equal(fixture.created(), terminal ? 2 : 1);
    await until(() => gets === 3);
    await delay(20);
    assert.equal(gets, 3, "no abandoned old-session retry outlives terminal teardown");
    if (terminal) assert.equal(first.transport, undefined);
  });
}

test("HTTP tools/list POST succeeds on the same session after optional GET retries are exhausted", async (t) => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let gets = 0;
  const discoverySessions: Array<string | null> = [];
  const fixture = harness("http", async (_input, init) => {
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
  assert.equal((await first.listTools()).tools.length, 1);
  await until(() => gets === 1);
  stream.close();
  await until(() => fixture.errors.some((error) => error.message === "Maximum reconnection attempts (2) exceeded."));
  assert.equal(gets, 3, "the optional GET stream made both retries before exhausting");
  const cached = await fixture.acquire();
  assert.equal(cached, first);
  assert.equal((await cached.listTools()).tools[0].name, "example");
  assert.deepEqual(discoverySessions, ["retained-session", "retained-session"]);
  assert.equal(fixture.created(), 1, "no new initialization was needed for successful discovery");
  assert.ok(first.transport, "the session remains attached after optional stream exhaustion");
});

function authenticatedFixture(kind: "http" | "sse", mode: "failed" | "successful" | "transient") {
  let tokens: OAuthTokens = { access_token: "old-token", refresh_token: "refresh-token", token_type: "Bearer" };
  let rejectOldToken = false;
  let refreshFails = mode === "failed";
  let transient = mode === "transient";
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let receives = false;
  let gets = 0;
  let refreshes = 0;
  const encoder = new TextEncoder();
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:41432/callback",
    clientMetadata: { redirect_uris: ["http://127.0.0.1:41432/callback"] },
    clientInformation: () => ({ client_id: "fixture-client" }),
    tokens: () => tokens,
    saveTokens: (next) => { tokens = next; },
    redirectToAuthorization: () => { throw new Error("fixture sign-in required"); },
    saveCodeVerifier: () => {},
    codeVerifier: () => "fixture-verifier",
  };
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
          controller.enqueue(encoder.encode(kind === "sse"
            ? "retry: 1\nevent: endpoint\ndata: /messages\n\n"
            : "retry: 1\n\n"));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (rejectOldToken && headers.get("authorization") === "Bearer old-token") {
      return new Response(null, { status: 401 });
    }
    const request = JSON.parse(String(init?.body));
    const result = request.method === "initialize" ? initialized : { tools };
    if (kind === "http" && request.id !== undefined) {
      return Response.json({ jsonrpc: "2.0", id: request.id, result }, {
        headers: { "mcp-session-id": "authenticated-session" },
      });
    }
    if (kind === "sse" && receives && request.id !== undefined) {
      stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n\n`));
    }
    return new Response(null, { status: 202 });
  };
  return { provider, fetch, gets: () => gets, refreshes: () => refreshes, receives: () => receives,
    interrupt() { rejectOldToken = true; receives = false; stream.close(); },
    recoverAuthorization() { refreshFails = false; },
  };
}

for (const kind of ["sse", "http"] as const) {
  for (const mode of ["failed", "successful", "transient"] as const) {
    test(`${kind}: ${mode} stream reauthentication preserves only usable cached clients`, async (t) => {
      const remote = authenticatedFixture(kind, mode);
      const fixture = harness(kind, remote.fetch, remote.provider);
      t.after(() => fixture.cache.disconnect("server"));
      const first = await fixture.acquire();
      assert.equal((await first.listTools()).tools.length, 1);
      remote.interrupt();
      if (mode === "failed") {
        if (kind === "http") {
          await until(() => fixture.errors.some((error) => error.message === "Maximum reconnection attempts (2) exceeded."));
        } else {
          await until(() => fixture.errors.some((error) => error.message === "fixture sign-in required"));
        }
        remote.recoverAuthorization();
        if (kind === "sse") {
          // A closed legacy SSE receive stream cannot deliver even a successful
          // POST response. The baseline times out here despite refreshing tokens.
          await assert.rejects(first.listTools(undefined, { timeout: 25 }));
        }
      } else {
        await until(() => remote.receives(), 2500);
      }
      const next = await fixture.acquire();
      assert.equal(next === first, kind === "http" || mode !== "failed");
      assert.equal((await next.listTools()).tools[0].name, "example");
      assert.equal(fixture.created(), kind === "sse" && mode === "failed" ? 2 : 1);
      assert.ok(remote.refreshes() > 0, "the real SDK performed token refresh");
    });
  }
}

test("SSE auth compatibility seam fails closed on changed SDK shapes and preserves the receiver", async () => {
  for (const transport of [{}, { _authThenStart: 42 }]) {
    assert.throws(() => observeSseReauthentication(transport, () => {}), /Unsupported MCP SDK/);
  }
  const failure = new Error("reauthentication failed");
  for (const state of [undefined, 0, 1, 2, 3]) {
    let retired = 0;
    const transport = {
      _eventSource: { readyState: state },
      async _authThenStart() {
        assert.equal(this, transport, "the SDK method receiver is preserved");
        throw failure;
      },
    };
    observeSseReauthentication(transport, () => { retired += 1; });
    await assert.rejects(transport._authThenStart(), (error) => error === failure);
    assert.equal(retired, state === 0 || state === 1 ? 0 : 1);
  }
});

test("a late SSE auth failure cannot evict a replacement connection", async () => {
  type Transport = { _eventSource: { readyState: number }; _authThenStart: () => Promise<void> };
  const cache = new GenerationBoundConnectionCache<Transport>();
  let rejectAuth!: (error: Error) => void;
  let closeFirst!: () => void;
  const acquire = () => cache.getOrConnect("server", () => ({
    _eventSource: { readyState: 2 },
    _authThenStart: () => new Promise<void>((_resolve, reject) => { rejectAuth = reject; }),
  }), async (transport, _isCurrent, onClosed) => {
    closeFirst = onClosed;
    observeSseReauthentication(transport, onClosed);
  }, async () => {});
  const first = await acquire();
  const authenticating = first._authThenStart();
  const rejected = assert.rejects(authenticating, /late auth failure/);
  closeFirst();
  const replacement = await acquire();
  rejectAuth(new Error("late auth failure"));
  await rejected;
  assert.equal(await acquire(), replacement);
  assert.notEqual(replacement, first);
  await cache.disconnect("server");
});
