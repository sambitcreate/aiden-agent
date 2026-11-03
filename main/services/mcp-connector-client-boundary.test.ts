import assert from "node:assert/strict";
import test from "node:test";
import { botConnectorInventoryServer, withBotConnectorInventoryScope } from "./bot-connector-inventory-scope.js";
import { GenerationBoundConnectionCache } from "./generation-bound-connection-cache.js";
import { bindMcpConnectorInventoryScope, existingOrConnectMcpClient } from "./mcp-connector-client-boundary.js";
import { McpBuiltToolsMemo } from "./mcp-tool-discovery-core.js";

function fixture() {
  const cache = new GenerationBoundConnectionCache<{ id: number }>();
  let connections = 0;
  const connect = (id: string) => existingOrConnectMcpClient({
    peek: () => cache.peekConnected(id),
    connect: () => cache.getOrConnect(id, () => ({ id: ++connections }), async () => {}, async () => {}),
  });
  return { cache, connect, connections: () => connections };
}

test("watch assembly uses approved live clients and cannot connect a cache-only second server", async (t) => {
  const f = fixture(); t.after(() => f.cache.shutdown());
  const selected = await f.connect("selected");
  await withBotConnectorInventoryScope("selected", async () => {
    assert.equal(await f.connect("selected"), selected);
    await assert.rejects(f.connect("other-catalog-only"), /foreground/u);
  });
  assert.equal(f.connections(), 1);
  assert.equal((await f.connect("other-catalog-only")).id, 2, "ordinary foreground assembly still connects another server");
});

test("a watch does not join a foreground transport that is still awaiting approval", { timeout: 2_000 }, async (t) => {
  const cache = new GenerationBoundConnectionCache<object>(); t.after(() => cache.shutdown());
  let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); t.after(() => release());
  const foreground = cache.getOrConnect("selected", () => ({}), () => waiting, async () => {});
  await withBotConnectorInventoryScope("selected", async () => {
    await assert.rejects(existingOrConnectMcpClient({ peek: () => cache.peekConnected("selected"), connect: () => foreground }), /foreground/u);
  });
  release(); await foreground;
  assert.ok(cache.peekConnected("selected"));
});

test("a tool or resource built for a watch retains the boundary when invoked after assembly", async (t) => {
  const f = fixture(); t.after(() => f.cache.shutdown());
  await f.connect("selected");
  const execute = await withBotConnectorInventoryScope("selected", async () => bindMcpConnectorInventoryScope(async () => f.connect("selected")));
  await f.cache.closeIdle("selected");
  await assert.rejects(execute(), /foreground/u);
  assert.equal(f.connections(), 1, "the escaped callback never starts a replacement transport");
  assert.equal((await f.connect("selected")).id, 2);
  assert.equal((await execute()).id, 2, "explicit foreground repair supplies a newly approved live session");
});

test("built tool memo separates watch callbacks from an earlier attended context", async () => {
  const memo = new McpBuiltToolsMemo<{ execute: () => Promise<string | undefined> }>();
  const identity = {};
  const attended = { execute: bindMcpConnectorInventoryScope(async () => botConnectorInventoryServer()) };
  memo.set("selected", [identity, undefined], () => true, attended);
  const watch = await withBotConnectorInventoryScope("selected", async () => {
    assert.equal(memo.get("selected", [identity, "selected"]), undefined);
    return { execute: bindMcpConnectorInventoryScope(async () => botConnectorInventoryServer()) };
  });
  memo.set("selected", [identity, "selected"], () => true, watch);
  assert.equal(memo.get("selected", [identity, "selected"]), watch);
  assert.equal(memo.get("selected", [identity, undefined]), undefined);
  assert.equal(await watch.execute(), "selected");
});
