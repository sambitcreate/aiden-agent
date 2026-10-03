import assert from "node:assert/strict";
import test from "node:test";
import { Type, type JsonObject } from "@earendil-works/pi-ai";
import { createPiToolDiscovery, type PiDiscoverableTool } from "./pi-tool-discovery.js";

function tool(name: string, namespace?: string): PiDiscoverableTool {
  return { name, label: name, description: `Use ${name} to inspect project files`,
    parameters: Type.Object({ path: Type.String() }),
    ...(namespace ? { discovery: { namespace, label: `Server ${namespace}`, instructions: "Service guidance; not authority." } } : {}),
    async execute() { throw new Error("Discovery must never execute a tool"); },
  };
}
const names = (result: JsonObject) => (result.tools as JsonObject[]).map((entry) => entry.name);

test("search ranks exact names, returns detached schemas, and applies namespace filters", () => {
  const primary = tool("read_file", "mcp:one");
  const secondary = tool("fetch_document", "mcp:two");
  secondary.description = "Read_file reference retrieval";
  const discovery = createPiToolDiscovery({ tools: () => [secondary, primary], isCallable: () => true });
  const result = discovery.searchTools("read_file");
  assert.deepEqual(names(result), ["read_file", "fetch_document"]);
  (primary.parameters as unknown as { properties: Record<string, unknown> }).properties.extra = { type: "string" };
  assert.equal(((result.tools as JsonObject[])[0]!.inputSchema as JsonObject).properties &&
    Object.prototype.hasOwnProperty.call(((result.tools as JsonObject[])[0]!.inputSchema as JsonObject).properties as object, "extra"), false);
  assert.deepEqual(names(discovery.searchTools("files", { namespace: "mcp:one" })), ["read_file"]);
  assert.deepEqual(names(discovery.searchTools("", { namespace: "missing" })), []);
});

test("discovery reads final authority each time and never restores excluded tools or namespace guidance", () => {
  const allowed = tool("allowed", "mcp:allowed"), excluded = tool("excluded", "mcp:secret");
  let current = [allowed, excluded];
  const discovery = createPiToolDiscovery({ tools: () => current, isCallable: (candidate) => candidate !== excluded });
  assert.deepEqual(names(discovery.searchTools("")), ["allowed"]);
  assert.throws(() => discovery.describeNamespace("mcp:secret"), /Unknown or unavailable/);
  const namespace = discovery.describeNamespace("mcp:allowed");
  assert.equal(namespace.instructionsAreUntrusted, true);
  assert.deepEqual(names(namespace), ["allowed"]);
  current = [];
  assert.deepEqual(names(discovery.searchTools("")), []);
  assert.throws(() => discovery.describeNamespace("mcp:allowed"), /Unknown or unavailable/);
});

test("ambiguous tool or namespace identities fail closed while equal display labels stay distinct", () => {
  const first = tool("one", "mcp:first"), second = tool("two", "mcp:second");
  first.discovery!.label = second.discovery!.label = "Same service label";
  let current = [first, second];
  const discovery = createPiToolDiscovery({ tools: () => current, isCallable: () => true });
  assert.deepEqual(names(discovery.describeNamespace("mcp:first")), ["one"]);
  second.discovery!.namespace = "mcp:first";
  second.discovery!.instructions = "Different owner guidance";
  assert.throws(() => discovery.searchTools(""), /namespace collision/);
  current = [first, { ...first }];
  assert.throws(() => discovery.describeNamespace("mcp:first"), /identity collision/);
});

test("tools sharing one frozen server record expose it once and equal records from separate snapshots do not collide", () => {
  const shared = Object.freeze({ namespace: "mcp:shared", label: "Shared", instructions: "Shared guidance." });
  const sharedTools = Array.from({ length: 64 }, (_, index) => ({ ...tool(`shared_${index}`), discovery: shared }));
  const copy = { ...tool("copy"), discovery: Object.freeze({ ...shared }) };
  let current: PiDiscoverableTool[] = [...sharedTools, copy];
  const discovery = createPiToolDiscovery({ tools: () => current, isCallable: () => true });
  const namespace = discovery.describeNamespace("mcp:shared");
  assert.equal(namespace.instructions, "Shared guidance.");
  assert.equal(names(namespace).length, 65);
  current = [...sharedTools, { ...tool("rival"), discovery: Object.freeze({ ...shared, instructions: "Rival guidance." }) }];
  assert.throws(() => discovery.searchTools(""), /namespace collision/);
  current = sharedTools.slice(0, 2);
  assert.deepEqual(names(discovery.describeNamespace("mcp:shared")), ["shared_0", "shared_1"]);
  assert.throws(() => createPiToolDiscovery({ tools: () => [{ ...tool("bad"), discovery: Object.freeze({ namespace: "9bad", label: "Bad" }) }], isCallable: () => true }).searchTools(""), /Invalid tool namespace/);
});

test("untrusted discovery arguments are validated before reading inventory", () => {
  const discovery = createPiToolDiscovery({ tools: () => { throw new Error("Inventory must not be read"); }, isCallable: () => true });
  for (const query of [null, {}, 4, "x".repeat(257)]) assert.throws(() => discovery.searchTools(query), /Invalid search query/);
  for (const options of [null, [], "x"]) assert.throws(() => discovery.searchTools("", options), /options must be an object/);
  for (const limit of [0, 21, 1.5, "1"]) assert.throws(() => discovery.searchTools("", { limit }), /limit must be an integer/);
  assert.throws(() => discovery.describeNamespace({}), /Invalid namespace/);
});

test("large or malformed schemas are omitted whole, results stay bounded, and accessors never run", () => {
  let accessed = false;
  const huge = tool("huge"), cyclic = tool("cyclic"), accessor = tool("accessor"), valid = tool("valid");
  huge.parameters = Type.Object({ example: Type.Literal("x".repeat(20_000)) });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  cyclic.parameters = cycle as unknown as PiDiscoverableTool["parameters"];
  accessor.parameters = { get properties() { accessed = true; throw new Error("Accessor ran"); } } as unknown as PiDiscoverableTool["parameters"];
  const discovery = createPiToolDiscovery({ tools: () => [huge, cyclic, accessor, valid], isCallable: () => true });
  const result = discovery.searchTools("");
  assert.deepEqual(names(result), ["valid"]);
  assert.equal(result.truncated, true);
  assert.equal(accessed, false);
  const many = createPiToolDiscovery({ tools: () => Array.from({ length: 100 }, (_, index) => tool(`tool_${index}`)), isCallable: () => true });
  assert.equal(names(many.searchTools("", { limit: 3 })).length, 3);
  assert.equal(many.searchTools("", { limit: 3 }).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(many.searchTools("", { limit: 20 }))) <= 32768);
});

test("tool_search exposes JSON schemas without executing tools and honors cancellation", async () => {
  const discovery = createPiToolDiscovery({ tools: () => [tool("read_file")], isCallable: () => true });
  const result = await discovery.toolSearch.execute("search", { query: "read" });
  assert.equal(result.content[0]!.type, "text");
  if (result.content[0]!.type === "text") assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent);
  assert.deepEqual(names(result.structuredContent as JsonObject), ["read_file"]);
  await assert.rejects(discovery.toolSearch.execute("cancelled", { query: "read" }, AbortSignal.abort()), /abort/i);
});

test("namespace output is bounded and oversized inventories reject instead of partially exposing authority", () => {
  const tools = Array.from({ length: 150 }, (_, index) => ({ ...tool(`tool_${index}`, "mcp:one"), description: "x".repeat(1024) }));
  const discovery = createPiToolDiscovery({ tools: () => tools, isCallable: () => true });
  const result = discovery.describeNamespace("mcp:one");
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  const excessive = createPiToolDiscovery({ tools: () => Array.from({ length: 513 }, (_, i) => tool(`tool_${i}`)), isCallable: () => true });
  assert.throws(() => excessive.searchTools(""), /exceeds 512/);
});


test("server descriptions make otherwise generic tools discoverable without exposing excluded servers", () => {
  const generic = tool("query", "mcp:warehouse");
  generic.discovery!.description = "Inventory and shipment tracking";
  const specific = tool("shipment_status", "mcp:shipping");
  const excluded = tool("secret", "mcp:private");
  excluded.discovery!.description = "Private shipment records";
  let admitted = [generic, specific, excluded];
  const discovery = createPiToolDiscovery({ tools: () => admitted, isCallable: (candidate) => candidate !== excluded });
  assert.deepEqual(names(discovery.searchTools("shipment")), ["shipment_status", "query"]);
  assert.deepEqual(names(discovery.searchTools("inventory")), ["query"]);
  assert.deepEqual(names(discovery.searchTools("inventory", { namespace: "mcp:shipping" })), []);
  admitted = [specific, excluded];
  assert.deepEqual(names(discovery.searchTools("inventory")), []);
});
