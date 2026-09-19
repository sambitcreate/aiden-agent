import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { GenerationBoundConnectionCache } from "./generation-bound-connection-cache.js";
import { createMcpRemoteTransport } from "./mcp-remote-transport.js";

const serviceUrl = "https://mcp.example/mcp";
const initialized = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
  serverInfo: { name: "fixture", version: "1" },
};
const tools = [{ name: "example", inputSchema: { type: "object" } }];

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail("SDK transport did not reach the expected state");
}

function harness(transport: "http" | "sse", fetch: typeof globalThis.fetch) {
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
        transport, serviceUrl, fetch, isCurrent, onTerminalFailure: onClosed,
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
