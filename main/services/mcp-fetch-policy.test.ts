import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata,
  type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createMcpFetchPolicy } from "./mcp-fetch-policy.js";
import { createMcpRemoteTransport } from "./mcp-remote-transport.js";

const serviceUrl = "https://service.example/mcp";

for (const transportKind of ["http", "sse"] as const) {
  test(`${transportKind}: real SDK discovery and exchange isolate service headers and preserve OAuth`, async () => {
    const calls: { url: string; headers: Headers }[] = [];
    let tokens: OAuthTokens | undefined;
    let redirected = false;
    const provider: OAuthClientProvider = {
      get redirectUrl() { return "http://127.0.0.1:41432/callback"; },
      get clientMetadata() { return { redirect_uris: ["http://127.0.0.1:41432/callback"] }; },
      clientInformation: () => ({ client_id: "test-client" }),
      tokens: () => tokens,
      saveTokens: (value) => { tokens = value; },
      redirectToAuthorization: () => { redirected = true; },
      saveCodeVerifier: () => {},
      codeVerifier: () => "test-verifier",
    };
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      assert.equal(init?.redirect, "error");
      if (url === serviceUrl) {
        assert.equal(headers.get("x-service-key"), "synthetic-marker");
        return new Response(null, { status: 401, headers: {
          "www-authenticate": 'Bearer resource_metadata="https://service.example/.well-known/oauth-protected-resource"',
        } });
      }
      if (url.includes("oauth-protected-resource")) {
        return Response.json({ resource: serviceUrl, authorization_servers: ["https://auth.example"] });
      }
      assert.equal(headers.get("x-service-key"), null, url);
      if (url === "https://auth.example/token") {
        return Response.json({ access_token: "test-oauth-token", token_type: "Bearer" });
      }
      return Response.json({ issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token", response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"] });
    };
    const transport = createMcpRemoteTransport({ transport: transportKind, serviceUrl,
      serviceHeaders: { "X-Service-Key": "synthetic-marker" }, authProvider: provider, fetch: fake });
    const client = new Client({ name: "test", version: "1" });
    try {
      await assert.rejects(client.connect(transport), UnauthorizedError);
      assert.equal(redirected, true);
      // HTTP connect already closes on auth redirection. Explicit close also
      // covers SSE; exchange must retain metadata but start a fresh phase.
      await client.close();
      await transport.finishAuth("test-code");
      assert.equal(tokens?.access_token, "test-oauth-token");
      assert.ok(calls.some(({ url }) => url === "https://auth.example/token"));
      assert.ok(calls.some(({ url }) => url.includes("auth.example/.well-known")));
    } finally { await client.close(); }
  });
}

test("origin matching and case-insensitive SDK headers take precedence, also for Request inputs", async () => {
  const calls: Headers[] = [];
  const fetch = createMcpFetchPolicy({ serviceUrl, serviceHeaders: { Authorization: "configured", "X-Key": "marker" },
    fetch: async (_input, init) => { calls.push(new Headers(init?.headers)); return Response.json({}); } });
  await (await fetch(new Request(serviceUrl, { headers: { authorization: "Bearer oauth" } }))).text();
  await (await fetch("https://service.example:444/token", { headers: { Authorization: "Basic client" } })).text();
  assert.equal(calls[0].get("authorization"), "Bearer oauth");
  assert.equal(calls[0].get("x-key"), "marker");
  assert.equal(calls[1].get("x-key"), null);
  assert.equal(calls[1].get("authorization"), "Basic client");
});

test("configured credentials never follow a real cross-origin HTTP redirect", async (t) => {
  const { createServer } = await import("node:http");
  let destinationCalls = 0;
  const destination = createServer((_req, res) => { destinationCalls++; res.end("unexpected"); });
  const source = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${(destination.address() as { port: number }).port}/token` }); res.end();
  });
  for (const server of [destination, source]) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const url = `http://127.0.0.1:${(source.address() as { port: number }).port}/mcp`;
  await assert.rejects(createMcpFetchPolicy({ serviceUrl: url, serviceHeaders: { "X-Key": "marker" } })(url));
  assert.equal(destinationCalls, 0);
});

for (const phase of ["discovery", "registration", "token", "refresh"]) {
  test(`OAuth ${phase} request aborts at its own deadline`, async () => {
    let aborted = false;
    const fetch = createMcpFetchPolicy({ serviceUrl, oauthTimeoutMs: 10,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
      }) });
    await assert.rejects(fetch(`https://auth.example/${phase}`), /timed out/);
    assert.equal(aborted, true);
  });
}

test("OAuth deadline includes a stalled body, while an idle MCP SSE connection stays open", async () => {
  const fetch = createMcpFetchPolicy({ serviceUrl, oauthTimeoutMs: 10,
    fetch: async (url) => new Response(new ReadableStream(), { headers: {
      "content-type": String(url) === serviceUrl ? "text/event-stream" : "application/json",
    } }) });
  await assert.rejects((await fetch("https://auth.example/token")).text(), /timed out/);
  const response = await fetch(serviceUrl, { headers: { accept: "text/event-stream" } });
  const reader = response.body!.getReader();
  let settled = false;
  const reading = reader.read().then(() => { settled = true; });
  await delay(25);
  assert.equal(settled, false);
  await reader.cancel();
  await reading;
});

test("owner cancellation wins and transport close aborts in-flight OAuth requests", async () => {
  const owner = new AbortController();
  const fetch = createMcpFetchPolicy({ serviceUrl, signal: owner.signal, oauthTimeoutMs: 1000,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }) });
  const pending = fetch("https://auth.example/token");
  owner.abort(new Error("owner changed"));
  await assert.rejects(pending, /owner changed/);
  await assert.rejects(fetch("https://auth.example/token"), /owner changed/);
});

function stream(chunks: string[], contentType = "application/json", cancel?: () => void) {
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const value = chunks.shift();
      if (value === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(value));
    }, cancel,
  }, { highWaterMark: 0 }), { headers: { "content-type": contentType } });
}

test("finite bodies are bounded without Content-Length and oversized declarations are cancelled", async () => {
  let cancelled = false;
  const fetch = createMcpFetchPolicy({ serviceUrl, maximumBytes: 16,
    fetch: async () => stream(["x".repeat(12), "y".repeat(12)], "application/json", () => { cancelled = true; }) });
  await assert.rejects((await fetch(serviceUrl)).text(), /transport limit/);
  assert.equal(cancelled, true);
  const declared = createMcpFetchPolicy({ serviceUrl, maximumBytes: 16,
    fetch: async () => new Response("x", { headers: { "content-length": "17" } }) });
  await assert.rejects(declared(serviceUrl), /transport limit/);
});

test("SSE bounds span chunks and lines but reset between events, including split CRLF", async () => {
  for (const separator of ["\n\n", "\r\n\r\n", "\r\r"]) {
    const events = Array.from({ length: 30 }, () => `data: a${separator}`).join("");
    const fetch = createMcpFetchPolicy({ serviceUrl, maximumBytes: 16,
      fetch: async () => stream([...events], "text/event-stream") });
    assert.equal(await (await fetch(serviceUrl, { headers: { accept: "text/event-stream" } })).text(), events);
  }
  const fetch = createMcpFetchPolicy({ serviceUrl, maximumBytes: 16,
    fetch: async () => stream(["data: ab\n", "data: cd\n", "data: ef\n\n"], "text/event-stream") });
  await assert.rejects((await fetch(serviceUrl, { headers: { accept: "text/event-stream" } })).text(), /transport limit/);
});

test("stale connections fail before dispatch", async () => {
  let calls = 0;
  const fetch = createMcpFetchPolicy({ serviceUrl, isCurrent: () => false,
    fetch: async () => { calls++; return Response.json({}); } });
  await assert.rejects(fetch(serviceUrl), /no longer current/);
  assert.equal(calls, 0);
});

test("OAuth JSON cannot evade aggregate bounds by advertising SSE and inserting blank lines", async () => {
  const fetch = createMcpFetchPolicy({ serviceUrl, maximumBytes: 16,
    fetch: async () => stream(["\n\n".repeat(1000), "{}"], "text/event-stream") });
  await assert.rejects((await fetch("https://auth.example/token")).json(), /transport limit/);
});

test("same-path OAuth form POST has a deadline even when token and MCP endpoints coincide", async () => {
  const owner = new AbortController();
  const fetch = createMcpFetchPolicy({ serviceUrl, signal: owner.signal, oauthTimeoutMs: 10,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }) });
  const safety = setTimeout(() => owner.abort(new Error("test safety timeout")), 100);
  try {
    await assert.rejects(fetch(serviceUrl + "?operation=token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=synthetic",
    }), /authorization request timed out/);
  } finally { clearTimeout(safety); }
});

test("MCP JSON errors advertised as SSE still have a cumulative body bound", async () => {
  const fetch = createMcpFetchPolicy({ serviceUrl, maximumBytes: 16,
    fetch: async () => new Response("\n\n".repeat(1000) + "{}", {
      status: 400, headers: { "content-type": "text/event-stream" },
    }) });
  await assert.rejects((await fetch(serviceUrl, { headers: { accept: "text/event-stream" } })).text(), /transport limit/);
});

test("real SDK metadata discovery keeps its deadline despite MCP-Protocol-Version headers", async () => {
  for (const discover of [
    (fetchFn: typeof fetch) => discoverAuthorizationServerMetadata("https://auth.example", { fetchFn }),
    (fetchFn: typeof fetch) => discoverOAuthProtectedResourceMetadata(new URL(serviceUrl), undefined, fetchFn),
  ]) {
    const owner = new AbortController();
    const fetch = createMcpFetchPolicy({ serviceUrl, signal: owner.signal, oauthTimeoutMs: 10,
      fetch: async (_url, init) => {
        assert.ok(new Headers(init?.headers).has("mcp-protocol-version"));
        return new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        });
      } });
    const safety = setTimeout(() => owner.abort(new Error("test safety timeout")), 100);
    try { await assert.rejects(discover(fetch), /authorization request timed out/); }
    finally { clearTimeout(safety); }
  }
});

test("MCP RPC retains its SDK deadline instead of the shorter OAuth timeout", async () => {
  const fetch = createMcpFetchPolicy({ serviceUrl, oauthTimeoutMs: 10,
    fetch: async () => { await delay(25); return Response.json({ ok: true }); } });
  const response = await fetch(new Request(serviceUrl, { method: "POST",
    headers: { "mcp-protocol-version": "2025-11-25", "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
  }));
  assert.deepEqual(await response.json(), { ok: true });
});

test("real SDK authorization metadata body cannot stall after headers arrive", async () => {
  const fetchFn = createMcpFetchPolicy({ serviceUrl, oauthTimeoutMs: 10,
    fetch: async () => new Response(new ReadableStream(), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(discoverAuthorizationServerMetadata("https://auth.example", { fetchFn }), /timed out/);
});
