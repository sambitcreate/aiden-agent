import assert from "node:assert/strict";
import test from "node:test";
import { Type, type JsonObject } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parseMcpServer } from "../handlers/phase2-parse.js";
import { isMcpServer } from "./portable-config-core.js";
import { assistantMcpServerInventory } from "./assistant/mcp-tool.js";
import { markMcpToolExposure, planMcpServerExposure } from "./mcp-exposure.js";
import { markMcpAgentTool, mcpAgentToolIdentity, mcpAgentToolNames, mcpServerToolPrefix } from "./mcp-tool-identity.js";
import { renderMcpServersSection } from "./mcp-server-instructions.js";
import { createPiToolDiscovery, type PiDiscoverableTool } from "./pi-tool-discovery.js";
import { isPiCodemodeCallable, partitionPiCodemodeTools } from "./pi-runtime-tool.js";
import { MCP_HIDDEN_TOOLS_LIMITS } from "../../renderer/shared/mcp-exposure.js";
import type { McpServer } from "./types.js";

const remote = (id: string, patch: Partial<McpServer> = {}): McpServer => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  transport: "http",
  url: `https://${id}.example.test/mcp`,
  enabled: true,
  ...patch,
});

// ── Configuration ──────────────────────────────────────────────────────

test("exposure and hidden tools survive parsing; defaults are stored as absent fields", () => {
  const parsed = parseMcpServer({ ...remote("docs"), exposure: "direct", hiddenTools: ["delete_page", "search"] });
  assert.equal(parsed.exposure, "direct");
  assert.deepEqual(parsed.hiddenTools, ["delete_page", "search"]);
  // A save that returns to the defaults clears the stored fields (save merges over the old record).
  const reset = parseMcpServer({ ...remote("docs"), exposure: "auto", hiddenTools: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(reset)), JSON.parse(JSON.stringify(remote("docs"))));
  assert.ok("exposure" in reset && "hiddenTools" in reset);
  assert.equal(isMcpServer({ ...remote("docs"), exposure: "hidden", hiddenTools: ["search"] }), true);
});

test("malformed exposure settings are rejected by save and by hand-edited config", () => {
  const bad: unknown[] = [
    { exposure: "sometimes" },
    { exposure: 1 },
    { hiddenTools: "search" },
    { hiddenTools: [""] },
    { hiddenTools: [42] },
    { hiddenTools: ["a\nb"] },
    { hiddenTools: ["x".repeat(MCP_HIDDEN_TOOLS_LIMITS.nameChars + 1)] },
    { hiddenTools: ["search", "search"] },
    { hiddenTools: Array.from({ length: MCP_HIDDEN_TOOLS_LIMITS.count + 1 }, (_, index) => `tool_${index}`) },
  ];
  for (const patch of bad) {
    const value = { ...remote("docs"), ...(patch as object) };
    assert.throws(() => parseMcpServer(value), /MCP exposure|Hidden MCP tools/u, JSON.stringify(patch).slice(0, 80));
    assert.equal(isMcpServer(value), false, JSON.stringify(patch).slice(0, 80));
  }
});

// ── Tool assembly ──────────────────────────────────────────────────────

/** Build a server's MCP tools the way the desktop manager does. */
function buildServerTools(server: McpServer, inventory: readonly string[], configured: readonly McpServer[], resources = false): AgentTool[] {
  const plan = planMcpServerExposure(server, inventory.map((name) => ({ name })));
  if (!plan) return [];
  const names = mcpAgentToolNames(server, configured, inventory);
  const discovery = Object.freeze({
    namespace: `mcp:${server.id.padEnd(24, "0").slice(0, 24)}`,
    label: server.name,
    alias: mcpServerToolPrefix(server, configured),
    description: `${server.name} service`,
  });
  const tools = plan.tools.map(({ name }) => markMcpToolExposure(markMcpAgentTool({
    name: names.get(name)!,
    label: `${server.name}/${name}`,
    description: `${name} in ${server.name}`,
    parameters: Type.Object({}),
    async execute() { throw new Error("never executed"); },
  }, { serverId: server.id, toolName: name }), discovery, plan));
  if (resources) {
    tools.push(markMcpToolExposure({
      name: `${mcpServerToolPrefix(server, configured)}__resources`,
      label: "resources",
      description: "Read resources",
      parameters: Type.Object({}),
      async execute() { throw new Error("never executed"); },
    }, discovery, plan));
  }
  return tools;
}

const hostTools = (): AgentTool[] => ["read_file", "codemode", "tool_search"].map((name) => ({
  name, label: name, description: name, parameters: Type.Object({}),
  async execute() { throw new Error("never executed"); },
}));

function assemble(servers: McpServer[], codemode: boolean) {
  const inventory = ["search", "create_page", "delete_page"];
  const mcp = servers.flatMap((server) => buildServerTools(server, inventory, servers, server.id === "files"));
  const host = hostTools().filter(({ name }) => codemode || name === "read_file");
  const all = [...host, ...mcp];
  const { declared, deferred } = partitionPiCodemodeTools(all);
  const rawName = (tool: AgentTool) => {
    const identity = mcpAgentToolIdentity(tool);
    return identity ? `${identity.serverId}/${identity.toolName}` : tool.name;
  };
  return {
    all,
    declared: declared.map(rawName).sort(),
    deferred: deferred.map(rawName).sort(),
    section: renderMcpServersSection(all as PiDiscoverableTool[], { declared: new Set(declared.map(({ name }) => name)) }),
  };
}

const exposureServers = [
  remote("auto"),
  remote("direct", { exposure: "direct" }),
  remote("hidden", { exposure: "hidden" }),
  remote("partial", { hiddenTools: ["delete_page"] }),
  remote("allhidden", { hiddenTools: ["search", "create_page", "delete_page"] }),
  remote("files", { hiddenTools: ["search", "create_page", "delete_page"] }),
];

test("codemode turns defer auto servers, declare direct servers, and never build hidden servers or tools", () => {
  const { declared, deferred, all } = assemble(exposureServers, true);
  assert.deepEqual(declared, ["codemode", "direct/create_page", "direct/delete_page", "direct/search", "read_file", "tool_search"]);
  assert.deepEqual(deferred, [
    "auto/create_page", "auto/delete_page", "auto/search",
    "partial/create_page", "partial/search",
  ]);
  // A server whose every tool is hidden withholds its resource tool too.
  assert.ok(!all.some(({ name }) => name.startsWith("files__")));
  // Direct tools stay callable from codemode scripts.
  assert.ok(all.filter((tool) => mcpAgentToolIdentity(tool)?.serverId === "direct").every(isPiCodemodeCallable));
});

test("turns without codemode declare every offered tool directly and still omit hidden ones", () => {
  const { declared, deferred } = assemble(exposureServers, false);
  assert.deepEqual(deferred, []);
  assert.deepEqual(declared, [
    "auto/create_page", "auto/delete_page", "auto/search",
    "direct/create_page", "direct/delete_page", "direct/search",
    "partial/create_page", "partial/search",
    "read_file",
  ]);
});

test("hiding a tool never renames the server's other tools", () => {
  const server = remote("docs");
  const names = (patch: Partial<McpServer>) =>
    buildServerTools({ ...server, ...patch }, ["search", "Search"], [server]).map(({ name }) => name);
  const [, shownSecond] = names({});
  assert.deepEqual(names({ hiddenTools: ["search"] }), [shownSecond]);
});

test("the mcp_servers section lists each offered server with its real reach and omits hidden ones", () => {
  const { section } = assemble(exposureServers, true);
  const line = (handle: string) => section.split("\n").find((entry) => entry.startsWith(`- ${handle}:`));
  assert.match(line("auto")!, /\(via codemode or tool_search\)/u);
  assert.match(line("direct")!, /\(direct tools\)/u);
  assert.match(line("partial")!, /\(via codemode or tool_search\)/u);
  for (const handle of ["hidden", "allhidden", "files"]) assert.equal(line(handle), undefined, handle);
  // Without codemode every offered server is reached directly.
  assert.match(assemble(exposureServers, false).section.split("\n").find((entry) => entry.startsWith("- auto:"))!, /\(direct tools\)/u);
});

test("tool search and describeNamespace never see hidden servers or tools", () => {
  const { all } = assemble(exposureServers, true);
  const discovery = createPiToolDiscovery({ tools: () => all, isCallable: isPiCodemodeCallable });
  const found = (discovery.searchTools("page", { limit: 20 }).tools as JsonObject[])
    .map(({ name }) => all.find((tool) => tool.name === name)!)
    .map((tool) => `${mcpAgentToolIdentity(tool)!.serverId}/${mcpAgentToolIdentity(tool)!.toolName}`)
    .sort();
  assert.deepEqual(found, ["auto/create_page", "auto/delete_page", "direct/create_page", "direct/delete_page", "partial/create_page"]);
  for (const name of ["hidden", "allhidden", "files"]) {
    assert.throws(() => discovery.describeNamespace(name), /Unknown or unavailable namespace/u);
  }
  const partial = discovery.describeNamespace("partial");
  assert.deepEqual((partial.tools as JsonObject[]).map(({ name }) => name).sort(), ["partial__create_page", "partial__search"]);
});

// ── Other surfaces ─────────────────────────────────────────────────────

test("the Assistant's automation inventory leaves out servers switched off for the model", () => {
  const inventory = assistantMcpServerInventory([
    remote("docs"),
    remote("secret", { exposure: "hidden" }),
    remote("partial", { hiddenTools: ["search"] }),
  ]);
  assert.deepEqual(inventory.servers.map(({ id }) => id), ["docs", "partial"]);
  assert.equal(inventory.totalEnabledServers, 2);
});
