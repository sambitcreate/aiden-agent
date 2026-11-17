import assert from "node:assert/strict";
import test from "node:test";
import { composioServiceCallRequiresForeground, composioServiceStatusTools, composioServiceToolDescriptor, createComposioServiceAgentTool, isComposioServiceServer, projectComposioServiceInventory } from "./composio-service-tool.js";
import { getMcpPreset, serverFromPreset } from "./mcp-presets.js";
import { mcpAgentToolDescriptor } from "./mcp-agent-tool-descriptor.js";
import { mcpAgentToolIdentity } from "./mcp-tool-identity.js";
import { botMcpLiveToolGrantFacts, botToolCapabilityAllowed } from "./bot-tool-authority.js";
import { createMcpToolCallGuard } from "./mcp-tool-inventory.js";
import type { SubagentMcpRemoteTool } from "./subagents/subagent-mcp-read.js";
import type { BotRuntimeEffectiveAuthority } from "./bot-runtime-authority.js";

const server = serverFromPreset(getMcpPreset("composio")!);
const operation = (name: string, field = "query"): SubagentMcpRemoteTool => ({ name,
  inputSchema: { type: "object", properties: { [field]: { type: "string" } }, required: [field], additionalProperties: false },
  outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: true },
});
function fixture() {
  let current: SubagentMcpRemoteTool[] = [operation("COMPOSIO_SEARCH_TOOLS")];
  let valid = true;
  const calls: string[] = [];
  const tool = createComposioServiceAgentTool({ server, inspect: async () => {
    if (!valid) throw new Error("Connection revoked.");
    const tools = structuredClone(current);
    const guard = createMcpToolCallGuard(tools, () => { if (!valid) throw new Error("Connection revoked."); });
    return { tools, call: async (name, args) => {
      guard.assertCallable(name); calls.push(name);
      const result = { content: [], structuredContent: { answer: String(Object.values(args)[0]) } };
      guard.validateResult(name, result); return result;
    } };
  } });
  return { tool, calls, enable: (tools: SubagentMcpRemoteTool[]) => { current = tools; }, revoke: () => { valid = false; } };
}

test("one stable model/catalog/Settings identity covers the trusted Composio service", () => {
  const raw = Array.from({ length: 12 }, (_, i) => operation(`COMPOSIO_OPERATION_${i}`));
  const projected = projectComposioServiceInventory(server, raw);
  assert.equal(projected.length, 1); assert.equal(projected[0].name, "composio");
  assert.deepEqual(composioServiceStatusTools(server, raw.map((tool) => tool.name)), ["composio"]);
  const f = fixture(); assert.equal(f.tool.name, "composio");
  const renamed = createComposioServiceAgentTool({ server: { ...server, name: "My enabled apps" }, inspect: async () => ({ tools: raw, call: async () => ({}) }) });
  assert.equal(renamed.name, "composio", "renaming the connection cannot rename its stable model tool");
  assert.deepEqual(mcpAgentToolIdentity(f.tool), { serverId: "preset-composio", toolName: "composio" });
  assert.deepEqual(mcpAgentToolDescriptor(f.tool), projected[0]);
  assert.equal(botMcpLiveToolGrantFacts(projected[0])?.effect, "mutating");
  assert.deepEqual(botMcpLiveToolGrantFacts(projectComposioServiceInventory(server, [operation("COMPOSIO_NEW_OPERATION", "newField")])[0]), botMcpLiveToolGrantFacts(projected[0]), "vendor inventory edits do not change this service allowance");
});

test("custom endpoints and auth/header overrides never acquire the trusted service identity", () => {
  for (const changed of [{ ...server, id: "custom" }, { ...server, presetId: undefined }, { ...server, url: "https://evil.test/mcp" }, { ...server, url: `${server.url}/session/other` }, { ...server, headers: { authorization: "synthetic" } }, { ...server, oauth: true }]) {
    assert.equal(isComposioServiceServer(changed), false);
    assert.equal(projectComposioServiceInventory(changed, [operation("raw")])[0].name, "raw");
  }
  assert.equal(isComposioServiceServer({ ...server, headers: { "x-consumer-api-key": "synthetic-consumer-only" } }), true);
});

test("describe and dispatch follow current enabled operations without changing the one tool", async () => {
  const f = fixture();
  const described = await f.tool.execute("d", { action: "describe" });
  assert.match(JSON.stringify(described), /COMPOSIO_SEARCH_TOOLS/u);
  assert.equal(f.calls.length, 0, "describing metadata never executes an app operation");
  assert.match(JSON.stringify(await f.tool.execute("a", { action: "call", tool: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "mail" } })), /mail/u);
  f.enable([operation("COMPOSIO_GET_TOOL_SCHEMAS", "slug")]);
  await assert.rejects(f.tool.execute("old", { action: "call", tool: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "mail" } }), /no longer enabled/u);
  assert.match(JSON.stringify(await f.tool.execute("new", { action: "call", tool: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { slug: "calendar" } })), /calendar/u);
  assert.deepEqual(f.calls, ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);
});

test("current input and output contracts refuse bad data before any unvalidated result escapes", async () => {
  const f = fixture();
  f.enable([operation("COMPOSIO_SEARCH_TOOLS", "use_case")]);
  await assert.rejects(f.tool.execute("stale", { action: "call", tool: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "old shape" } }), /current input schema/u);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.tool.execute("array", { action: "call", tool: "COMPOSIO_SEARCH_TOOLS", arguments: [] }), /arguments/u);
  const outputTool = createComposioServiceAgentTool({ server, inspect: async () => {
    const tools = [operation("COMPOSIO_SEARCH_TOOLS")]; const guard = createMcpToolCallGuard(tools);
    return { tools, call: async (name) => { const bad = { content: [], structuredContent: { hidden: "not the advertised answer" } }; guard.validateResult(name, bad); return bad; } };
  } });
  await assert.rejects(outputTool.execute("bad", { action: "call", tool: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "valid" } }), /does not match/u);
});

test("a revoked connection and cancellation stop a previously built facade", async () => {
  const f = fixture(); f.revoke();
  await assert.rejects(f.tool.execute("revoked", { action: "call", tool: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "mail" } }), /revoked/u);
  assert.equal(f.calls.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tool.execute("aborted", { action: "describe" }, controller.signal));
  assert.equal(f.calls.length, 0);
});

test("old partial Custom grants cannot become a broad Composio service grant", () => {
  const raw = botMcpLiveToolGrantFacts(operation("COMPOSIO_SEARCH_TOOLS"))!;
  const service = botMcpLiveToolGrantFacts(composioServiceToolDescriptor())!;
  const authority = { accessMode: "custom", connections: [{ sourceId: server.id, connectionFingerprint: "connection", exactFingerprint: "exact", tools: [raw] }] } as unknown as BotRuntimeEffectiveAuthority;
  const capability = { kind: "mcp" as const, connectionSourceId: server.id, connectionFingerprint: "connection", connectionExactFingerprint: "exact", ...service };
  assert.equal(botToolCapabilityAllowed(authority, capability), false);
  const explicitlyAllowed = { ...authority, connections: [{ ...authority.connections[0], tools: [service] }] };
  assert.equal(botToolCapabilityAllowed(explicitlyAllowed, capability), true, "the person's new single allowance admits the service");
});

test("legacy hidden operations remain blocked until an explicit service allowance", async () => {
  const restricted = { ...server, hiddenTools: ["COMPOSIO_MULTI_EXECUTE_TOOL"] };
  assert.deepEqual(projectComposioServiceInventory(restricted, [operation("COMPOSIO_SEARCH_TOOLS")]), []);
  assert.deepEqual(composioServiceStatusTools(restricted, ["COMPOSIO_SEARCH_TOOLS"]), ["composio"], "Settings offers one re-allow switch");
  const blocked = createComposioServiceAgentTool({ server: restricted, inspect: async () => ({ tools: [operation("COMPOSIO_SEARCH_TOOLS")], call: async () => { throw new Error("Must not run."); } }) });
  await assert.rejects(blocked.execute("blocked", { action: "describe" }), /Allow Composio as one service/u);
  assert.equal(projectComposioServiceInventory({ ...restricted, hiddenTools: [] }, [operation("COMPOSIO_SEARCH_TOOLS")]).length, 1);
});

test("ordinary MCP inventories keep their individual operations", () => {
  const generic = { ...server, id: "other", presetId: undefined, name: "Other", url: "https://other.test/mcp" };
  const raw = [operation("read"), operation("write")];
  assert.equal(projectComposioServiceInventory(generic, raw), raw);
  assert.deepEqual(composioServiceStatusTools(generic, raw.map((tool) => tool.name)), ["read", "write"]);
  assert.equal(composioServiceCallRequiresForeground({ action: "describe" }), false);
  assert.equal(composioServiceCallRequiresForeground({ action: "call", tool: "COMPOSIO_MANAGE_CONNECTIONS", arguments: {} }), true);
});
