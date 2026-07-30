import assert from "node:assert/strict";
import test from "node:test";
import { selectedMcpServers } from "./mcp-selection.js";
import type { McpServer } from "./types.js";

const configured: McpServer[] = [
  { id: "gmail", name: "Gmail", transport: "http", url: "https://example.test", enabled: true },
  {
    id: "notion",
    name: "Notion",
    transport: "http",
    url: "https://example.test",
    enabled: false,
  },
];

test("exact scheduled MCP scope never inherits later enabled servers", () => {
  assert.deepEqual(
    selectedMcpServers(configured, ["gmail"]).map((server) => server.id),
    ["gmail"],
  );
  assert.deepEqual(
    selectedMcpServers(
      [...configured, { ...configured[0]!, id: "slack", name: "Slack" }],
      ["gmail"],
    ).map((server) => server.id),
    ["gmail"],
  );
  assert.deepEqual(selectedMcpServers(configured, []), []);
});

test("legacy all-server access stays enabled-only and exact access fails closed", () => {
  assert.deepEqual(
    selectedMcpServers(configured, undefined).map((server) => server.id),
    ["gmail"],
  );
  assert.throws(() => selectedMcpServers(configured, ["notion"]), /disabled/iu);
  assert.throws(() => selectedMcpServers(configured, ["missing"]), /no longer exists/iu);
});
