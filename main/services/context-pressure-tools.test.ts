import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ambientRuntimeToolEstimate, MAX_AMBIENT_MCP_TOOLS } from "./context-pressure-tools.js";
import { projectChatContextPressure } from "./generation-context.js";
import { McpBuiltToolsMemo } from "./mcp-tool-discovery-core.js";

const base: AgentTool = { name: "read_file", label: "Read", description: "Read a file.", parameters: Type.Object({ path: Type.String() }), execute: async () => ({ content: [], details: null }) };
const mcp = (index: number): AgentTool => ({
  ...base, name: `mcp_tool_${index}`, label: `Server/tool ${index}`, description: `Remote tool ${index} ${"d".repeat(400)}`,
  parameters: Type.Object({ query: Type.String({ description: "q".repeat(200) }) }),
});
const staticTokens = (tools: readonly AgentTool[]) =>
  projectChatContextPressure([], { contextWindow: 200_000, systemPrompt: "prompt", tools }).staticTokens;

test("the passive context estimate counts the codemode lane in workspace turns and declared MCP tools elsewhere", () => {
  const remote = Array.from({ length: 20 }, (_, index) => mcp(index));
  const without = staticTokens([base]);
  const codemode = ambientRuntimeToolEstimate({ codemode: true, mcpTools: remote });
  assert.deepEqual(codemode.map((tool) => tool.name).sort(), ["codemode", "tool_search"]);
  assert.ok(staticTokens([base, ...codemode]) > without);
  // Codemode defers MCP tools, so they cost nothing up front there; direct turns pay for each.
  const direct = ambientRuntimeToolEstimate({ codemode: false, mcpTools: remote });
  assert.ok(staticTokens([base, ...direct]) - without > 20 * 100);
});

test("declared MCP tools in the estimate are capped", () => {
  const many = Array.from({ length: MAX_AMBIENT_MCP_TOOLS + 50 }, (_, index) => mcp(index));
  assert.equal(ambientRuntimeToolEstimate({ codemode: false, mcpTools: many }).length, MAX_AMBIENT_MCP_TOOLS);
});

test("peeking built MCP tools never returns tools whose lease is no longer current", () => {
  const memo = new McpBuiltToolsMemo<{ tools: AgentTool[] }>();
  let current = true;
  memo.set("server", ["client"], () => current, { tools: [mcp(1)] });
  assert.deepEqual(memo.peek("server")?.tools.map((tool) => tool.name), ["mcp_tool_1"]);
  assert.equal(memo.peek("other"), undefined);
  current = false;
  assert.equal(memo.peek("server"), undefined);
});
