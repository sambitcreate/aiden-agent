import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema, type ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { inspectInitializedMcpStatus } from "./mcp-status.js";
import { GenerationBoundConnectionAttempts } from "./generation-bound-connection-cache.js";

async function fixture(capabilities: ServerCapabilities, fail = false) {
  let requests = 0;
  const server = new Server({ name: "status-fixture", version: "1" }, { capabilities });
  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      requests += 1;
      if (fail) throw new Error("tool discovery unavailable");
      return { tools: [{ name: "read", inputSchema: { type: "object" as const } }] };
    });
  }
  const client = new Client({ name: "status-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, requests: () => requests, close: async () => { await client.close(); await server.close(); } };
}

test("initialized capability extensions survive successful tool discovery without aliasing SDK state", async (t) => {
  const capabilities = { tools: { listChanged: true }, resources: { subscribe: false }, extensions: { "vendor/feature": { nested: { version: 2 } } } };
  const f = await fixture(capabilities);
  t.after(f.close);
  const status = await inspectInitializedMcpStatus(f.client, () => true);
  assert.deepEqual(status, { connected: true, tools: ["read"], toolCount: 1, serverCapabilities: capabilities });
  assert.equal(f.requests(), 1);
  f.client.getServerCapabilities()!.extensions!["vendor/feature"] = { changed: true };
  assert.deepEqual(status.serverCapabilities, capabilities);
});

test("tool discovery failure retains this initialized server's advertised capabilities", async (t) => {
  const capabilities = { tools: {}, extensions: { "vendor/feature": { enabled: true } }, experimental: { custom: {} } };
  const f = await fixture(capabilities, true);
  t.after(f.close);
  const status = await inspectInitializedMcpStatus(f.client, () => true);
  assert.equal(status.connected, false);
  assert.deepEqual(status.tools, []);
  assert.equal(status.toolCount, 0);
  assert.match(status.error!, /tool discovery unavailable/u);
  assert.deepEqual(status.serverCapabilities, capabilities);
});

test("resources-only and empty-capability servers do not receive unsupported tools/list", async (t) => {
  for (const capabilities of [{ resources: { listChanged: true }, prompts: {} }, {}]) {
    const f = await fixture(capabilities);
    t.after(f.close);
    const status = await inspectInitializedMcpStatus(f.client, () => true);
    assert.deepEqual(status, { connected: true, toolCount: 0, tools: [], serverCapabilities: capabilities });
    assert.equal(f.requests(), 0);
  }
});

test("separate status clients never reuse capabilities from another server", async (t) => {
  const first = await fixture({ tools: {}, extensions: { "first/private": {} } }, true);
  const second = await fixture({});
  t.after(first.close); t.after(second.close);
  assert.ok((await inspectInitializedMcpStatus(first.client, () => true)).serverCapabilities?.extensions);
  assert.deepEqual((await inspectInitializedMcpStatus(second.client, () => true)).serverCapabilities, {});
});

test("revocation during successful or failed discovery never returns stale metadata", async () => {
  for (const fails of [false, true]) {
    let current = true;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const pending = inspectInitializedMcpStatus({
      getServerCapabilities: () => ({ tools: {}, extensions: { "private/stale": {} } }),
      listTools: async () => {
        await barrier;
        if (fails) throw new Error("discovery failure");
        return { tools: [] };
      },
    }, () => current);
    current = false;
    release();
    await assert.rejects(pending, /superseded/u);
  }
});

test("generation-bound status disconnect rejects stale capabilities and permits a clean replacement", async () => {
  const attempts = new GenerationBoundConnectionAttempts<{ version: number }>();
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let closes = 0;
  const stale = attempts.run("server", 0, () => ({ version: 1 }), async () => {},
    (_client, isCurrent) => inspectInitializedMcpStatus({
      getServerCapabilities: () => ({ tools: {}, extensions: { "private/stale": {} } }),
      listTools: async () => { entered(); await barrier; return { tools: [] }; },
    }, isCurrent), async () => { closes += 1; });
  await started;
  await attempts.disconnect("server");
  release();
  await assert.rejects(stale, /superseded/u);
  const replacement = await attempts.run("server", attempts.generation("server"), () => ({ version: 2 }), async () => {},
    (_client, isCurrent) => inspectInitializedMcpStatus({
      getServerCapabilities: () => ({}), listTools: async () => { throw new Error("must not discover"); },
    }, isCurrent), async () => { closes += 1; });
  assert.deepEqual(replacement.serverCapabilities, {});
  assert.ok(closes >= 2);
});
