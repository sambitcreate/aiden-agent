import assert from "node:assert/strict";
import test from "node:test";
import { admitMcpProviderAuthServers, canUseProviderAuthenticatedMcp, createMcpProviderAuthenticatedFetch, mcpProviderGrantBinding, withMcpProviderOperation } from "./mcp-provider-auth-core.js";
import type { McpServer } from "./types.js";

const server: McpServer = { id: "docs", name: "Docs", enabled: true, transport: "http", url: "https://mcp.example.test/api?tenant=one", authProvider: "openai" };

test("portable provider references grant no access, and requests resolve rotated credentials only for the exact approved URL", async () => {
  let grant: string | null = null;
  const tokens = ["first-token", "rotated-token"];
  const received: Array<{ authorization: string | null; redirect?: RequestRedirect }> = [];
  let resolutions = 0;
  const fetch = createMcpProviderAuthenticatedFetch({
    server, readGrant: async () => grant, assertCurrent() {},
    resolveToken: async () => tokens[resolutions++],
    fetch: async (_input, init) => { received.push({ authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect }); return Response.json({ ok: true }); },
  });
  await assert.rejects(fetch(server.url!), /Approve/u);
  assert.equal(resolutions, 0);
  grant = mcpProviderGrantBinding(server);
  for (const endpoint of ["https://other.test/api?tenant=one", "https://mcp.example.test/api?tenant=two", "https://mcp.example.test/other?tenant=one"]) await assert.rejects(fetch(endpoint), /exact approved/u);
  assert.equal(resolutions, 0);
  await fetch(server.url!, { headers: { Authorization: "stale", Accept: "application/json" } });
  await fetch(server.url!);
  assert.deepEqual(received, [{ authorization: "Bearer first-token", redirect: "error" }, { authorization: "Bearer rotated-token", redirect: "error" }]);
  grant = null;
  const nextOperation = createMcpProviderAuthenticatedFetch({
    server, readGrant: async () => grant, assertCurrent() {}, resolveToken: async () => "token",
    fetch: async () => { throw new Error("must not dispatch"); },
  });
  await assert.rejects(nextOperation(server.url!), /Approve/u);
  assert.equal(received.length, 2);
});

test("an operation verifies its grant once, and a published revocation still fences its later requests", async () => {
  let grantReads = 0;
  let current = true;
  let dispatches = 0;
  const fetch = createMcpProviderAuthenticatedFetch({
    server, readGrant: async () => { grantReads++; return mcpProviderGrantBinding(server); },
    assertCurrent() { if (!current) throw new Error("Configuration changed"); },
    resolveToken: async () => "token",
    fetch: async () => { dispatches++; return Response.json({}); },
  });
  // initialize, initialized notification and the operation's request
  for (let i = 0; i < 3; i++) await fetch(server.url!);
  assert.equal(dispatches, 3);
  assert.equal(grantReads, 2, "checked before and after the first credential resolution only");
  current = false; // grant publication invalidates the configuration lease
  await assert.rejects(fetch(server.url!), /Configuration changed/u);
  assert.equal(dispatches, 3);
});

test("grant revocation and configuration changes during asynchronous credential resolution prevent dispatch", async () => {
  for (const change of ["grant", "configuration", "abort"]) {
    let grant: string | null = mcpProviderGrantBinding(server);
    let current = true;
    let dispatches = 0;
    const controller = new AbortController();
    const fetch = createMcpProviderAuthenticatedFetch({
      server, readGrant: async () => grant, assertCurrent() { if (!current) throw new Error("Configuration changed"); },
      async resolveToken() { if (change === "grant") grant = null; else if (change === "configuration") current = false; else controller.abort(); return "secret-token"; },
      fetch: async () => { dispatches++; return Response.json({}); },
    });
    await assert.rejects(fetch(server.url!, { signal: controller.signal }), /revoked|Configuration changed|abort/iu);
    assert.equal(dispatches, 0);
  }
  assert.notEqual(mcpProviderGrantBinding(server), mcpProviderGrantBinding({ ...server, authProvider: "anthropic" }));
  assert.notEqual(mcpProviderGrantBinding(server), mcpProviderGrantBinding({ ...server, url: "https://other.test/api" }));
});

test("unsupported bearer credentials and provider/network errors never leak credential material", async () => {
  for (const token of [undefined, "", "bad\r\ntoken", "x".repeat(32769)]) {
    const fetch = createMcpProviderAuthenticatedFetch({ server, readGrant: async () => mcpProviderGrantBinding(server), assertCurrent() {}, resolveToken: async () => token, fetch: async () => { throw new Error("must not dispatch"); } });
    await assert.rejects(fetch(server.url!), /usable bearer credential/u);
  }
  for (const phase of ["resolve", "fetch"]) {
    const fetch = createMcpProviderAuthenticatedFetch({
      server, readGrant: async () => mcpProviderGrantBinding(server), assertCurrent() {},
      resolveToken: async () => { if (phase === "resolve") throw new Error("SECRET_FROM_PROVIDER"); return "SECRET_FROM_PROVIDER"; },
      fetch: async () => { throw new Error("SECRET_FROM_PROVIDER"); },
    });
    await assert.rejects(fetch(server.url!), (error: Error) => !error.message.includes("SECRET") && !("cause" in error));
  }
});

test("provider-backed MCP stays out of Bot, scheduled, remote and child scopes even after foreground admission", () => {
  const desktop = { rendererOwner: true, workspace: true, assistant: false, bot: false, permission: "ask" };
  assert.equal(canUseProviderAuthenticatedMcp(desktop), true);
  for (const scope of [{ permission: "none" }, { bot: true }, { assistant: true }, { rendererOwner: false }, { workspace: false }, { usageSource: "scheduled" }, { interactionSurface: "telegram" }, { interactionSurface: "remote" }]) assert.equal(canUseProviderAuthenticatedMcp({ ...desktop, ...scope }), false);
  const regular = { ...server, id: "ordinary", authProvider: undefined };
  assert.deepEqual(admitMcpProviderAuthServers([server, regular], true, true).map((item) => item.id), ["docs", "ordinary"]);
  assert.deepEqual(admitMcpProviderAuthServers([server, regular], false, false).map((item) => item.id), ["ordinary"]);
  assert.throws(() => admitMcpProviderAuthServers([server], false, true), /attended desktop/u);
});


test("remote rejection bodies and headers cannot echo the bearer credential into SDK errors", async () => {
  const fetch = createMcpProviderAuthenticatedFetch({ server, readGrant: async () => mcpProviderGrantBinding(server), assertCurrent() {}, resolveToken: async () => "SECRET", fetch: async () => new Response("SECRET rejected", { status: 403, headers: { "x-secret": "SECRET" } }) });
  const result = await fetch(server.url!);
  assert.equal(result.status, 403);
  assert.equal(result.headers.get("x-secret"), null);
  assert.equal((await result.text()).includes("SECRET"), false);
});


test("operation teardown revokes pending credential refresh and later reconnects before closing the client", async () => {
  let resolutions = 0;
  let dispatches = 0;
  let release!: () => void;
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
  const refresh = new Promise<void>((resolve) => { release = resolve; });
  let request!: typeof fetch;
  let lateRefresh!: Promise<Response>;
  let closed = false;
  let closeChecks!: Promise<void>;
  await withMcpProviderOperation({
    scope: { signal: new AbortController().signal, isCurrent: () => true },
    create: () => ({}),
    async connect(_client, signal, current) {
      const authenticated = createMcpProviderAuthenticatedFetch({
        server, readGrant: async () => mcpProviderGrantBinding(server),
        assertCurrent() { assert.equal(current(), true, "connection is retired"); },
        async resolveToken() { resolutions++; if (resolutions === 2) { refreshStarted(); await refresh; } return "token"; },
        fetch: async () => { dispatches++; return Response.json({ ok: true }); },
      });
      request = (input, init) => authenticated(input, { ...init, signal });
      await request(server.url!);
    },
    async use() {
      // Simulate the SDK reconnect starting a refresh while the final RPC settles.
      lateRefresh = request(server.url!);
      await started;
      return "complete";
    },
    async close() {
      closed = true;
      release();
      closeChecks = (async () => {
        await assert.rejects(lateRefresh, /completed|retired/u);
        await assert.rejects(request(server.url!), /retired/u);
      })();
      await closeChecks;
    },
  });
  await closeChecks;
  assert.equal(closed, true);
  assert.equal(resolutions, 2);
  assert.equal(dispatches, 1);
  await assert.rejects(request(server.url!), /retired/u);
  assert.equal(resolutions, 2);
});

test("owner revocation aborts a live operation's transport before credential refresh can dispatch", async () => {
  let revoke!: () => void;
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let dispatches = 0;
  let closed = 0;
  const operation = withMcpProviderOperation({
    scope: { signal: new AbortController().signal, isCurrent: () => true, onInvalidated(listener) { revoke = listener; return () => {}; } },
    create: () => ({}),
    async connect(_client, signal, current) {
      await createMcpProviderAuthenticatedFetch({
        server, readGrant: async () => mcpProviderGrantBinding(server), assertCurrent() { assert.equal(current(), true); },
        async resolveToken() { started(); await pending; return "token"; },
        fetch: async () => { dispatches++; return Response.json({}); },
      })(server.url!, { signal });
    },
    async use() { assert.fail("revoked connection cannot publish tools"); },
    async close() { closed++; },
  });
  await ready;
  revoke();
  release();
  await assert.rejects(operation, /owner closed/u);
  assert.equal(dispatches, 0);
  assert.ok(closed >= 1);
});
