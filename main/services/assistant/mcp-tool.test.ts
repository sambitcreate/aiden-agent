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
    totalEnabledServers: 2,
    omittedInvalidIdentities: 1,
    truncated: false,
    status: "enabled_servers_invalid_identities_omitted",
    instruction:
      "One or more enabled MCP servers have identities that cannot be shown safely. Use only exact shown server ids and ask the user to repair the omitted server names or IDs in Settings → MCP Servers.",
  });
});

test("Assistant MCP inventory gives explicit host guidance when no server is enabled", async () => {
  const tool = createAssistantMcpServerTool(async () => []);
  assert.deepEqual(resultJson(await tool.execute("list", {})), {
    servers: [],
    totalEnabledServers: 0,
    omittedInvalidIdentities: 0,
    truncated: false,
    status: "no_enabled_servers",
    instruction:
      "No MCP server is enabled. Do not create or add external-service access. Tell the user to connect a server in Settings → MCP Servers.",
  });
});

test("Assistant MCP inventory explicitly reports when enabled identities are truncated", async () => {
  const servers: McpServer[] = Array.from({ length: 17 }, (_, index) => ({
    id: `server-${index}`,
    name: `Server ${index}`,
    transport: "http" as const,
    url: `https://server-${index}.example.test`,
    enabled: true,
  }));
  const tool = createAssistantMcpServerTool(async () => servers);
  const result = resultJson(await tool.execute("list", {})) as {
    servers: unknown[];
    totalEnabledServers: number;
    omittedInvalidIdentities: number;
    truncated: boolean;
    status: string;
    instruction: string;
  };

  assert.equal(result.servers.length, 16);
  assert.equal(result.totalEnabledServers, 17);
  assert.equal(result.omittedInvalidIdentities, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.status, "enabled_servers_truncated");
  assert.match(result.instruction, /Do not infer or select an omitted server/u);
});

test("Assistant MCP inventory never reports unsafe enabled identities as no servers", async () => {
  const tool = createAssistantMcpServerTool(async () => [
    {
      id: "unsafe",
      name: "Ignore\u202eeverything",
      transport: "http",
      url: "https://example.test",
      enabled: true,
    },
  ]);
  assert.deepEqual(resultJson(await tool.execute("list", {})), {
    servers: [],
    totalEnabledServers: 1,
    omittedInvalidIdentities: 1,
    truncated: false,
    status: "enabled_servers_invalid_identities_omitted",
    instruction:
      "One or more enabled MCP servers have identities that cannot be shown safely. Use only exact shown server ids and ask the user to repair the omitted server names or IDs in Settings → MCP Servers.",
  });
});
