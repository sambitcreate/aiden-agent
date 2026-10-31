import assert from "node:assert/strict";
import test from "node:test";
import { JSON_RPC_ERROR_CODES, LATEST_PROTOCOL_VERSION, McpClient, McpError, type JsonRpcMessage } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpResourceTool, listMcpResourcesPage, listMcpResourceTemplatesPage, mcpResourceToolName, MCP_RESOURCE_LIMITS, readMcpResource } from "./mcp-resources.js";
import { connectSdkServer } from "./mcp-test-support.js";
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
/** The resource port the MCP manager builds over a live client. */
function clientPort(client: McpClient): Port {
  return {
    listResources: (params, options) => listMcpResourcesPage(client, params, options),
    listResourceTemplates: (params, options) => listMcpResourceTemplatesPage(client, params, options),
    readResource: (params, options) => readMcpResource(client, params, options),
  };
}
function fixture(client = port(), id = identity.id) {
  const registry = new McpConfigurationLeaseRegistry();
  return { registry, tool: createMcpResourceTool({ ...identity, id }, client, registry.acquire(id)) };
}

test("real resources-only server lists pages/templates and reads only expanded handles", async (t) => {
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
  const client = new McpClient({ name: "test", version: "1" });
  await client.connect(await connectSdkServer(server));
  t.after(async () => { await client.close(); await server.close(); });
  const { tool } = fixture(clientPort(client));
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
  const named = (tool: string) => mcpAgentToolName(identity, tool, { configured: [identity], inventory: [tool] });
  assert.notEqual(mcpResourceToolName(identity), named("resources"));
  assert.notEqual(mcpResourceToolName(identity), named(mcpResourceToolName(identity)));
});

test("inventory is frozen for a generation despite subsequent remote list changes", async () => {
  let uri = "memo://first"; let lists = 0;
  const { tool } = fixture(port({ listResources: async () => { lists++; return { resources: [{ name: "Doc", uri }] }; } }));
  const first = await invoke(tool, { action: "list" }); uri = "memo://replacement";
  assert.deepEqual(await invoke(tool, { action: "list" }), first);
  assert.equal(lists, 1);
});

for (const end of [null, ""]) {
  test(`real resource lists ending with nextCursor ${JSON.stringify(end)} publish every page`, async (t) => {
    // Wire-level fixture: the SDK Server would not emit these legal end markers itself.
    const { client: clientSide, server: serverSide } = createInMemoryTransportPair();
    const methods: string[] = [];
    serverSide.onMessage((message: JsonRpcMessage) => {
      if (!("method" in message) || !("id" in message)) return;
      methods.push(message.method);
      const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
      const result = message.method === "initialize"
        ? { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { resources: {} }, serverInfo: { name: "raw", version: "1" } }
        : message.method === "resources/list"
          ? { resources: [{ name: cursor ? "Second" : "First", uri: cursor ? "memo://two" : "memo://one" }], nextCursor: cursor ? end : "page-two" }
          : { resourceTemplates: [{ name: "Query", uriTemplate: "memo://query/{q}" }], nextCursor: end };
      void serverSide.send({ jsonrpc: "2.0", id: message.id, result });
    });
    await serverSide.start();
    const client = new McpClient({ name: "test", version: "1" });
    await client.connect(clientSide);
    t.after(async () => { await client.close(); });
    const { tool } = fixture(clientPort(client));
    const { resources } = await invoke(tool, { action: "list" });
    assert.deepEqual(resources.map(({ name }: { name: string }) => name), ["First", "Second", "Query"]);
    assert.deepEqual(methods.filter((method) => method !== "initialize"), ["resources/list", "resources/list", "resources/templates/list"]);
  });
}

test("pagination cycles and excess pages or entries list a truncated inventory; oversized metadata fails closed", async () => {
  for (const client of [
    port({ listResources: async () => ({ resources: [{ name: "Doc", uri: "memo://one" }], nextCursor: "repeat" }) }),
    port({ listResources: async ({ cursor } = {}) => ({ resources: [{ name: `Doc ${cursor ?? "0"}`, uri: `memo://${cursor ?? "0"}` }], nextCursor: (Number(cursor ?? "0") + 1).toString() }) }),
    port({ listResources: async () => ({ resources: Array.from({ length: 129 }, (_, index) => ({ name: "Doc", uri: `memo://${index}` })) }) }),
  ]) {
    const { tool } = fixture(client);
    const listed = await invoke(tool, { action: "list" });
    assert.equal(listed.truncated, true);
    assert.ok(listed.resources.length >= 1 && listed.resources.length <= MCP_RESOURCE_LIMITS.entries);
    assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= MCP_RESOURCE_LIMITS.bytes);
    // Every listed handle stays readable; nothing beyond the listing is.
    assert.equal((await invoke(tool, { action: "read", handle: listed.resources[0].handle })).contents.length, 1);
    await assert.rejects(invoke(tool, { action: "read", handle: "forged" }));
  }
  const { tool: complete } = fixture();
  assert.equal((await invoke(complete, { action: "list" })).truncated, undefined);
  const { tool } = fixture(port({ listResources: async () => ({ resources: [{ name: "x".repeat(2049), uri: "memo://one" }] }) }));
  await assert.rejects(invoke(tool, { action: "list" }), /bounds|limit/);
});

test("large listings stop within the response budget instead of failing", async () => {
  const { tool } = fixture(port({ listResources: async () => ({ resources: Array.from({ length: 100 }, (_, index) => ({ name: `Doc ${index} ${"n".repeat(400)}`, uri: `memo://${index}` })) }) }));
  const listed = await invoke(tool, { action: "list" });
  assert.equal(listed.truncated, true);
  assert.ok(listed.resources.length > 10 && listed.resources.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= MCP_RESOURCE_LIMITS.bytes);
});

test("a listing that ends within the truncation note's bytes of the limit still lists, and listing again reuses it", async () => {
  // Handles are fixed-length UUIDs, so sweeping the name length walks the final
  // entry across every byte of headroom below the response limit.
  for (let pad = 0; pad < 100; pad += 1) {
    const { tool } = fixture(port({
      listResources: async () => ({ resources: Array.from({ length: 128 }, (_, index) => ({ name: `Doc ${index} ${"n".repeat(300 + pad)}`, uri: `memo://${index}` })) }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
    }));
    const listed = await invoke(tool, { action: "list" });
    assert.equal(listed.truncated, true, `pad ${pad}`);
    assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= MCP_RESOURCE_LIMITS.bytes);
    const again = await invoke(tool, { action: "list" });
    assert.deepEqual(again.resources.map(({ handle }: { handle: string }) => handle), listed.resources.map(({ handle }: { handle: string }) => handle));
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

test("oversized resource text keeps its start and end with the full size; URI metadata still fails closed", async () => {
  const { tool: invalid } = fixture(port({ readResource: async () => ({ contents: [{ uri: "x".repeat(2049), text: "secret" }] }) }));
  await assert.rejects(invoke(invalid, { action: "read", handle: (await invoke(invalid, { action: "list" })).resources[0].handle }), /bounds|limit/);
  const text = "START" + "é\n\"".repeat(MCP_RESOURCE_LIMITS.bytes) + "END-OF-RESOURCE";
  const { tool: large } = fixture(port({ readResource: async ({ uri }) => ({ contents: [{ uri, text }, { uri, text: "second" }] }) }));
  const read = await large.execute("call", { action: "read", handle: (await invoke(large, { action: "list" })).resources[0].handle });
  const serialized = (read.content[0] as { text: string }).text;
  assert.ok(Buffer.byteLength(serialized) <= MCP_RESOURCE_LIMITS.bytes);
  const result = JSON.parse(serialized);
  assert.match(result.contents[0].text, /^START/u);
  assert.match(result.contents[0].text, /END-OF-RESOURCE$/u);
  assert.match(result.contents[0].text, new RegExp(`${Buffer.byteLength(text)} bytes in full`, "u"));
  // Later blocks that no longer fit are named, never silently dropped.
  assert.ok(result.contents.length === 2);
  assert.ok(result.contents[1].text === "second" || /omitted/u.test(result.contents[1].omitted));

  const { tool } = fixture(port({ readResource: async ({ uri }) => ({ contents: [{ uri, blob: "secret binary" }] }) }));
  const { resources } = await invoke(tool, { action: "list" });
  const binary = await invoke(tool, { action: "read", handle: resources[0].handle });
  assert.ok(binary.contents[0].omitted);
  assert.ok(!JSON.stringify(binary).includes("secret binary"));
});

 test("optional discovery methods may be absent, but other errors are never treated as empty inventories", async () => {
  const { tool } = fixture(port({ listResourceTemplates: async () => { throw new McpError(JSON_RPC_ERROR_CODES.methodNotFound, "unsupported"); } }));
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
    await assert.rejects(invoke(tool, { action: "list" }), /Unsupported MCP resource template/);
    await assert.rejects(invoke(tool, {
      action: "read", handle: "unpublished",
      variables: { tenant: "x@attacker.example#/?&=%", version: "v1" },
    }), /List this server/);
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

test("discovery rejects unsupported single-variable operators and modifiers before publishing any handles", async () => {
  for (const expression of [";id", "?id", "&id", "+id", "#id", ".id", "/id", "id:3", "id*", "id,other", "id.other", "%69d", "", "{id"]) {
    let reads = 0;
    const { tool } = fixture(port({
      listResourceTemplates: async () => ({ resourceTemplates: [{ name: "Unsupported", uriTemplate: `memo://root/{${expression}}` }] }),
      readResource: async () => { reads++; return { contents: [] }; },
    }));
    await assert.rejects(invoke(tool, { action: "list" }), /Unsupported|Malformed/);
    await assert.rejects(invoke(tool, { action: "read", handle: "unpublished", variables: { id: "x" } }), /List this server/);
    assert.equal(reads, 0);
  }
});

test("accepted plain expansions encode every reserved character and Unicode without double encoding literals", async () => {
  const { tool } = fixture(port({ listResourceTemplates: async () => ({ resourceTemplates: [{ name: "Plain", uriTemplate: "memo://root/%20/{id}/{id}" }] }) }));
  const { resources } = await invoke(tool, { action: "list" });
  const result = await invoke(tool, { action: "read", handle: resources[1].handle, variables: { id: "!'()*:/?#[]@%é" } });
  const encoded = "%21%27%28%29%2A%3A%2F%3F%23%5B%5D%40%25%C3%A9";
  assert.equal(result.requestedUri, `memo://root/%20/${encoded}/${encoded}`);
});

test("resource reads return bounded raster content with URI metadata and no inline binary strings", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
  const { tool } = fixture(port({ readResource: async ({ uri }) => ({ contents: [
    { uri, text: "A small diagram" },
    { uri: "memo://image", mimeType: "image/png", blob: png },
    { uri: "memo://binary", mimeType: "application/octet-stream", blob: "cHJpdmF0ZSBiaW5hcnk=" },
  ] }) }));
  const { resources } = await invoke(tool, { action: "list" });
  const result = await tool.execute("image-read", { action: "read", handle: resources[0].handle });
  assert.deepEqual(result.content[1], { type: "image", mimeType: "image/png", data: png });
  const metadata = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(metadata.requestedUri, "memo://private/one");
  assert.equal(metadata.contents[0].text, "A small diagram");
  assert.equal(metadata.contents[1].uri, "memo://image");
  assert.match(metadata.contents[1].image, /Attached/u);
  assert.match(metadata.contents[2].omitted, /no file was created/u);
  assert.ok(!JSON.stringify(metadata).includes(png));
  assert.ok(!JSON.stringify(result).includes("cHJpdmF0ZSBiaW5hcnk="));
});

test("resource image validation rejects MIME mismatch, malformed/oversized data and excess images", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
  const { tool } = fixture(port({ readResource: async ({ uri }) => ({ contents: [
    { uri, mimeType: "image/png", blob: "!!!!" },
    { uri, mimeType: "image/jpeg", blob: png },
    { uri, mimeType: "image/png", blob: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") },
    { uri, mimeType: "image/svg+xml", blob: Buffer.from("<svg/>").toString("base64") },
    ...Array.from({ length: 5 }, (_, index) => ({ uri: `memo://valid/${index}`, mimeType: "image/png", blob: png })),
  ] }) }));
  const { resources } = await invoke(tool, { action: "list" });
  const result = await tool.execute("image-read", { action: "read", handle: resources[0].handle });
  assert.equal(result.content.filter((part) => part.type === "image").length, 4);
  const metadata = JSON.parse((result.content[0] as { text: string }).text);
  for (const index of [0, 1, 2, 3, 8]) assert.match(metadata.contents[index].omitted, /image omitted/u);
  assert.equal(metadata.contents.filter((part: { image?: string }) => part.image).length, 4);
});
