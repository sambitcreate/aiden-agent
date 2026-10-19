import assert from "node:assert/strict";
import test from "node:test";
import { Type, type JsonObject } from "@earendil-works/pi-ai";
import { validateMcpServerMetadata } from "../../renderer/shared/mcp-oauth-config.js";
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

test("namespace output is bounded and oversized inventories degrade to a marked, capped search", () => {
  const tools = Array.from({ length: 150 }, (_, index) => ({ ...tool(`tool_${index}`, "mcp:one"), description: "x".repeat(1024) }));
  const discovery = createPiToolDiscovery({ tools: () => tools, isCallable: () => true });
  const result = discovery.describeNamespace("mcp:one");
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  const reported: number[] = [];
  const excessive = createPiToolDiscovery({
    tools: () => Array.from({ length: 600 }, (_, i) => tool(`tool_${i}`)),
    isCallable: () => true,
    onInventoryTruncated: (total) => reported.push(total),
  });
  const capped = excessive.searchTools("tool_5");
  assert.equal(capped.inventoryTruncated, undefined);
  assert.equal(names(capped)[0], "tool_5");
  // Later services remain searchable before schema/output bounds.
  assert.deepEqual(names(excessive.searchTools("tool_599")), ["tool_599"]);
  assert.deepEqual(names(excessive.searchTools("tool_511")), ["tool_511"]);
  assert.deepEqual(reported, []);
  assert.equal(createPiToolDiscovery({ tools: () => [tool("one")], isCallable: () => true }).searchTools("").inventoryTruncated, undefined);
});

test("the inventory limit counts callable tools while excluded wrappers stay undiscoverable", () => {
  const callable = Array.from({ length: 512 }, (_, index) => tool(`tool_${index}`, "mcp:one"));
  const wrapper = tool("codemode");
  const excluded = tool("excluded", "mcp:private");
  let admitted = [...callable, wrapper, excluded, tool("tool_search")];
  const discovery = createPiToolDiscovery({
    tools: () => admitted,
    isCallable: (candidate) => candidate !== wrapper && candidate !== excluded,
    onInventoryTruncated: () => {},
  });
  assert.deepEqual(names(discovery.searchTools("tool_511")), ["tool_511"]);
  assert.equal(discovery.searchTools("tool_511").inventoryTruncated, undefined);
  assert.deepEqual(names(discovery.searchTools("codemode")), []);
  assert.deepEqual(names(discovery.searchTools("tool_search")), []);
  assert.throws(() => discovery.describeNamespace("mcp:private"), /Unknown or unavailable/);
  admitted = [...admitted, tool("overflow", "mcp:one")];
  const overflowing = discovery.searchTools("tool_511");
  assert.equal(overflowing.inventoryTruncated, undefined);
  assert.deepEqual(names(overflowing), ["tool_511"]);
  assert.deepEqual(names(discovery.searchTools("overflow")), ["overflow"]);
  admitted = admitted.filter((candidate) => candidate.name !== "overflow" && candidate.name !== "tool_511");
  assert.deepEqual(names(discovery.searchTools("tool_511")), []);
  assert.deepEqual(names(discovery.searchTools("tool_510")), ["tool_510"]);
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


test("saved multibyte descriptions remain discoverable alongside independent tools", async () => {
  const description = "雪".repeat(1024);
  validateMcpServerMetadata({ description });
  const localized = tool("localized", "mcp:localized");
  localized.discovery!.description = description;
  const discovery = createPiToolDiscovery({ tools: () => [localized, tool("independent")], isCallable: () => true });
  assert.deepEqual(names(discovery.searchTools("雪")), ["localized"]);
  assert.deepEqual(names(discovery.searchTools("independent")), ["independent"]);
  assert.equal(discovery.describeNamespace("mcp:localized").description, description);
  const result = await discovery.toolSearch.execute("search", { query: "" });
  assert.deepEqual(names(result.structuredContent as JsonObject), ["independent", "localized"]);
  assert.ok(Buffer.byteLength(JSON.stringify(discovery.describeNamespace("mcp:localized"))) <= 32768);
  localized.discovery!.description += "雪";
  assert.throws(() => discovery.searchTools(""), /1,024 characters/);
});

test("tool_search waits for servers still discovering and stops waiting when cancelled", async () => {
  const inventory = [tool("read_file")];
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = () => { inventory.push(tool("docs_search", "mcp:docs")); resolve(); }; });
  const discovery = createPiToolDiscovery({
    tools: () => inventory,
    isCallable: () => true,
    settled: (signal) => new Promise<void>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      void arrived.then(resolve);
    }),
  });
  const cancelled = new AbortController();
  const abandoned = discovery.toolSearch.execute("first", { query: "docs" }, cancelled.signal);
  cancelled.abort(new Error("turn stopped"));
  await assert.rejects(abandoned, /turn stopped/u);

  const searching = discovery.toolSearch.execute("second", { query: "docs" });
  setTimeout(arrive, 10);
  assert.deepEqual(names((await searching).structuredContent as JsonObject), ["docs_search"]);
});

function mcpTool(name: string, description: string, server: { namespace: string; label: string; alias: string; description?: string }): PiDiscoverableTool {
  return { ...tool(name), description, discovery: Object.freeze({ ...server }) };
}

const linearServer = { namespace: "mcp:aaaaaaaaaaaaaaaaaaaaaaaa", label: "Linear", alias: "linear", description: "Issue tracking for product teams" };
const githubServer = { namespace: "mcp:bbbbbbbbbbbbbbbbbbbbbbbb", label: "GitHub Work", alias: "github_work" };

test("natural-language queries rank by any matching word instead of requiring all of them", () => {
  const inventory = [
    mcpTool("linear__create_issue", "Create an issue in a Linear team", linearServer),
    mcpTool("linear__list_projects", "List projects", linearServer),
    mcpTool("github_work__createPullRequest", "Open a pull request", githubServer),
    mcpTool("github_work__create_issue", "Create a GitHub issue", githubServer),
    tool("read_file"),
  ];
  const discovery = createPiToolDiscovery({ tools: () => inventory, isCallable: () => true });
  const ranked = names(discovery.searchTools("create a new issue in linear"));
  assert.equal(ranked[0], "linear__create_issue");
  assert.ok(ranked.includes("github_work__create_issue"));
  assert.ok(!ranked.includes("read_file"));
  // camelCase names split into words; plurals and -ing forms stem to the same word.
  assert.equal(names(discovery.searchTools("pull requests"))[0], "github_work__createPullRequest");
  assert.deepEqual(names(discovery.searchTools("creating issues")).slice(0, 2).sort(), ["github_work__create_issue", "linear__create_issue"]);
  // A name match outranks the same word in a description.
  assert.deepEqual(names(discovery.searchTools("projects")), ["linear__list_projects", "read_file"]);
  // Only stop words: list everything instead of matching nothing.
  assert.equal(names(discovery.searchTools("the", { limit: 20 })).length, inventory.length);
  assert.deepEqual(names(discovery.searchTools("zebra")), []);
});

test("namespaces accept the service name and tool-name prefix as case- and separator-insensitive aliases", () => {
  const inventory = [
    mcpTool("linear__create_issue", "Create an issue", linearServer),
    mcpTool("github_work__create_issue", "Create an issue", githubServer),
  ];
  const discovery = createPiToolDiscovery({ tools: () => inventory, isCallable: () => true });
  for (const alias of ["github_work", "GitHub Work", "github-work", "GITHUB_WORK", githubServer.namespace]) {
    assert.deepEqual(names(discovery.searchTools("issue", { namespace: alias })), ["github_work__create_issue"], alias);
    assert.equal(discovery.describeNamespace(alias).namespace, githubServer.namespace, alias);
  }
  assert.equal(discovery.describeNamespace("linear").alias, "linear");
  assert.deepEqual(names(discovery.searchTools("issue", { namespace: "gitlab" })), []);
  assert.throws(() => discovery.describeNamespace("gitlab"), /Unknown or unavailable/u);
  // Two services answering to one alias fail rather than guess.
  const twin = mcpTool("github_work_2__x", "x", { ...githubServer, namespace: "mcp:cccccccccccccccccccccccc", alias: "github_work_2" });
  const ambiguous = createPiToolDiscovery({ tools: () => [...inventory, twin], isCallable: () => true });
  assert.throws(() => ambiguous.describeNamespace("GitHub Work"), /matches several services/u);
  assert.equal(ambiguous.describeNamespace("github_work_2").namespace, "mcp:cccccccccccccccccccccccc");
});

test("large admitted inventories support late namespace search and deterministic paging", () => {
  for (const count of [64, 512, 1536]) {
    const tools = Array.from({ length: count }, (_, i) => tool(`item_${String(i).padStart(4, "0")}`, i < count - 1 ? "mcp:early" : "mcp:late"));
    const discovery = createPiToolDiscovery({ tools: () => tools, isCallable: () => true });
    assert.deepEqual(names(discovery.searchTools(`item_${String(count - 1).padStart(4, "0")}`, { limit: 1 })), [tools[count - 1].name]);
    assert.deepEqual(names(discovery.describeNamespace("mcp:late")), [tools[count - 1].name]);
    const first = discovery.searchTools("", { namespace: "mcp:early", limit: 2 });
    const second = discovery.searchTools("", { namespace: "mcp:early", limit: 2, offset: first.nextOffset });
    assert.deepEqual(names(first), ["item_0000", "item_0001"]);
    assert.deepEqual(names(second), ["item_0002", "item_0003"]);
  }
});

test("schema byte paging never consumes a valid record from the next page", () => {
  const tools = ["a", "b", "c"].map((name) => ({ ...tool(name), parameters: Type.Object({ value: Type.String({ description: "x".repeat(12000) }) }) }));
  const discovery = createPiToolDiscovery({ tools: () => tools, isCallable: () => true });
  const first = discovery.searchTools("", { limit: 20 });
  assert.deepEqual(names(first), ["a", "b"]);
  const second = discovery.searchTools("", { limit: 20, offset: first.nextOffset });
  assert.deepEqual(names(second), ["c"]);
});

test("truncated global search exposes a namespace directory and bounded late lookup", () => {
  const tools = Array.from({ length: 4096 }, (_, i) => tool(`early_${i}`, "mcp:early"));
  tools.push(tool("late_unique", "mcp:late"));
  const discovery = createPiToolDiscovery({ tools: () => tools, isCallable: () => true, onInventoryTruncated: () => {} });
  assert.equal(discovery.searchTools("late_unique").inventoryTruncated, true);
  const directory = discovery.searchTools("", { listNamespaces: true, limit: 1 });
  assert.deepEqual(directory.namespaces, [{ namespace: "mcp:early", label: "Server mcp:early" }]);
  const next = discovery.searchTools("", { listNamespaces: true, limit: 1, offset: directory.nextOffset });
  assert.deepEqual(next.namespaces, [{ namespace: "mcp:late", label: "Server mcp:late" }]);
  assert.deepEqual(names(discovery.searchTools("late_unique", { namespace: "mcp:late" })), ["late_unique"]);
});

test("namespace directory cursors can traverse beyond the ranked search cap", () => {
  const tools = Array.from({ length: 4102 }, (_, i) => tool(`t${i}`, `mcp:n${String(i).padStart(5, "0")}`));
  const discovery = createPiToolDiscovery({ tools: () => tools, isCallable: () => true, onInventoryTruncated: () => {} });
  const page = discovery.searchTools("", { listNamespaces: true, offset: 4080, limit: 20 });
  const next = discovery.searchTools("", { listNamespaces: true, offset: page.nextOffset });
  assert.equal((next.namespaces as JsonObject[]).length, 2);
});

test("truncated search reserves envelope bytes for navigation and cursor", () => {
  const tools = Array.from({ length: 4097 }, (_, i) => ({ ...tool(`t${i}`), parameters: i < 2 ? Type.Object({}, { description: "x".repeat(16240) }) : null as never }));
  const discovery = createPiToolDiscovery({ tools: () => tools, isCallable: () => true, onInventoryTruncated: () => {} });
  const result = discovery.searchTools("", { limit: 20 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  assert.equal(result.inventoryTruncated, true);
});
