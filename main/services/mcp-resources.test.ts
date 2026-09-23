import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError, ErrorCode, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpResourceTool, mcpResourceToolName, MCP_RESOURCE_LIMITS } from "./mcp-resources.js";
import { McpConfigurationLeaseRegistry } from "./mcp-config-lease.js";
import { mcpAgentToolName } from "./mcp-tool-identity.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const identity = { id: "server-a", name: "Same label" };
type Port = Parameters<typeof createMcpResourceTool>[1];
function port(overrides: Partial<Port> = {}): Port {
  return {
    listResources: async () => ({ resources: [{ name: "Document", uri: "memo://private/one" }] }),
    listResourceTemplates: async () => ({ resourceTemplates: [{ name: "Search", uriTemplate: "memo://private/{query}" }] }),
    readResource: async ({ uri }) => ({ contents: [{ uri, text: "private text" }] }),
    ...overrides,
  };
}
async function invoke(tool: AgentTool, args: Record<string, unknown>, signal?: AbortSignal) {
  const result = await tool.execute("call", args, signal);
  const content = result.content[0];
  assert.equal(content.type, "text");
  return JSON.parse((content as { text: string }).text);
}
function fixture(client = port(), id = identity.id) {
  const registry = new McpConfigurationLeaseRegistry();
  return { registry, tool: createMcpResourceTool({ ...identity, id }, client, registry.acquire(id)) };
}

test("real resources-only SDK server lists pages/templates and reads only expanded handles", async (t) => {
  const server = new Server({ name: "resources-only", version: "1" }, { capabilities: { resources: {} } });
  const requests: string[] = [];
  server.setRequestHandler(ListResourcesRequestSchema, async ({ params }) => ({
    resources: [{ name: params?.cursor ? "Second" : "First", uri: params?.cursor ? "memo://two" : "memo://one" }],
    ...(params?.cursor ? {} : { nextCursor: "page-two" }),
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ name: "Query", uriTemplate: "memo://query/{q}" }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    requests.push(params.uri);
    return { contents: [{ uri: params.uri, text: "read" }] };
  });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const { tool } = fixture(client);
  const { resources } = await invoke(tool, { action: "list" });
  assert.equal(resources.length, 3);
  await invoke(tool, { action: "read", handle: resources[0].handle });
  await invoke(tool, { action: "read", handle: resources[2].handle, variables: { q: "a/b ?" } });
  assert.deepEqual(requests, ["memo://one", "memo://query/a%2Fb%20%3F"]);
});

test("server, generation, raw URI and remote-tool identities cannot cross authority boundaries", async () => {
  let reads = 0;
  const client = port({ readResource: async () => { reads++; return { contents: [] }; } });
  const a = fixture(client); const b = fixture(client, "server-b"); const fresh = fixture(client);
  await assert.rejects(invoke(a.tool, { action: "read", handle: "memo://private/one" }), /List this server/);
  const { resources } = await invoke(a.tool, { action: "list" });
  await invoke(b.tool, { action: "list" }); await invoke(fresh.tool, { action: "list" });
  for (const tool of [b.tool, fresh.tool]) await assert.rejects(invoke(tool, { action: "read", handle: resources[0].handle }), /does not belong/);
  await assert.rejects(invoke(a.tool, { action: "read", handle: "memo://private/one" }), /does not belong/);
  assert.equal(reads, 0);
  assert.notEqual(a.tool.name, b.tool.name);
  assert.notEqual(mcpResourceToolName(identity), mcpAgentToolName(identity, "resources"));
  assert.notEqual(mcpResourceToolName(identity), mcpAgentToolName(identity, mcpResourceToolName(identity)));
});

test("inventory is frozen for a generation despite subsequent remote list changes", async () => {
  let uri = "memo://first"; let lists = 0;
  const { tool } = fixture(port({ listResources: async () => { lists++; return { resources: [{ name: "Doc", uri }] }; } }));
  const first = await invoke(tool, { action: "list" }); uri = "memo://replacement";
  assert.deepEqual(await invoke(tool, { action: "list" }), first);
  assert.equal(lists, 1);
});

test("pagination cycles, excess pages/entries, oversized metadata fail closed", async () => {
  for (const client of [
    port({ listResources: async () => ({ resources: [], nextCursor: "repeat" }) }),
    port({ listResources: async ({ cursor } = {}) => ({ resources: [], nextCursor: (Number(cursor ?? "0") + 1).toString() }) }),
    port({ listResources: async () => ({ resources: Array.from({ length: 129 }, () => ({ name: "Doc", uri: "memo://one" })) }) }),
    port({ listResources: async () => ({ resources: [{ name: "x".repeat(2049), uri: "memo://one" }] }) }),
  ]) {
    const { tool } = fixture(client);
    await assert.rejects(invoke(tool, { action: "list" }), /bounds|limit/);
    await assert.rejects(invoke(tool, { action: "read", handle: "forged" }));
  }
});

test("configuration revocation and cancellation fence dispatch and discard late responses", async () => {
  for (const action of ["list", "read"] as const) {
    for (const revoke of [false, true]) {
      let release!: () => void; let entered!: () => void;
      const barrier = new Promise<void>((r) => { release = r; });
      const started = new Promise<void>((r) => { entered = r; });
      const blocked = async () => { entered(); await barrier; };
      const client = port(action === "list" ? { listResources: async () => { await blocked(); return { resources: [] }; } } : {
        readResource: async ({ uri }) => { await blocked(); return { contents: [{ uri, text: "late private data" }] }; },
      });
      const { registry, tool } = fixture(client);
      const controller = new AbortController();
      const args = action === "list" ? { action } : { action, handle: (await invoke(tool, { action: "list" })).resources[0].handle };
      const pending = invoke(tool, args, controller.signal);
      await started;
      if (revoke) registry.invalidate(identity.id); else controller.abort();
      release();
      await assert.rejects(pending);
      if (revoke) await assert.rejects(invoke(tool, { action: "list" }), /configuration changed/);
    }
  }
});

test("template variable set is exact and static resources reject variables", async () => {
  let reads = 0;
  const { tool } = fixture(port({ readResource: async () => { reads++; return { contents: [] }; } }));
  const { resources } = await invoke(tool, { action: "list" });
  for (const variables of [{}, { query: "x", extra: "y" }, { query: 1 }, { query: "x".repeat(2049) }]) {
    await assert.rejects(invoke(tool, { action: "read", handle: resources[1].handle, variables }));
  }
  await assert.rejects(invoke(tool, { action: "read", handle: resources[0].handle, variables: { query: "x" } }));
  assert.equal(reads, 0);
});

test("read results reject oversized text and URI metadata; binary never enters model context", async () => {
  for (const readResource of [
    async () => ({ contents: [{ uri: "x".repeat(2049), text: "secret" }] }),
    async ({ uri }: { uri: string }) => ({ contents: [{ uri, text: "é".repeat(MCP_RESOURCE_LIMITS.bytes) }] }),
  ]) {
    const { tool } = fixture(port({ readResource }));
    const { resources } = await invoke(tool, { action: "list" });
    await assert.rejects(invoke(tool, { action: "read", handle: resources[0].handle }), /bounds|limit/);
  }
  const { tool } = fixture(port({ readResource: async ({ uri }) => ({ contents: [{ uri, blob: "secret binary" }] }) }));
  const { resources } = await invoke(tool, { action: "list" });
  const result = await invoke(tool, { action: "read", handle: resources[0].handle });
  assert.ok(result.contents[0].omitted);
  assert.ok(!JSON.stringify(result).includes("secret binary"));
});

 test("optional discovery methods may be absent, but other errors are never treated as empty inventories", async () => {
  const { tool } = fixture(port({ listResourceTemplates: async () => { throw new McpError(ErrorCode.MethodNotFound, "unsupported"); } }));
  assert.equal((await invoke(tool, { action: "list" })).resources.length, 1);
  const { tool: failing } = fixture(port({ listResourceTemplates: async () => { throw new Error("unauthorized"); } }));
  await assert.rejects(invoke(failing, { action: "list" }), /unauthorized/);
});

test("repeated template variable names require one value and expand every occurrence", async () => {
  const { tool } = fixture(port({ listResourceTemplates: async () => ({ resourceTemplates: [{ name: "Repeated", uriTemplate: "memo://{id}/{id}" }] }) }));
  const { resources } = await invoke(tool, { action: "list" });
  const result = await invoke(tool, { action: "read", handle: resources[1].handle, variables: { id: "one" } });
  assert.equal(result.requestedUri, "memo://one/one");
});

test("derived response URIs are data, never handles or additional read dispatches", async () => {
  let reads = 0;
  const { tool } = fixture(port({ readResource: async () => {
    reads++;
    return { contents: [{ uri: "memo://derived/one", text: "one" }, { uri: "memo://derived/two", text: "two" }] };
  } }));
  const { resources } = await invoke(tool, { action: "list" });
  const result = await invoke(tool, { action: "read", handle: resources[0].handle });
  assert.equal(result.requestedUri, "memo://private/one");
  assert.equal(result.contents.length, 2);
  await assert.rejects(invoke(tool, { action: "read", handle: result.contents[0].uri }), /does not belong/);
  assert.equal(reads, 1);
});

test("cancelled concurrent discovery publishes no handles and a subsequent call can retry", async () => {
  let release!: () => void; let entered!: () => void; let calls = 0;
  const barrier = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { entered = r; });
  const { tool } = fixture(port({ listResources: async () => {
    if (++calls === 1) { entered(); await barrier; }
    return { resources: [{ uri: "memo://one", name: "One" }] };
  } }));
  const controller = new AbortController();
  const first = invoke(tool, { action: "list" }, controller.signal);
  await started;
  const concurrent = invoke(tool, { action: "list" });
  controller.abort(); release();
  await assert.rejects(first); await assert.rejects(concurrent);
  const result = await invoke(tool, { action: "list" });
  assert.equal(result.resources.length, 2);
  assert.equal(calls, 2);
  assert.deepEqual(await invoke(tool, { action: "list" }), result);
});

test("multi-variable templates fail closed before SDK expansion can escape URI authority", async () => {
  for (const operator of ["", "+", "#", ".", "/", ";", "?", "&"]) {
    let reads = 0;
    const { tool } = fixture(port({
      listResourceTemplates: async () => ({ resourceTemplates: [{ name: "Tenant", uriTemplate: `https://{${operator}tenant,version}.example.com/data` }] }),
      readResource: async () => { reads++; return { contents: [] }; },
    }));
    const { resources } = await invoke(tool, { action: "list" });
    await assert.rejects(invoke(tool, {
      action: "read", handle: resources[1].handle,
      variables: { tenant: "x@attacker.example#/?&=%", version: "v1" },
    }), /one variable per expression/);
    assert.equal(reads, 0);
  }
});

test("single-variable expressions encode reserved input and retain exact variable/length gates", async () => {
  const requested: string[] = [];
  const { tool } = fixture(port({
    listResourceTemplates: async () => ({ resourceTemplates: [{ name: "Tenant", uriTemplate: "https://{tenant}.example.com/data/{version}" }] }),
    readResource: async ({ uri }) => { requested.push(uri); return { contents: [] }; },
  }));
  const { resources } = await invoke(tool, { action: "list" });
  const handle = resources[1].handle;
  await invoke(tool, { action: "read", handle, variables: { tenant: "x@attacker.example#", version: "v1/?&=%" } });
  assert.deepEqual(requested, ["https://x%40attacker.example%23.example.com/data/v1%2F%3F%26%3D%25"]);
  for (const variables of [{ tenant: "x" }, { tenant: "x", version: "v1", extra: "y" }, { tenant: "x".repeat(2049), version: "v1" }]) {
    await assert.rejects(invoke(tool, { action: "read", handle, variables }));
  }
  assert.equal(requested.length, 1);
});
