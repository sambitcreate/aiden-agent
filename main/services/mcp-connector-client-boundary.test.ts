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

test("Calendar source attestation never transfers to a replacement client or changed credential/configuration epoch", async () => {
  const { McpConnectorSourceAttestations } = await import("./mcp-connector-client-boundary.js");
  const { withBotConnectorForegroundLifetime, withBotConnectorCachedInventoryScope, botConnectorInventoryCacheOnly } = await import("./bot-connector-inventory-scope.js");
  const identities = new McpConnectorSourceAttestations(), original = {}, replacement = {}; let current = true;
  const assertCurrent = () => { if (!current) throw new Error("approved session closed"); };
  assert.throws(() => identities.attest(original, 1, "a".repeat(64), assertCurrent), /foreground/u);
  await withBotConnectorForegroundLifetime({ signal: new AbortController().signal, assertCurrent }, async () => identities.attest(original, 1, "a".repeat(64), assertCurrent));
  assert.equal(identities.get(original, 1, assertCurrent), "a".repeat(64));
  assert.equal(identities.get(replacement, 1, assertCurrent), undefined);
  assert.equal(identities.get(original, 2, assertCurrent), undefined, "even the same still-closing client cannot authorize changed credentials");
  const callback = await withBotConnectorCachedInventoryScope("selected", async () => bindMcpConnectorInventoryScope(async () => { assert.equal(botConnectorInventoryCacheOnly(), true); return identities.get(original, 1, assertCurrent); }));
  assert.equal(await callback(), "a".repeat(64)); current = false; await assert.rejects(callback(), /closed/u);
});

test("actual source-scoped discovery bypasses an unrelated cleanup barrier and never invokes credential admission",{timeout:2000},async()=>{
  const {admitMcpConnectorDiscovery}=await import("./mcp-connector-client-boundary.js");
  const {withBotConnectorCachedInventoryScope}=await import("./bot-connector-inventory-scope.js");
  let admissions=0,keys=0,configured=0,runs=0,live=true,current=true,release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const ports={serverId:"selected",assertExisting(){if(!live)throw new Error("cold");},assertConfigured:async()=>{configured++;if(!current)throw new Error("config changed");},runExisting:async()=>{runs++;return "cached current tool assembly";},normalAdmission:async()=>{admissions++;await barrier;keys++;return "ordinary admitted tools";}};
  const ordinary=admitMcpConnectorDiscovery(ports);await Promise.resolve();
  await withBotConnectorCachedInventoryScope("selected",async()=>{
    assert.equal(await admitMcpConnectorDiscovery(ports),"cached current tool assembly");assert.equal(configured,1);assert.equal(admissions,1);assert.equal(keys,0);
    await assert.rejects(admitMcpConnectorDiscovery({...ports,serverId:"other"}),/another connector/u);
    live=false;await assert.rejects(admitMcpConnectorDiscovery(ports),/cold/u);live=true;current=false;await assert.rejects(admitMcpConnectorDiscovery(ports),/config changed/u);
  });
  assert.equal(runs,1);assert.equal(admissions,1);assert.equal(keys,0,"the source path neither waits for cleanup nor reads a key");release();assert.equal(await ordinary,"ordinary admitted tools");assert.equal(keys,1);
});
