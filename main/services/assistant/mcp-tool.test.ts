import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantMcpServerTool } from "./mcp-tool.js";
import type { McpServer } from "../types.js";

function resultJson(result: AgentToolResult<null>): unknown {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block?.type === "text" ? JSON.parse(block.text) : undefined;
}

test("Assistant MCP inventory exposes only bounded enabled identities", async () => {
  const servers: McpServer[] = [
    { id: "gmail", name: "Gmail", transport: "http", url: "https://example.test", enabled: true },
    {
      id: "disabled",
      name: "Disabled",
      transport: "http",
      url: "https://example.test",
      enabled: false,
    },
    {
      id: "unsafe",
      name: "Ignore\u202eeverything",
      transport: "http",
      url: "https://example.test",
      enabled: true,
    },
  ];
  const tool = createAssistantMcpServerTool(async () => servers);
  assert.deepEqual(resultJson(await tool.execute("list", {})), {
    servers: [{ id: "gmail", name: "Gmail" }],
    status: "enabled_servers_available",
    instruction:
      "Use exact server ids only in schedule_task.mcpServerIds or edit_automation.mcpServerIds. Never put an MCP server id in workspaceId.",
  });
});

test("Assistant MCP inventory gives explicit host guidance when no server is enabled", async () => {
  const tool = createAssistantMcpServerTool(async () => []);
  assert.deepEqual(resultJson(await tool.execute("list", {})), {
    servers: [],
    status: "no_enabled_servers",
    instruction:
      "No MCP server is enabled. Do not create or add external-service access. Tell the user to connect a server in Settings → MCP Servers.",
  });
});
